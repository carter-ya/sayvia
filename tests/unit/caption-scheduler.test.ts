import { afterEach, expect, it, vi } from 'vitest';
import { CaptionScheduler, type SchedulerScope } from '../../src/captions/scheduler';
import { CAPTION_LIMITS, type CaptionGroup } from '../../src/captions/contract';
import type { CaptionInput } from '../../src/core/learning-contract';
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const scope = (): SchedulerScope => ({
  session: {
    sessionId: crypto.randomUUID(),
    generation: 0,
    videoId: 'video',
    trackKey: 'track',
    captureGeneration: crypto.randomUUID(),
  },
  provider: { id: crypto.randomUUID(), revision: 1, model: 'fixture' },
  documentNonce: crypto.randomUUID(),
  sourceLanguage: 'en',
  targetLanguage: 'zh-CN',
});
const group = (i: number, text = 'word'): CaptionGroup => ({
  unitId: `g${i}`,
  revision: 0,
  start: i * 1000,
  end: (i + 1) * 1000,
  text,
  windowId: '1',
  sources: [{ id: `s${i}`, revision: 0 }],
});
type Request = {
  type: string;
  payload: { clientTaskId: string; documentNonce: string; input: CaptionInput };
};
const schedulers: CaptionScheduler[] = [];
async function fixture(groups = Array.from({ length: 100 }, (_, i) => group(i))) {
  const config = scope();
  let now = 0;
  const taskId = crypto.randomUUID();
  const request = vi.fn(async (raw: Record<string, unknown>): Promise<unknown> => {
    const r = raw as unknown as Request;
    return {
      ok: true,
      data: {
        clientTaskId: r.payload.clientTaskId,
        documentNonce: config.documentNonce,
        taskId,
        provider: config.provider,
        canApply: false,
        state: r.type === 'translation.cancel' ? 'canceled' : 'running',
        cancelPending: false,
      },
    };
  });
  const scheduler = new CaptionScheduler(config, groups, { request, now: () => now });
  schedulers.push(scheduler);
  const advance = async (time: number, rate = 1) => {
    now += 1100;
    scheduler.tick(time, rate);
    await flush();
  };
  const calls = () => request.mock.calls.map(([raw]) => raw as unknown as Request);
  const result = (r = calls()[0]!, text = '译文') => ({
    protocolVersion: 1,
    type: 'learning.result',
    taskId,
    clientTaskId: r.payload.clientTaskId,
    documentNonce: config.documentNonce,
    canApply: false,
    provider: config.provider,
    result: {
      requested: true,
      algorithmVersion: 'caption-units-v1',
      durationMs: 1,
      estimates: { inputTokens: 1, outputTokens: 1 },
      data: {
        purpose: 'captions',
        value: {
          sessionId: config.session.sessionId,
          generation: config.session.generation,
          videoId: config.session.videoId,
          trackKey: config.session.trackKey,
          batchId: r.payload.input.batchId,
          units: r.payload.input.units.map((u) => ({ ...u, text })),
        },
      },
    },
  });
  const state = (r: Request, fields: Record<string, unknown>) => ({
    protocolVersion: 1,
    type: 'learning.state',
    taskId,
    clientTaskId: r.payload.clientTaskId,
    documentNonce: config.documentNonce,
    ...fields,
  });
  return {
    scheduler,
    config,
    request,
    calls,
    result,
    state,
    advance,
    taskId,
    setNow: (value: number) => {
      now = value;
    },
  };
}
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.stop();
  vi.useRealTimers();
});

it('does nothing until explicit start and limits prefetch to the clock horizon and two queued batches', async () => {
  const f = await fixture();
  await f.advance(0);
  expect(f.calls()).toHaveLength(0);
  f.scheduler.start();
  await flush();
  expect(f.calls()).toHaveLength(1);
  expect(f.calls()[0]!.payload.input.units).toHaveLength(20);
  expect(f.scheduler.snapshot()).toMatchObject({ inFlight: 1, queued: 1 });
  await f.advance(0, 2);
  expect(f.scheduler.snapshot().queued).toBe(2);
  expect(f.calls().filter((r) => r.type === 'learning.start')).toHaveLength(1);
  expect(f.scheduler.receive(f.result())).toBe(true);
  await f.advance(0, 2);
  expect(f.calls().at(-1)!.payload.input.units[0]!.unitId).toBe('g20');
});
it('respects 6000 codepoints and snapshots mutable scope and source arrays', async () => {
  const groups = Array.from({ length: 5 }, (_, i) => group(i, '字'.repeat(3000)));
  const f = await fixture(groups);
  groups[0]!.text = 'changed';
  f.config.provider.model = 'changed';
  f.scheduler.start();
  await flush();
  const payload = f.calls()[0]!.payload;
  expect(payload.input.units).toHaveLength(2);
  expect(payload.input.units[0]!.text).toHaveLength(3000);
  expect(f.request.mock.calls[0]![0].payload).toMatchObject({
    expectedProvider: { model: 'fixture' },
  });
});
it('retains a complete result arriving before START ACK and ignores the later ACK', async () => {
  const f = await fixture();
  const ack = deferred<unknown>();
  f.request.mockImplementationOnce(() => ack.promise);
  f.scheduler.start();
  expect(f.scheduler.receive(f.result())).toBe(true);
  expect(f.scheduler.visible(500)[0]!.translation).toBe('译文');
  const bytes = f.scheduler.snapshot().cacheBytes;
  expect(f.scheduler.receive(f.result())).toBe(false);
  expect(f.scheduler.snapshot().cacheBytes).toBe(bytes);
  ack.resolve({ ok: false, error: 'CONFLICT' });
  await flush();
  expect(f.scheduler.snapshot().state).toBe('running');
});
it('never repeats a lost START and holds cancellation until acknowledgement, including explicit retry', async () => {
  const f = await fixture();
  f.request.mockRejectedValueOnce(new Error('ACK_LOST'));
  f.scheduler.start();
  await flush();
  expect(f.scheduler.snapshot()).toMatchObject({ state: 'paused', inFlight: 1 });
  const original = f.calls()[0]!;
  f.request.mockImplementationOnce(async () => ({
    ok: true,
    data: {
      clientTaskId: original.payload.clientTaskId,
      taskId: f.taskId,
      documentNonce: f.config.documentNonce,
      provider: f.config.provider,
      state: 'canceled',
      canApply: false,
      cancelPending: true,
    },
  }));
  f.scheduler.retry();
  await flush();
  expect(f.calls().filter((r) => r.type === 'learning.start')).toHaveLength(1);
  expect(f.scheduler.snapshot().inFlight).toBe(1);
  await f.advance(0);
  expect(f.calls().filter((r) => r.type === 'learning.start')).toHaveLength(1);
  await f.advance(0);
  expect(f.calls().at(-1)!.type).toBe('learning.start');
  expect(f.calls().at(-1)!.payload.clientTaskId).not.toBe(original.payload.clientTaskId);
});
it('backs off definite TASK_BUSY with the same attempt and stops automatic admission after 60 seconds', async () => {
  const f = await fixture();
  f.request.mockResolvedValue({ ok: false, error: 'TASK_BUSY' });
  f.scheduler.start();
  await flush();
  f.scheduler.tick(0);
  await flush();
  expect(f.calls()).toHaveLength(1);
  await f.advance(0);
  expect(f.calls()[1]!.payload.clientTaskId).toBe(f.calls()[0]!.payload.clientTaskId);
  f.setNow(61_000);
  f.scheduler.tick(0);
  await flush();
  expect(f.scheduler.snapshot()).toMatchObject({ state: 'paused', error: 'TASK_BUSY' });
});
it('resumes only a confirmed explicit preemption and only when its groups remain relevant', async () => {
  const f = await fixture();
  f.scheduler.start();
  await flush();
  const first = f.calls()[0]!;
  expect(
    f.scheduler.receive(
      f.state(first, {
        state: 'canceled',
        cancelPending: true,
        cancelReason: 'explicit-preemption',
      }),
    ),
  ).toBe(true);
  f.request.mockImplementationOnce(async () => ({
    ok: true,
    data: {
      clientTaskId: first.payload.clientTaskId,
      taskId: f.taskId,
      documentNonce: f.config.documentNonce,
      provider: f.config.provider,
      state: 'canceled',
      canApply: false,
      cancelPending: false,
      cancelReason: 'explicit-preemption',
    },
  }));
  await f.advance(0);
  expect(f.calls().at(-1)!.type).toBe('translation.status');
  await f.advance(0);
  expect(f.calls().at(-1)!.type).toBe('learning.start');
  expect(f.calls().at(-1)!.payload.clientTaskId).not.toBe(first.payload.clientTaskId);
});
it('model failures pause without a new attempt and delivered without actual result cannot count as success', async () => {
  for (const state of ['failed', 'timedOut', 'delivered']) {
    const f = await fixture();
    f.scheduler.start();
    await flush();
    f.scheduler.receive(f.state(f.calls()[0]!, { state }));
    await f.advance(100);
    expect(f.calls().filter((r) => r.type === 'learning.start')).toHaveLength(1);
    expect(f.scheduler.snapshot()).toMatchObject({ state: 'paused', translated: 0 });
  }
});
it('seek reprioritizes pending work, preserves partly relevant in-flight groups, and never silently retries a canceled interval', async () => {
  const f = await fixture();
  f.scheduler.start();
  await flush();
  await f.advance(15_000);
  expect(f.calls().at(-1)!.type).toBe('translation.status');
  await f.advance(60_000);
  expect(f.calls().at(-1)!.type).toBe('translation.cancel');
  await f.advance(60_000);
  expect(f.calls().at(-1)!.payload.input.units[0]!.unitId).toBe('g60');
  await f.advance(0);
  await f.advance(0);
  expect(f.scheduler.snapshot().needsRetry).toBe(true);
  const starts = f.calls().filter((r) => r.type === 'learning.start');
  expect(
    starts.every(
      (r, i) => i === 0 || r.payload.input.units.every((u) => !/^g([0-9]|1[0-9])$/.test(u.unitId)),
    ),
  ).toBe(true);
});
it('uses intervals for overlapping windows and clears normal gaps; late translations never replay expired units', async () => {
  const f = await fixture([
    { ...group(0), end: 3000 },
    { ...group(1), windowId: '2', end: 2000 },
    group(5),
  ]);
  f.scheduler.start();
  await flush();
  await f.advance(1500);
  expect(f.scheduler.visible().map((v) => v.unitId)).toEqual(['g0', 'g1']);
  expect(f.scheduler.receive(f.result())).toBe(true);
  expect(f.scheduler.visible(3500)).toEqual([]);
  expect(f.scheduler.visible(5500)[0]!.unitId).toBe('g5');
  expect(f.scheduler.visible(1500).every((v) => v.translation === '译文')).toBe(true);
});
it('rejects wrong identity, provider, unit set/revision and protocol without changing cache', async () => {
  const f = await fixture();
  f.scheduler.start();
  await flush();
  const good = f.result();
  for (const mutate of [
    (r: typeof good) => {
      r.documentNonce = crypto.randomUUID();
    },
    (r: typeof good) => {
      r.provider = { ...r.provider, revision: 9 };
    },
    (r: typeof good) => {
      r.result.data.value.batchId = crypto.randomUUID();
    },
    (r: typeof good) => {
      r.result.data.value.generation++;
    },
    (r: typeof good) => {
      r.result.data.value.units[0]!.revision++;
    },
    (r: typeof good) => {
      r.result.data.value.units.pop();
    },
    (r: typeof good) => {
      r.result.algorithmVersion = 'unknown';
    },
  ]) {
    const invalid = structuredClone(good);
    mutate(invalid);
    expect(f.scheduler.receive(invalid)).toBe(false);
    expect(f.scheduler.snapshot().translated).toBe(0);
  }
  expect(f.scheduler.receive(good)).toBe(true);
});
it('commits a whole batch atomically at the UTF-8 cache limit and rejects one byte over', async () => {
  for (const delta of [0, 1]) {
    const wanted = CAPTION_LIMITS.cacheBytes - 4 + delta;
    const rows: CaptionGroup[] = [group(0, 'a'.repeat(3000)), group(1, 'a'.repeat(3000))];
    let remaining = wanted - 6000;
    while (remaining) {
      const length = Math.min(4000, remaining);
      rows.push(group(rows.length, 'a'.repeat(length)));
      remaining -= length;
    }
    // The first two groups share a batch; four added bytes must commit atomically.
    rows.forEach((g, i) => {
      g.start = i < 2 ? i * 1000 : i * 100_000;
      g.end = g.start + 1000;
    });
    const f = await fixture(rows);
    f.scheduler.start();
    await flush();
    expect(f.scheduler.receive(f.result(undefined, 'ok'))).toBe(delta === 0);
    expect(f.scheduler.snapshot().translated).toBe(delta === 0 ? 2 : 0);
    if (delta)
      expect(f.scheduler.snapshot()).toMatchObject({
        state: 'paused',
        error: 'CAPTION_LIMIT',
        cacheBytes: wanted,
      });
  }
});
it('permanently ignores late events/ACKs after stop, and reports unresolved cancellation', async () => {
  const f = await fixture();
  const ack = deferred<unknown>();
  f.request.mockImplementationOnce(() => ack.promise);
  f.scheduler.start();
  const result = f.result();
  f.request.mockRejectedValueOnce(new Error('cancel lost'));
  expect(await f.scheduler.stop()).toBe(false);
  expect(f.scheduler.receive(result)).toBe(false);
  ack.resolve({ ok: true });
  await flush();
  f.scheduler.tick(0);
  f.scheduler.start();
  f.scheduler.retry();
  expect(f.calls().filter((r) => r.type === 'learning.start')).toHaveLength(1);
  expect(f.scheduler.snapshot().state).toBe('stopped');
});

it('checks admission expiry before sending START even when a freed slot would now accept it', async () => {
  const f = await fixture();
  f.request.mockResolvedValueOnce({ ok: false, error: 'TASK_BUSY' });
  f.scheduler.start();
  await flush();
  f.setNow(61_000);
  f.scheduler.tick(0);
  await flush();
  expect(f.calls().filter((r) => r.type === 'learning.start')).toHaveLength(1);
  expect(f.scheduler.snapshot()).toMatchObject({
    state: 'paused',
    error: 'TASK_BUSY',
    inFlight: 0,
  });
});
it('reports running after a busy admission succeeds before its deadline', async () => {
  const f = await fixture();
  f.request.mockResolvedValueOnce({ ok: false, error: 'TASK_BUSY' });
  f.scheduler.start();
  await flush();
  expect(f.scheduler.snapshot().state).toBe('waiting');
  await f.advance(0);
  expect(f.scheduler.snapshot().state).toBe('running');
});

it('times out a never-returning START without forgetting its identity or accepting its late result', async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const ack = deferred<unknown>();
  f.request.mockImplementationOnce(() => ack.promise);
  f.scheduler.start();
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.scheduler.snapshot()).toMatchObject({
    state: 'paused',
    inFlight: 1,
    error: 'CONTEXT_LOST',
  });
  const original = f.calls()[0]!;
  expect(f.scheduler.receive(f.result(original))).toBe(false);
  expect(await f.scheduler.stop()).toBe(true);
  expect(f.calls().at(-1)!.payload.clientTaskId).toBe(original.payload.clientTaskId);
  ack.resolve({ ok: true });
  await vi.advanceTimersByTimeAsync(1);
  expect(f.calls().filter((r) => r.type === 'learning.start')).toHaveLength(1);
});
it('can confirm the same stopped attempt after its first cancellation reply was lost', async () => {
  const f = await fixture();
  f.scheduler.start();
  await flush();
  f.request.mockRejectedValueOnce(new Error('lost cancel'));
  expect(await f.scheduler.stop()).toBe(false);
  expect(await f.scheduler.stop()).toBe(true);
  expect(
    f
      .calls()
      .filter((r) => r.type === 'translation.cancel')
      .map((r) => r.payload.clientTaskId),
  ).toEqual([f.calls()[0]!.payload.clientTaskId, f.calls()[0]!.payload.clientTaskId]);
});
