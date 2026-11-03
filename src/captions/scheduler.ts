import { z } from 'zod';
import { CAPTION_VERSION } from '../core/learning-processor';
import { CaptionInputSchema, LocaleSchema, type CaptionInput } from '../core/learning-contract';
import {
  CaptionProviderSchema,
  CaptionSessionSchema,
  type CaptionProvider,
} from '../runtime/caption-protocol';
import { LearningEventSchema } from '../runtime/public-events';
import { CAPTION_LIMITS, bytes, type CaptionGroup } from './contract';

const ScopeSchema = z
  .object({
    session: CaptionSessionSchema,
    provider: CaptionProviderSchema,
    documentNonce: z.uuid(),
    sourceLanguage: LocaleSchema,
    targetLanguage: LocaleSchema,
  })
  .strict();
export type SchedulerScope = z.infer<typeof ScopeSchema>;
export interface CaptionTransport {
  request(message: Record<string, unknown>): Promise<unknown>;
  now?(): number;
}
const StateSchema = z.object({
  clientTaskId: z.uuid(),
  taskId: z.uuid().optional(),
  documentNonce: z.uuid().optional(),
  provider: CaptionProviderSchema.optional(),
  state: z.enum([
    'running',
    'ready',
    'delivered',
    'canceled',
    'failed',
    'timedOut',
    'interrupted',
    'expired',
  ]),
  cancelPending: z.boolean().optional(),
  cancelReason: z.literal('explicit-preemption').optional(),
  error: z.string().max(48).optional(),
  canApply: z.literal(false),
});
type State = z.infer<typeof StateSchema>;
type Batch = {
  clientTaskId: string;
  input: CaptionInput;
  groups: readonly CaptionGroup[];
  taskId?: string;
  phase: 'new' | 'unknown' | 'running' | 'canceling';
  cancel?: 'seek' | 'error' | 'stop';
  admittedAt: number;
};
export type SchedulerView = {
  state: 'idle' | 'running' | 'waiting' | 'paused' | 'stopped';
  error?: string;
  inFlight: number;
  queued: number;
  translated: number;
  cacheBytes: number;
  needsRetry: boolean;
};
const sameProvider = (a: CaptionProvider, b: CaptionProvider) =>
  a.id === b.id && a.revision === b.revision && a.model === b.model;

// One instance owns one immutable document/session/source/configuration. It has
// no browser listeners or timers; the owning controller supplies its media clock.
export class CaptionScheduler {
  private readonly scope: SchedulerScope;
  private readonly groups: readonly CaptionGroup[];
  private readonly cache = new Map<string, string>();
  private readonly attempted = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private batch: Batch | undefined;
  private queued: CaptionGroup[][] = [];
  private state: SchedulerView['state'] = 'idle';
  private error: string | undefined;
  private enabled = false;
  private disposed = false;
  private busy = false;
  private retryRequested = false;
  private nextAt = 0;
  private failures = 0;
  private time = 0;
  private horizon = 30_000;
  private size: number;
  constructor(
    scope: SchedulerScope,
    groups: readonly CaptionGroup[],
    private readonly transport: CaptionTransport,
  ) {
    this.scope = ScopeSchema.parse(scope);
    if (!groups.length || groups.length > CAPTION_LIMITS.cues) throw new Error('CAPTION_LIMIT');
    const ids = new Set<string>();
    let size = 0;
    for (const group of groups) {
      if (
        ids.has(group.unitId) ||
        !Number.isSafeInteger(group.start) ||
        !Number.isSafeInteger(group.end) ||
        group.start < 0 ||
        group.end <= group.start
      )
        throw new Error('INVALID_CAPTION_DATA');
      ids.add(group.unitId);
      CaptionInputSchema.parse({
        ...this.identity(),
        batchId: crypto.randomUUID(),
        sourceLanguage: this.scope.sourceLanguage,
        targetLanguage: this.scope.targetLanguage,
        units: [{ unitId: group.unitId, revision: group.revision, text: group.text }],
      });
      size += bytes(group.text);
      if (size > CAPTION_LIMITS.cacheBytes) throw new Error('CAPTION_LIMIT');
    }
    this.size = size;
    this.groups = structuredClone([...groups]).sort(
      (a, b) => a.start - b.start || a.unitId.localeCompare(b.unitId),
    );
  }
  private now() {
    return this.transport.now?.() ?? Date.now();
  }
  private identity() {
    const { sessionId, generation, videoId, trackKey } = this.scope.session;
    return { sessionId, generation, videoId, trackKey };
  }
  snapshot(): SchedulerView {
    return {
      state: this.state,
      ...(this.error ? { error: this.error } : {}),
      inFlight: this.batch ? 1 : 0,
      queued: this.queued.length,
      translated: this.cache.size,
      cacheBytes: this.size,
      needsRetry: this.groups.some(
        (group) =>
          group.start <= this.time &&
          this.time < group.end &&
          this.attempted.has(group.unitId) &&
          !this.cache.has(group.unitId) &&
          !this.batch?.groups.some((held) => held.unitId === group.unitId),
      ),
    };
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish() {
    for (const listener of this.listeners) listener();
  }
  start() {
    if (this.disposed || this.state !== 'idle') return false;
    this.enabled = true;
    this.state = 'running';
    this.plan();
    this.drive();
    return true;
  }
  // User retry never bypasses an uncertain old attempt. First establish a
  // cancellation fence, then create new IDs for the explicitly requested retry.
  retry() {
    if (this.disposed) return false;
    this.retryRequested = true;
    this.failures = 0;
    this.nextAt = 0;
    if (this.batch) {
      this.batch.cancel = 'error';
      this.batch.phase = 'canceling';
    } else this.applyRetry();
    this.drive();
    return true;
  }
  private applyRetry() {
    this.retryRequested = false;
    this.attempted.clear();
    this.error = undefined;
    this.enabled = true;
    this.state = 'running';
    this.plan();
  }
  tick(timeMs: number, playbackRate = 1) {
    if (this.disposed) return;
    if (
      !Number.isFinite(timeMs) ||
      timeMs < 0 ||
      !Number.isFinite(playbackRate) ||
      playbackRate <= 0
    ) {
      this.pause('INVALID_MEDIA_CLOCK');
      return;
    }
    this.time = timeMs;
    this.horizon = 30_000 * Math.min(2, Math.max(1, playbackRate));
    if (
      this.enabled &&
      this.batch &&
      !this.batch.cancel &&
      !this.batch.groups.some((g) => this.needed(g))
    ) {
      if (this.batch.phase === 'new') this.batch = undefined;
      else {
        this.batch.cancel = 'seek';
        this.batch.phase = 'canceling';
      }
    }
    this.plan();
    this.drive();
  }
  visible(timeMs = this.time) {
    if (this.disposed || !this.enabled) return [];
    return this.groups
      .filter((g) => g.start <= timeMs && timeMs < g.end)
      .map((g) => ({ unitId: g.unitId, original: g.text, translation: this.cache.get(g.unitId) }));
  }
  private needed(group: CaptionGroup) {
    return group.end > this.time && group.start < this.time + this.horizon;
  }
  private plan() {
    this.queued = [];
    if (!this.enabled) return;
    const held = new Set(this.batch?.groups.map((g) => g.unitId));
    let current: CaptionGroup[] = [];
    let length = 0;
    for (const group of this.groups) {
      if (
        !this.needed(group) ||
        this.cache.has(group.unitId) ||
        this.attempted.has(group.unitId) ||
        held.has(group.unitId)
      )
        continue;
      const count = [...group.text].length;
      if (current.length && (current.length === 20 || length + count > 6000)) {
        this.queued.push(current);
        if (this.queued.length === 2) return;
        current = [];
        length = 0;
      }
      current.push(group);
      length += count;
    }
    if (current.length) this.queued.push(current);
  }
  private create(groups: CaptionGroup[]): Batch {
    return {
      clientTaskId: crypto.randomUUID(),
      groups,
      phase: 'new',
      admittedAt: this.now(),
      input: CaptionInputSchema.parse({
        ...this.identity(),
        batchId: crypto.randomUUID(),
        sourceLanguage: this.scope.sourceLanguage,
        targetLanguage: this.scope.targetLanguage,
        units: groups.map(({ unitId, revision, text }) => ({ unitId, revision, text })),
      }),
    };
  }
  private drive() {
    if (this.disposed || this.busy || this.failures >= 3 || this.now() < this.nextAt) return;
    if (!this.batch) {
      if (!this.enabled || !this.queued.length) {
        this.publish();
        return;
      }
      this.batch = this.create(this.queued.shift()!);
    }
    const batch = this.batch;
    if (batch.phase === 'new' && this.now() - batch.admittedAt >= 60_000) {
      this.batch = undefined;
      this.pause('TASK_BUSY');
      return;
    }
    if (!this.enabled && !batch.cancel && batch.phase !== 'canceling') return;
    const action = batch.cancel
      ? 'translation.cancel'
      : batch.phase === 'new'
        ? 'learning.start'
        : 'translation.status';
    if (action === 'learning.start') {
      batch.phase = 'unknown';
      for (const group of batch.groups) this.attempted.add(group.unitId);
    }
    this.busy = true;
    this.publish();
    void this.request(action, batch)
      .then(
        (reply) => {
          if (this.disposed || this.batch !== batch) return;
          this.handleReply(reply, batch, action);
        },
        () => {
          if (this.disposed || this.batch !== batch) return;
          this.failures++;
          this.enabled = false;
          this.state = 'paused';
          this.error = 'CONTEXT_LOST';
          // A timed-out START remains unknown; only query/cancel this identity.
          batch.cancel = 'error';
          batch.phase = 'canceling';
          this.queued = [];
        },
      )
      .finally(() => {
        this.busy = false;
        this.nextAt = this.now() + 1000;
        this.publish();
      });
  }
  private async request(type: string, batch: Batch) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const payload =
      type === 'learning.start'
        ? {
            purpose: 'captions',
            origin: 'page',
            expectedProvider: this.scope.provider,
            input: batch.input,
            clientTaskId: batch.clientTaskId,
            documentNonce: this.scope.documentNonce,
          }
        : { clientTaskId: batch.clientTaskId, documentNonce: this.scope.documentNonce };
    try {
      return await Promise.race([
        this.transport.request({
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          type,
          payload,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('CONTEXT_LOST')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private handleReply(reply: unknown, batch: Batch, action: string) {
    const envelope = z
      .object({ ok: z.boolean(), data: z.unknown().optional(), error: z.string().optional() })
      .safeParse(reply);
    if (!envelope.success) {
      this.pause('CONTEXT_LOST');
      return;
    }
    if (!envelope.data.ok) {
      if (action === 'learning.start' && envelope.data.error === 'TASK_BUSY') {
        for (const group of batch.groups) this.attempted.delete(group.unitId);
        batch.phase = 'new';
        this.state = 'waiting';
        if (this.now() - batch.admittedAt >= 60_000) this.pause('TASK_BUSY');
      } else this.pause(envelope.data.error ?? 'CONTEXT_LOST');
      return;
    }
    const value = StateSchema.safeParse(envelope.data.data);
    if (!value.success || value.data.clientTaskId !== batch.clientTaskId) {
      this.pause('CONTEXT_LOST');
      return;
    }
    const state = value.data;
    if (state.taskId) {
      if (
        state.documentNonce !== this.scope.documentNonce ||
        !state.provider ||
        !sameProvider(state.provider, this.scope.provider) ||
        (batch.taskId && state.taskId !== batch.taskId)
      ) {
        this.pause('CONFLICT');
        return;
      }
      batch.taskId = state.taskId;
    } else if (
      state.state !== 'canceled' ||
      state.cancelPending ||
      action !== 'translation.cancel'
    ) {
      this.pause('CONTEXT_LOST');
      return;
    }
    this.failures = 0;
    this.acceptState(state, batch);
  }
  private acceptState(
    state: Pick<State, 'state' | 'cancelPending' | 'cancelReason' | 'error'>,
    batch: Batch,
  ) {
    if (state.state === 'running' || state.state === 'ready') {
      batch.phase = batch.cancel ? 'canceling' : 'running';
      if (this.enabled && !batch.cancel) this.state = 'running';
      return;
    }
    if (state.state === 'canceled' && state.cancelPending) {
      batch.phase = 'canceling';
      return;
    }
    this.batch = undefined;
    if (this.retryRequested) this.applyRetry();
    else if (batch.cancel === 'seek') {
      this.state = 'running';
      this.plan();
    } else if (
      !batch.cancel &&
      state.state === 'canceled' &&
      state.cancelReason === 'explicit-preemption'
    ) {
      for (const group of batch.groups) this.attempted.delete(group.unitId);
      this.state = 'waiting';
      this.plan();
    } else this.pause(state.state === 'delivered' ? 'RESULT_MISSING' : (state.error ?? 'CANCELED'));
  }
  private pause(error: string) {
    this.enabled = false;
    this.state = 'paused';
    this.error = error;
    this.queued = [];
    if (this.batch) {
      this.failures++;
      this.batch.cancel = 'error';
      this.batch.phase = 'canceling';
    }
    this.publish();
  }
  // Call only from the extension runtime listener after validating its sender.
  // Return true only after complete atomic acceptance, so broker delivery ACKs
  // never claim that a missing/late/invalid result was retained.
  receive(message: unknown): boolean {
    const batch = this.batch;
    if (this.disposed || !batch) return false;
    const parsed = LearningEventSchema.safeParse(message);
    if (!parsed.success) return false;
    const event = parsed.data;
    if (
      event.clientTaskId !== batch.clientTaskId ||
      event.documentNonce !== this.scope.documentNonce ||
      (batch.taskId && event.taskId !== batch.taskId)
    )
      return false;
    if (event.type === 'learning.progress') return false;
    if (event.type === 'learning.state') {
      batch.taskId = event.taskId;
      this.acceptState(event, batch);
      this.publish();
      return true;
    }
    if (
      !this.enabled ||
      batch.cancel ||
      event.result.data.purpose !== 'captions' ||
      event.result.algorithmVersion !== CAPTION_VERSION ||
      !sameProvider(event.provider, this.scope.provider)
    )
      return false;
    const result = event.result.data.value;
    if (
      result.sessionId !== batch.input.sessionId ||
      result.generation !== batch.input.generation ||
      result.videoId !== batch.input.videoId ||
      result.trackKey !== batch.input.trackKey ||
      result.batchId !== batch.input.batchId ||
      result.units.length !== batch.input.units.length
    )
      return false;
    const expected = new Map(batch.input.units.map((unit) => [unit.unitId, unit.revision]));
    if (result.units.some((unit) => expected.get(unit.unitId) !== unit.revision)) return false;
    const added = result.units.reduce(
      (sum, unit) => sum + bytes(unit.text) - bytes(this.cache.get(unit.unitId) ?? ''),
      0,
    );
    if (this.size + added > CAPTION_LIMITS.cacheBytes) {
      this.pause('CAPTION_LIMIT');
      return false;
    }
    for (const unit of result.units) this.cache.set(unit.unitId, unit.text);
    this.size += added;
    this.batch = undefined;
    this.state = 'running';
    this.plan();
    this.publish();
    return true;
  }
  async stop(): Promise<boolean> {
    if (this.disposed && !this.batch) return true;
    this.disposed = true;
    this.enabled = false;
    this.state = 'stopped';
    this.queued = [];
    this.cache.clear();
    this.publish();
    this.listeners.clear();
    const batch = this.batch;
    if (!batch) return true;
    batch.cancel = 'stop';
    try {
      const reply = await this.request('translation.cancel', batch);
      const value = z
        .object({
          ok: z.literal(true),
          data: z.object({
            clientTaskId: z.literal(batch.clientTaskId),
            state: z.literal('canceled'),
            cancelPending: z.literal(false).optional(),
          }),
        })
        .safeParse(reply);
      if (!value.success) return false;
      this.batch = undefined;
      return true;
    } catch {
      return false;
    }
  }
}
