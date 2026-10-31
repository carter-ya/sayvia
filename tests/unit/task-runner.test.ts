import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { localProcessor } from '../../src/core/translation-processor';
import { TaskRunner, RESULT_TTL_MS, DEDUP_TTL_MS } from '../../src/executor/task-runner';
import {
  ExecutionSchema,
  ExecutorCommandSchema,
  type Execution,
} from '../../src/runtime/executor-protocol';

function input(): Execution {
  return {
    taskId: crypto.randomUUID(),
    deadlineAt: Date.now() + 60_000,
    source: { kind: 'plain-text', text: '你好' },
    sourceLanguage: 'auto',
    targetLanguage: 'en',
    config: { apiKey: 'FIXTURE_KEY', baseUrl: 'https://example.test', model: 'fixture-model' },
  };
}
function completion(text = 'Hello') {
  return new Response(
    JSON.stringify({
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify({ segments: [{ id: 's0', text }] }),
          },
        },
      ],
    }),
  );
}
const runners: TaskRunner[] = [];
const setup = (fetcher = vi.fn<typeof fetch>().mockResolvedValue(completion())) => {
  const processors: ReturnType<typeof localProcessor>[] = [];
  const changed = vi.fn();
  const runner = new TaskRunner(
    changed,
    () => {
      const processor = localProcessor();
      vi.spyOn(processor, 'dispose');
      processors.push(processor);
      return processor;
    },
    fetcher,
  );
  runners.push(runner);
  return { runner, fetcher, processors, changed };
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  runners.splice(0).forEach((r) => r.dispose());
  vi.useRealTimers();
});

describe('bounded execution lifecycle', () => {
  it('deduplicates start before and after completion without retaining credentials in views', async () => {
    const { runner, fetcher, processors } = setup();
    const task = input();
    expect(runner.start(task).state).toBe('running');
    expect(runner.start({ ...task, source: { kind: 'plain-text', text: 'DIFFERENT' } }).state).toBe(
      'running',
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.query(task.taskId)).toMatchObject({ state: 'ready', result: { text: 'Hello' } });
    expect(runner.start(task).state).toBe('ready');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(processors[0]!.dispose).toHaveBeenCalled();
    expect(JSON.stringify(runner.query(task.taskId))).not.toMatch(/FIXTURE_KEY|你好|example.test/);
  });

  it('a cancel tombstone defeats a later START without allocating a worker or fetching', () => {
    const { runner, fetcher, processors } = setup();
    const task = input();
    expect(runner.cancel(task.taskId).state).toBe('canceled');
    expect(runner.start(task).state).toBe('canceled');
    expect(processors).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels during preparation before any network request begins', async () => {
    const { runner, fetcher } = setup();
    const task = input();
    runner.start(task);
    runner.cancel(task.taskId);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(runner.query(task.taskId).state).toBe('canceled');
  });

  it('aborts running fetch and discards a late response', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { runner, processors } = setup(fetcher);
    const task = input();
    runner.start(task);
    await vi.advanceTimersByTimeAsync(0);
    const signal = fetcher.mock.calls[0]![1]!.signal!;
    runner.cancel(task.taskId);
    expect(signal.aborted).toBe(true);
    finish(completion());
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.query(task.taskId)).toEqual({
      taskId: task.taskId,
      state: 'canceled',
      error: 'CANCELED',
    });
    expect(processors[0]!.dispose).toHaveBeenCalled();
  });

  it('limits running executions to four and never queues a fifth request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const { runner } = setup(fetcher);
    const tasks = Array.from({ length: 4 }, input);
    tasks.forEach((task) => runner.start(task));
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.start(input())).toMatchObject({ state: 'failed', error: 'TASK_BUSY' });
    expect(fetcher).toHaveBeenCalledTimes(4);
    runner.cancel(tasks[0]!.taskId);
    expect(runner.start(input()).state).toBe('running');
  });

  it('bounds the full execution including a stalled processor to the absolute deadline', async () => {
    const dispose = vi.fn();
    const runner = new TaskRunner(vi.fn(), () => ({
      prepare: () => new Promise(() => {}),
      reconstruct: vi.fn(),
      dispose,
    }));
    runners.push(runner);
    const task = input();
    runner.start(task);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.query(task.taskId)).toMatchObject({ state: 'timedOut', error: 'TIMEOUT' });
    expect(dispose).toHaveBeenCalledOnce();
    expect(runner.inspect().active).toBe(0);
  });

  it('rejects elapsed or oversized deadlines without issuing requests', () => {
    const { runner, fetcher } = setup();
    expect(runner.start({ ...input(), deadlineAt: Date.now() - 1 }).state).toBe('timedOut');
    expect(runner.start({ ...input(), deadlineAt: Date.now() + 60_001 }).state).toBe('timedOut');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('drops unacknowledged results after 30 seconds and retains bounded dedup state', async () => {
    const { runner } = setup();
    const task = input();
    runner.start(task);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RESULT_TTL_MS - 1);
    expect(runner.query(task.taskId).result?.text).toBe('Hello');
    await vi.advanceTimersByTimeAsync(1);
    expect(runner.query(task.taskId)).toEqual({ taskId: task.taskId, state: 'expired' });
    await vi.advanceTimersByTimeAsync(DEDUP_TTL_MS);
    expect(runner.query(task.taskId).state).toBe('missing');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('acknowledgment releases the result immediately and repeated START never replays', async () => {
    const { runner, fetcher } = setup();
    const task = input();
    runner.start(task);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.acknowledge(task.taskId)).toEqual({ taskId: task.taskId, state: 'delivered' });
    expect(runner.start(task).state).toBe('delivered');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('returns protected-only source without a network call', async () => {
    const { runner, fetcher } = setup();
    const task = { ...input(), source: { kind: 'markdown' as const, text: '`timeout`' } };
    runner.start(task);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.query(task.taskId)).toMatchObject({
      state: 'ready',
      result: { text: '`timeout`', requested: false },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('allowlists failures and releases all processors and timers on disposal', async () => {
    const { runner, processors } = setup(
      vi.fn<typeof fetch>().mockRejectedValue(new Error('SECRET_RAW_RESPONSE')),
    );
    const task = input();
    runner.start(task);
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.query(task.taskId)).toEqual({
      taskId: task.taskId,
      state: 'failed',
      error: 'NETWORK_ERROR',
    });
    expect(processors[0]!.dispose).toHaveBeenCalled();
    runner.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds cancellation tombstones without evicting valid dedup entries', () => {
    const { runner, fetcher } = setup();
    const task = input();
    runner.cancel(task.taskId);
    for (let index = 1; index < 512; index++) runner.cancel(crypto.randomUUID());
    expect(runner.start(input())).toMatchObject({ state: 'failed', error: 'TASK_BUSY' });
    expect(runner.start(task).state).toBe('canceled');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it('strictly rejects extra fields, invalid intervals, and credentials in worker-bound source', () => {
  const task = input();
  expect(
    ExecutionSchema.safeParse({ ...task, source: { ...task.source, apiKey: 'secret' } }).success,
  ).toBe(false);
  expect(
    ExecutionSchema.safeParse({
      ...task,
      source: {
        kind: 'dom-selection',
        text: 'hello',
        marks: [],
        protectedRanges: [{ start: 1, end: 100, kind: 'inline-code' }],
      },
    }).success,
  ).toBe(false);
  const command = {
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    epoch: crypto.randomUUID(),
    token: crypto.randomUUID(),
    command: { type: 'start', execution: task },
  };
  expect(ExecutorCommandSchema.safeParse(command).success).toBe(true);
  expect(ExecutorCommandSchema.safeParse({ ...command, targetTabId: 55 }).success).toBe(false);
});
