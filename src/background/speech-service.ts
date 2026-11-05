import { selectLocalVoice, type LocalVoice } from '../core/local-voice';
import {
  SpeechInputSchema,
  SpeechLeaseSchema,
  sameSpeechOwner,
  type SpeechInput,
  type SpeechLease,
  type SpeechOwner,
  type SpeechState,
  type SpeechTicket,
} from '../runtime/speech-protocol';

export const SPEECH_STORAGE_KEY = 'sayvia.speech';
export const SPEECH_ALARM_PREFIX = 'sayvia.speech.';
const TICKET_MS = 30_000;
const SPEECH_MS = 30_000;
type Entry = {
  ticket: SpeechTicket;
  owner: SpeechOwner;
  state: 'issued' | SpeechState;
  controller: AbortController;
};
export interface SpeechPlatform {
  read(): Promise<unknown>;
  save(lease: SpeechLease): Promise<void>;
  remove(): Promise<void>;
  voices(): Promise<LocalVoice[]>;
  speak(
    text: string,
    options: {
      voiceName: string;
      lang: string;
      rate: number;
      enqueue: false;
      onEvent(event: { type: string }): void;
    },
  ): Promise<void>;
  stop(): void;
  alarm(name: string, when: number): Promise<void>;
  clearAlarm(name: string): Promise<unknown>;
  permitted(owner: SpeechOwner): Promise<boolean>;
  notify?(owner: SpeechOwner, ticket: SpeechTicket, state: SpeechState): Promise<void>;
}
const alarmName = (lease: SpeechLease) =>
  `${SPEECH_ALARM_PREFIX}${lease.ticket.epoch}.${lease.ticket.speechId}`;
const sameTicket = (left: SpeechTicket, right: SpeechTicket) =>
  left.speechId === right.speechId &&
  left.epoch === right.epoch &&
  left.expiresAt === right.expiresAt;
const terminalEvents = new Set(['end', 'interrupted', 'cancelled', 'error']);
export class SpeechService {
  readonly epoch = crypto.randomUUID();
  readonly ready: Promise<void>;
  private entries = new Map<string, Entry>();
  private active: SpeechLease | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private generation = 0;
  constructor(private readonly platform: SpeechPlatform) {
    this.ready = this.initialize();
  }
  private async initialize() {
    const stored = await this.platform.read();
    if (stored === undefined) return;
    // Never replay a stored utterance; no text is persisted in the first place.
    this.platform.stop();
    const lease = SpeechLeaseSchema.safeParse(stored);
    if (lease.success) await this.platform.clearAlarm(alarmName(lease.data));
    await this.platform.remove();
  }
  private serial<T>(work: () => Promise<T>) {
    const next = this.queue.then(async () => {
      await this.ready;
      return work();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
  private prune() {
    for (const [id, entry] of this.entries)
      if (entry.ticket.expiresAt <= Date.now()) {
        if (this.active?.ticket.speechId === entry.ticket.speechId) continue;
        entry.controller.abort();
        this.entries.delete(id);
      }
  }
  async ticket(owner: SpeechOwner, clientSpeechId: string): Promise<SpeechTicket> {
    await this.ready;
    this.prune();
    const existing = this.entries.get(clientSpeechId);
    if (existing) {
      if (!sameSpeechOwner(existing.owner, owner)) throw new Error('FORBIDDEN');
      return { ...existing.ticket };
    }
    const nonActive = [...this.entries.values()].filter(
      (entry) => entry.ticket.speechId !== this.active?.ticket.speechId,
    ).length;
    // At most 256 non-active records plus one active lease. Completion can leave 257
    // tombstones briefly; new issuance stays blocked until expiry, never evicting a stop.
    if (nonActive >= 256) throw new Error('SPEECH_BUSY');
    const ticket = {
      speechId: crypto.randomUUID(),
      epoch: this.epoch,
      expiresAt: Date.now() + TICKET_MS,
    };
    this.entries.set(clientSpeechId, {
      owner: structuredClone(owner),
      ticket,
      state: 'issued',
      controller: new AbortController(),
    });
    return { ...ticket };
  }
  private entry(owner: SpeechOwner, ticket: SpeechTicket) {
    this.prune();
    const entry = [...this.entries.values()].find(
      (entry) => entry.ticket.speechId === ticket.speechId,
    );
    if (
      ticket.epoch !== this.epoch ||
      !entry ||
      !sameTicket(entry.ticket, ticket) ||
      !sameSpeechOwner(entry.owner, owner)
    )
      throw new Error('SPEECH_EXPIRED');
    return entry;
  }
  private current(owner: SpeechOwner, ticket: SpeechTicket) {
    return this.active &&
      sameSpeechOwner(this.active.owner, owner) &&
      sameTicket(this.active.ticket, ticket)
      ? this.active
      : undefined;
  }
  private notify(lease: Pick<SpeechLease, 'owner' | 'ticket'>, state: SpeechState) {
    return this.platform.notify?.(lease.owner, lease.ticket, state).catch(() => undefined);
  }
  private async release(lease: SpeechLease, state: SpeechState, stop = true) {
    if (this.active !== lease) return;
    this.active = undefined;
    const entry = [...this.entries.values()].find((entry) =>
      sameTicket(entry.ticket, lease.ticket),
    );
    if (entry) {
      entry.state = state;
      entry.controller.abort();
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (stop) this.platform.stop();
    try {
      await this.platform.clearAlarm(alarmName(lease));
    } finally {
      await this.platform.remove();
    }
    void this.notify(lease, state);
  }
  async start(owner: SpeechOwner, ticket: SpeechTicket, input: SpeechInput): Promise<SpeechState> {
    await this.ready;
    if (this.current(owner, ticket)) return 'speaking';
    const entry = this.entry(owner, ticket);
    if (entry.state !== 'issued') return entry.state;
    const parsed = SpeechInputSchema.parse(input);
    entry.state = 'starting';
    const generation = ++this.generation;
    const valid = () =>
      !entry.controller.signal.aborted &&
      entry.state === 'starting' &&
      generation === this.generation &&
      ticket.expiresAt > Date.now();
    return this.serial(async () => {
      try {
        if (!valid()) {
          entry.state = 'canceled';
          return 'canceled';
        }
        if (!(await this.platform.permitted(owner))) throw new Error('FORBIDDEN');
        let voice: ReturnType<typeof selectLocalVoice>;
        for (let attempt = 0; attempt < 10 && valid(); attempt++) {
          const began = Date.now();
          const voices = await this.boundedVoices(entry.controller.signal);
          if (!valid()) break;
          voice = selectLocalVoice(voices, parsed.language);
          if (voice) break;
          if (attempt < 9)
            await this.delay(Math.max(0, 300 - (Date.now() - began)), entry.controller.signal);
        }
        if (!valid()) {
          entry.state = 'canceled';
          return 'canceled';
        }
        if (!voice) {
          entry.state = 'unavailable';
          void this.notify(entry, 'unavailable');
          return 'unavailable';
        }
        if (!(await this.platform.permitted(owner))) throw new Error('FORBIDDEN');
        if (!valid()) {
          entry.state = 'canceled';
          return 'canceled';
        }
        if (this.active) await this.release(this.active, 'canceled');
        if (!valid()) {
          entry.state = 'canceled';
          return 'canceled';
        }
        const lease: SpeechLease = {
          owner: entry.owner,
          ticket: entry.ticket,
          deadline: Date.now() + SPEECH_MS,
        };
        await this.platform.save(lease);
        this.active = lease;
        await this.platform.alarm(alarmName(lease), lease.deadline);
        if (!valid()) {
          await this.release(lease, 'canceled');
          entry.state = 'canceled';
          return 'canceled';
        }
        this.timer = setTimeout(() => {
          void this.serial(() => this.release(lease, 'ended')).catch(() => undefined);
        }, SPEECH_MS);
        const onEvent = (event: { type: string }) => {
          if (!terminalEvents.has(event.type)) return;
          void this.serial(() =>
            this.release(
              lease,
              event.type === 'error' ? 'failed' : event.type === 'end' ? 'ended' : 'canceled',
              false,
            ),
          ).catch(() => undefined);
        };
        // The promise reports invocation errors, not completion of the utterance.
        void this.platform
          .speak(parsed.text, { ...voice, rate: parsed.rate, enqueue: false, onEvent })
          .catch(() => {
            void this.serial(() => this.release(lease, 'failed')).catch(() => undefined);
          });
        entry.state = 'speaking';
        void this.notify(lease, 'speaking');
        return 'speaking';
      } catch {
        entry.state = 'failed';
        const lease = this.current(owner, ticket);
        if (lease) await this.release(lease, 'failed').catch(() => undefined);
        void this.notify(entry, 'failed');
        return 'failed';
      }
    });
  }
  async stop(owner: SpeechOwner, ticket: SpeechTicket) {
    await this.ready;
    const lease = this.current(owner, ticket);
    if (!lease) {
      const entry = this.entry(owner, ticket);
      entry.state = 'canceled';
      entry.controller.abort();
    } else {
      // Also invalidate a start that persisted its lease but has not called speak yet.
      const entry = [...this.entries.values()].find(
        (entry) => entry.ticket.speechId === ticket.speechId,
      );
      if (entry) {
        entry.state = 'canceled';
        entry.controller.abort();
      }
    }
    return this.serial(async () => {
      if (lease) await this.release(lease, 'canceled');
      return 'canceled' as const;
    });
  }
  cancelWhere(predicate: (owner: SpeechOwner) => boolean) {
    for (const entry of this.entries.values())
      if (predicate(entry.owner)) {
        entry.state = 'canceled';
        entry.controller.abort();
      }
    const lease = this.active && predicate(this.active.owner) ? this.active : undefined;
    return this.serial(async () => {
      if (lease) await this.release(lease, 'canceled');
    });
  }
  onAlarm(name: string) {
    return this.serial(async () => {
      if (this.active && alarmName(this.active) === name) await this.release(this.active, 'ended');
    });
  }
  private boundedVoices(signal: AbortSignal): Promise<LocalVoice[]> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (voices: LocalVoice[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        resolve(voices);
      };
      const abort = () => finish([]);
      const timer = setTimeout(abort, 300);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else void this.platform.voices().then(finish, abort);
    });
  }
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
  }
}
