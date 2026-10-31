import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: {} }));
import { ExecutorHost } from '../../src/background/executor-host';
import type { browser } from 'wxt/browser';
import type { Execution, ExecutorCommand } from '../../src/runtime/executor-protocol';

type Port = ReturnType<typeof browser.runtime.connect>;
const extensionId = 'self';
const url = 'chrome-extension://self/offscreen.html';
const execution = (epoch: string): Execution => ({
  taskId: crypto.randomUUID(),
  deadlineAt: Date.now() + 60_000,
  source: { kind: 'plain-text', text: epoch },
  sourceLanguage: 'auto',
  targetLanguage: 'en',
  config: { baseUrl: 'https://example.test', model: 'test', apiKey: 'FIXTURE_KEY' },
});
function setup() {
  let exists = false;
  let currentEpoch = crypto.randomUUID();
  let current: ReturnType<typeof port>;
  const stored: Record<string, unknown> = {};
  const tasks = new Set<string>();
  let dropStarts = false;
  const commands: ExecutorCommand[] = [];
  const port = (sender: object = { id: extensionId, url }) => {
    const messages: Array<(message: unknown) => void> = [];
    const disconnected: Array<() => void> = [];
    const value = {
      name: 'sayvia.executor.v1',
      sender,
      onMessage: {
        addListener: vi.fn((listener: (message: unknown) => void) => messages.push(listener)),
      },
      onDisconnect: { addListener: vi.fn((listener: () => void) => disconnected.push(listener)) },
      disconnect: vi.fn(() => disconnected.forEach((listener) => listener())),
      postMessage: vi.fn((request: ExecutorCommand) => {
        commands.push(request);
        let data: unknown;
        if (request.command.type === 'start') {
          tasks.add(request.command.execution.taskId);
          data = { taskId: request.command.execution.taskId, state: 'running' };
          if (dropStarts) return;
        } else if (request.command.type === 'query')
          data = {
            taskId: request.command.taskId,
            state: tasks.has(request.command.taskId) ? 'running' : 'missing',
          };
        else if (request.command.type === 'ack' || request.command.type === 'cancel') {
          tasks.delete(request.command.taskId);
          data = { taskId: request.command.taskId, state: 'delivered' };
        } else data = { active: tasks.size, pendingResults: 0 };
        queueMicrotask(() =>
          messages.forEach((listener) =>
            listener({
              protocolVersion: 1,
              type: 'executor.reply',
              epoch: request.epoch,
              requestId: request.requestId,
              data,
            }),
          ),
        );
      }),
    };
    return {
      value,
      hello: (epoch = currentEpoch) =>
        messages.forEach((listener) =>
          listener({ protocolVersion: 1, type: 'executor.hello', epoch }),
        ),
    };
  };
  const connect = () => {
    current = port();
    host.accept(current.value as unknown as Port);
    current.hello();
  };
  const api = {
    runtime: {
      id: extensionId,
      getURL: (path: string) => `chrome-extension://self${path}`,
      getContexts: vi.fn(async () => (exists ? [{ documentId: 'actual-offscreen-document' }] : [])),
      sendMessage: vi.fn(async () => connect()),
    },
    offscreen: {
      createDocument: vi.fn(async () => {
        exists = true;
        currentEpoch = crypto.randomUUID();
        connect();
      }),
      closeDocument: vi.fn(async () => {
        exists = false;
        current.value.disconnect();
      }),
    },
    storage: {
      session: {
        get: vi.fn(async () => structuredClone(stored)),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(stored, values)),
        remove: vi.fn(async (key: string) => {
          delete stored[key];
        }),
      },
    },
  };
  const host = new ExecutorHost(Promise.resolve(), vi.fn(), api as unknown as typeof browser);
  return {
    host,
    api,
    commands,
    port,
    stored,
    tasks,
    makeExisting: () => {
      exists = true;
    },
    dropStarts: () => {
      dropStarts = true;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('serialized Offscreen lifecycle', () => {
  it('creates one shared executor when two tabs start concurrently', async () => {
    const f = setup();
    const first = await Promise.all([
      f.host.start(async (epoch) => execution(epoch)),
      f.host.start(async (epoch) => execution(epoch)),
    ]);
    expect(first.map((value) => value.state)).toEqual(['running', 'running']);
    expect(f.api.offscreen.createDocument).toHaveBeenCalledOnce();
    expect(f.commands.filter((value) => value.command.type === 'start')).toHaveLength(2);
    await f.host.closeIfIdle();
    expect(f.api.offscreen.closeDocument).not.toHaveBeenCalled();
  });

  it('serializes an idle close before a new task creates its next environment', async () => {
    const f = setup();
    const started = await f.host.start(async (epoch) => execution(epoch));
    const identity = f.stored['sayvia.executor'] as { epoch: string };
    await f.host.task('ack', started.taskId, identity.epoch);
    let release!: () => void;
    const close = f.api.offscreen.closeDocument.getMockImplementation()!;
    f.api.offscreen.closeDocument.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await close();
    });
    const closing = f.host.closeIfIdle();
    await vi.waitFor(() => expect(release).toBeDefined());
    const next = f.host.start(async (epoch) => execution(epoch));
    expect(f.api.offscreen.createDocument).toHaveBeenCalledOnce();
    release();
    await closing;
    await next;
    expect(f.api.offscreen.createDocument).toHaveBeenCalledTimes(2);
    expect(f.api.offscreen.closeDocument).toHaveBeenCalledOnce();
  });

  it('recovery never creates an executor or replays START when no environment exists', async () => {
    const f = setup();
    await expect(f.host.task('query', crypto.randomUUID(), crypto.randomUUID())).rejects.toThrow(
      'EXECUTOR_UNAVAILABLE',
    );
    expect(f.api.offscreen.createDocument).not.toHaveBeenCalled();
    expect(f.commands).toHaveLength(0);
  });

  it('a lost START reply is followed only by a query', async () => {
    vi.useFakeTimers();
    const f = setup();
    f.dropStarts();
    const starting = f.host.start(async (epoch) => execution(epoch));
    const assertion = expect(starting).rejects.toThrow('EXECUTOR_UNAVAILABLE');
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    const request = f.commands.find((value) => value.command.type === 'start')!;
    if (request.command.type !== 'start') throw new Error('Missing fixture request');
    expect(
      await f.host.task('query', request.command.execution.taskId, request.epoch),
    ).toMatchObject({ state: 'running' });
    expect(f.commands.filter((value) => value.command.type === 'start')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts Chrome offscreen senders without documentId but rejects a conflicting provided id', async () => {
    const f = setup();
    f.makeExisting();
    const forged = f.port({ id: extensionId, url, documentId: 'different-document' });
    f.host.accept(forged.value as unknown as Port);
    forged.hello();
    await vi.waitFor(() => expect(forged.value.disconnect).toHaveBeenCalledOnce());
    expect(f.api.storage.session.set).not.toHaveBeenCalled();
    const result = await f.host.start(async (epoch) => execution(epoch));
    expect(result.state).toBe('running');
    expect(f.api.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'attacker', url },
    { id: extensionId, url: 'https://example.test' },
    { id: extensionId, url, tab: { id: 1 } },
  ])('rejects an untrusted port sender %j', (sender) => {
    const f = setup();
    const bad = f.port(sender);
    f.host.accept(bad.value as unknown as Port);
    expect(bad.value.onMessage.addListener).not.toHaveBeenCalled();
    expect(f.commands).toHaveLength(0);
  });
});
