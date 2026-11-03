import { CaptionAssembler, MessageRate } from './bridge';
import { CAPTION_LIMITS, bytes, trackKey, type CaptionGroup } from './contract';
import { groupCaptions } from './group';
import {
  CaptureStateSchema,
  CaptureErrorSchema,
  YOUTUBE_ORIGIN,
  watchVideoId,
  type CaptureState,
} from './player';
import { CaptionSessionSchema } from '../runtime/caption-protocol';
import type { CaptionSession } from '../background/caption-access';

export interface CaptionControllerPlatform {
  request(message: Record<string, unknown>): Promise<unknown>;
  alive(): boolean;
}
export type CaptionView = {
  enabled: boolean;
  capture?: CaptureState | undefined;
  error?: string | undefined;
  groups: readonly CaptionGroup[];
  session?: CaptionSession | undefined;
  processing: boolean;
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export class CaptionController {
  readonly documentNonce = crypto.randomUUID();
  private view: CaptionView = { enabled: false, groups: [], processing: false };
  private readonly subscribers = new Set<(view: CaptionView) => void>();
  private readonly rate = new MessageRate();
  private assembler: CaptionAssembler | undefined;
  private processing: AbortController | undefined;
  private epoch = 0;
  private disposed = false;
  private confirming: Promise<boolean> | undefined;
  private replayTimer: ReturnType<typeof setTimeout> | undefined;
  private received = false;
  private translationIntent = 0;
  private checking = false;
  private checkedAt = 0;
  private lastTick = Date.now();
  private video = watchVideoId(location.href);
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly platform: CaptionControllerPlatform) {
    window.addEventListener('message', this.receive);
    window.addEventListener('pagehide', this.pause);
    document.addEventListener('freeze', this.pause);
    window.addEventListener('pageshow', this.resume);
    document.addEventListener('resume', this.resume);
    document.addEventListener('visibilitychange', this.visibility);
    this.timer = setInterval(this.tick, 500);
    void this.confirm();
  }
  snapshot() {
    return this.view;
  }
  subscribe(listener: (view: CaptionView) => void) {
    this.subscribers.add(listener);
    listener(this.view);
    return () => {
      this.subscribers.delete(listener);
    };
  }
  private update(patch: Partial<CaptionView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.subscribers) listener(this.view);
  }
  private async request(type: string, payload: Record<string, unknown> = {}) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.platform.request({
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          documentNonce: this.documentNonce,
          type,
          ...payload,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('CAPTION_UNAVAILABLE')), 2500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private control(type: string, generation?: string) {
    window.postMessage(
      JSON.stringify({
        channel: 'sayvia.capture.control.v1',
        type,
        ...(generation ? { generation } : {}),
      }),
      YOUTUBE_ORIGIN,
    );
  }
  private invalidate() {
    this.epoch++;
    // A resumed lifecycle must not reuse an ensure from the paused epoch.
    this.confirming = undefined;
    this.translationIntent++;
    clearTimeout(this.replayTimer);
    this.received = false;
    this.assembler?.cancel();
    this.assembler = undefined;
    this.processing?.abort();
    this.processing = undefined;
    this.update({ groups: [], session: undefined, processing: false });
    void this.request('captions.revoke').catch(() => undefined);
  }
  pause = () => {
    this.invalidate();
    this.control('stop');
    this.update({ enabled: false, capture: undefined, error: 'CAPTION_PAUSED' });
  };
  private resume = () => {
    if (!this.disposed && !this.view.enabled && document.visibilityState !== 'hidden')
      void this.confirm();
  };
  private visibility = () => {
    if (document.visibilityState !== 'hidden') this.resume();
  };
  async confirm(): Promise<boolean> {
    if (this.disposed || !this.platform.alive()) return false;
    if (this.confirming) return this.confirming;
    const epoch = this.epoch;
    const pending = (async () => {
      try {
        const reply = await this.request('captions.ensure');
        if (this.disposed || epoch !== this.epoch) return false;
        if (!record(reply) || reply.ok !== true || reply.enabled !== true) {
          this.pause();
          return false;
        }
        this.lastTick = Date.now();
        this.checkedAt = this.lastTick;
        this.update({ enabled: true, error: undefined });
        this.control('replay');
        return true;
      } catch {
        if (epoch === this.epoch) this.pause();
        return false;
      }
    })().finally(() => {
      if (this.confirming === pending) this.confirming = undefined;
    });
    this.confirming = pending;
    return pending;
  }
  async enableTranslation() {
    const intent = ++this.translationIntent;
    const capture = this.view.capture;
    if (
      !this.view.enabled ||
      capture?.reason !== 'ready' ||
      !capture.track ||
      !this.view.groups.length
    )
      throw new Error('CAPTION_NOT_READY');
    const epoch = this.epoch;
    const reply = await this.request('captions.grant', {
      track: capture.track,
      captureGeneration: capture.generation,
    });
    if (
      this.disposed ||
      epoch !== this.epoch ||
      intent !== this.translationIntent ||
      !this.view.enabled
    )
      throw new Error('CAPTION_NOT_READY');
    const session = CaptionSessionSchema.safeParse(
      record(reply) && reply.ok === true ? reply.session : undefined,
    );
    if (!session.success) throw new Error('CAPTION_NOT_AUTHORIZED');
    this.update({ session: session.data });
    return session.data;
  }
  disableTranslation() {
    this.translationIntent++;
    this.update({ session: undefined });
    return this.request('captions.revoke');
  }
  async refresh() {
    const video = watchVideoId(location.href);
    if (video && (await this.confirm()) && video === watchVideoId(location.href) && !this.disposed)
      location.reload();
  }
  private tick = () => {
    if (this.disposed) return;
    const now = Date.now();
    if (!this.platform.alive()) {
      this.dispose();
      return;
    }
    if (now - this.lastTick > 2500) {
      this.pause();
      this.lastTick = now;
      this.resume();
      return;
    }
    this.lastTick = now;
    const video = watchVideoId(location.href);
    if (video !== this.video) {
      this.video = video;
      this.invalidate();
      this.update({ capture: undefined, error: undefined });
      if (!this.view.enabled) this.resume();
    }
    if (!this.view.enabled) return;
    if (this.assembler?.expire()) {
      this.invalidate();
      this.update({ error: 'CAPTION_BRIDGE_INVALID' });
      return;
    }
    if (this.view.capture) this.control('heartbeat', this.view.capture.generation);
    if (now - this.checkedAt >= 5000 && !this.checking) {
      this.checking = true;
      const epoch = this.epoch;
      const checkedSession = this.view.session;
      this.checkedAt = now;
      void this.request('captions.check', this.view.session ? { session: this.view.session } : {})
        .then(
          (reply) => {
            if (epoch !== this.epoch || this.disposed) return;
            if (!record(reply) || reply.ok !== true || reply.enabled !== true) this.pause();
            else if (
              checkedSession &&
              this.view.session === checkedSession &&
              reply.authorized !== true
            )
              this.update({ session: undefined, error: 'CAPTION_SESSION_ENDED' });
          },
          () => {
            if (epoch === this.epoch) this.pause();
          },
        )
        .finally(() => {
          this.checking = false;
        });
    }
  };
  private receive = (event: MessageEvent) => {
    if (
      this.disposed ||
      !this.view.enabled ||
      event.source !== window ||
      event.origin !== YOUTUBE_ORIGIN ||
      typeof event.data !== 'string'
    )
      return;
    if (
      !event.data.startsWith('{"channel":"sayvia.capture.v1",') &&
      !event.data.startsWith('{"channel":"sayvia.captions.v1",')
    )
      return;
    if (
      !this.rate.take() ||
      event.data.length > CAPTION_LIMITS.messageBytes ||
      bytes(event.data) > CAPTION_LIMITS.messageBytes
    ) {
      this.invalidate();
      this.update({ error: 'CAPTION_BRIDGE_INVALID' });
      return;
    }
    if (event.data.startsWith('{"channel":"sayvia.capture.v1",')) {
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      const state = CaptureStateSchema.safeParse(raw);
      if (state.success) {
        const next = state.data;
        const video = watchVideoId(location.href);
        if (next.videoId !== (video ?? null) || (next.track && next.track.videoId !== next.videoId))
          return;
        if (next.reason === 'paused') {
          this.pause();
          return;
        }
        const previous = this.view.capture;
        if (previous && JSON.stringify(previous) === JSON.stringify(next)) return;
        this.invalidate();
        this.video = video;
        this.update({ capture: next, error: undefined });
        if (next.reason === 'ready' && next.track && !next.track.tlang) {
          try {
            trackKey(next.track);
            this.assembler = new CaptionAssembler({
              generation: next.generation,
              track: next.track,
            });
            // Give an already queued normal response time to arrive. Replaying
            // immediately here can duplicate the response currently being sent.
            this.replayTimer = setTimeout(() => {
              if (!this.received) this.control('replay', next.generation);
            }, 500);
          } catch {
            this.update({ error: 'CAPTION_BRIDGE_INVALID' });
          }
        }
        return;
      }
      const error = CaptureErrorSchema.safeParse(raw);
      if (error.success && error.data.generation === this.view.capture?.generation) {
        this.invalidate();
        this.update({ error: error.data.code });
      }
      return;
    }
    if (!this.assembler) return;
    const result = this.assembler.accept(event.data);
    if (result.status === 'pending' || result.status === 'complete') this.received = true;
    if (result.status === 'rejected') {
      this.invalidate();
      this.update({ error: result.error });
    }
    if (result.status !== 'complete') return;
    if (this.processing) {
      this.invalidate();
      this.update({ error: 'CAPTION_LIMIT' });
      return;
    }
    const capture = this.view.capture;
    if (!capture?.track) return;
    const epoch = this.epoch;
    const abort = new AbortController();
    this.processing = abort;
    // Replacing a response invalidates paid results before any new grouping starts.
    this.update({ groups: [], session: undefined, processing: true, error: undefined });
    void this.request('captions.revoke').catch(() => undefined);
    void groupCaptions(capture.track, result.cues, abort.signal)
      .then((groups) => {
        if (this.disposed || epoch !== this.epoch || abort.signal.aborted) return;
        const size = groups.reduce((sum, group) => sum + bytes(group.text), 0);
        if (size > CAPTION_LIMITS.cacheBytes) throw new Error('CAPTION_LIMIT');
        this.update({ groups, processing: false });
      })
      .catch(() => {
        if (epoch === this.epoch && !abort.signal.aborted)
          this.update({ error: 'INVALID_CAPTION_DATA', groups: [], processing: false });
      })
      .finally(() => {
        if (this.processing === abort) this.processing = undefined;
      });
  };
  dispose() {
    if (this.disposed) return;
    this.pause();
    this.disposed = true;
    clearInterval(this.timer);
    window.removeEventListener('message', this.receive);
    window.removeEventListener('pagehide', this.pause);
    document.removeEventListener('freeze', this.pause);
    window.removeEventListener('pageshow', this.resume);
    document.removeEventListener('resume', this.resume);
    document.removeEventListener('visibilitychange', this.visibility);
    this.subscribers.clear();
  }
}
