import { describe, expect, it, vi } from 'vitest';
import { TaskBroker, type TaskOwner } from '../../src/background/task-broker';
import type { ExecutionView } from '../../src/runtime/executor-protocol';
import type { StartPayload, TaskMessage, TaskSession } from '../../src/runtime/task-protocol';
import type { ConfigRepository } from '../../src/storage/repository';

const providerId = crypto.randomUUID();
const epoch = crypto.randomUUID();
const owner = (): TaskOwner => ({
  tabId: 1,
  frameId: 0,
  documentId: crypto.randomUUID(),
  documentNonce: crypto.randomUUID(),
  kind: 'page',
});
function start(who: TaskOwner): Extract<TaskMessage, { type: 'translation.start' }> {
  const payload: StartPayload = {
    clientTaskId: crypto.randomUUID(),
    documentNonce: who.documentNonce,
    mode: who.kind === 'manual' ? 'manual' : 'write',
    scope: 'full',
    source: { kind: 'plain-text', text: 'PRIVATE_SOURCE_TEXT' },
    sourceLanguage: 'auto',
    targetLanguage: 'en',
    editorSessionId: crypto.randomUUID(),
    sourceRevision: 1,
  };
  return { protocolVersion: 1, requestId: crypto.randomUUID(), type: 'translation.start', payload };
}
function control(
  request: ReturnType<typeof start>,
  type: 'translation.status' | 'translation.cancel',
): Exclude<TaskMessage, { type: 'translation.start' | 'translation.manual.read' }> {
  return {
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    type,
    payload: {
      clientTaskId: request.payload.clientTaskId,
      documentNonce: request.payload.documentNonce,
    },
  };
}
async function setup(initial?: TaskSession) {
  let saved: TaskSession = structuredClone(
    initial ?? { version: 1, routes: [], canceled: [], manual: [] },
  );
  const storage = {
    read: vi.fn(async () => structuredClone(saved)),
    write: vi.fn(async (state: TaskSession) => {
      saved = structuredClone(state);
    }),
  };
  const repository = {
    completionConfig: vi
      .fn<ConfigRepository['completionConfig']>()
      .mockImplementation(async () => ({
        providerId,
        providerRevision: 2,
        model: 'fixture-model',
        config: {
          baseUrl: 'https://model.example',
          apiKey: 'NEVER_PERSIST_KEY',
          model: 'fixture-model',
        },
      })),
    snapshot: vi.fn(async () => ({
      providers: [{ id: providerId }],
    })) as unknown as ConfigRepository['snapshot'],
  };
  const views = new Map<string, ExecutionView>();
  let dispatches = 0;
  const host = {
    start: vi.fn(
      async (
        prepare: Parameters<import('../../src/background/executor-host').ExecutorHost['start']>[0],
      ) => {
        const task = await prepare(epoch);
        expect(saved.routes.some((route) => route.taskId === task.taskId)).toBe(true);
        dispatches++;
        const view: ExecutionView = { taskId: task.taskId, state: 'running' };
        views.set(task.taskId, view);
        return structuredClone(view);
      },
    ),
    task: vi.fn(async (type: 'query' | 'cancel' | 'ack', taskId: string) => {
      const current = views.get(taskId);
      if (!current) return { taskId, state: 'missing' as const };
      if (type === 'cancel') {
        current.state = 'canceled';
        delete current.result;
      }
      if (type === 'ack') {
        current.state = 'delivered';
        delete current.result;
      }
      return structuredClone(current);
    }),
    closeIfIdle: vi.fn(async () => {}),
  };
  const platform = {
    permitted: vi.fn<(baseUrl: string) => Promise<boolean>>().mockResolvedValue(true),
    deliver: vi.fn(async () => true),
  };
  const broker = new TaskBroker(storage, repository, host, platform);
  await broker.ready;
  return {
    broker,
    storage,
    repository,
    host,
    platform,
    views,
    saved: () => saved,
    dispatches: () => dispatches,
  };
}
const result = {
  text: 'PRIVATE_RESULT_TEXT',
  requested: true,
  durationMs: 10,
  algorithmVersion: 'segments-v2.1',
};

describe('task ownership and durable dispatch', () => {
  it('rejects a connection test whose configuration revision changed before dispatch', async () => {
    const f = await setup();
    const who = { ...owner(), kind: 'manual' as const };
    expect(await f.broker.handle(start(who), who, 1)).toEqual({ ok: false, error: 'CONFLICT' });
    expect(f.host.start).not.toHaveBeenCalled();
    expect(f.dispatches()).toBe(0);
  });
  it('persists a body-free route before dispatch, and deduplicates all client retries', async () => {
    const f = await setup();
    const who = owner();
    const request = start(who);
    const first = await f.broker.handle(request, who);
    expect(first).toMatchObject({ ok: true, data: { state: 'running' } });
    expect(await f.broker.handle(request, who)).toEqual(first);
    expect(f.dispatches()).toBe(1);
    expect(JSON.stringify(f.saved())).not.toMatch(
      /PRIVATE_SOURCE_TEXT|NEVER_PERSIST_KEY|PRIVATE_RESULT_TEXT/,
    );
    expect(f.saved().routes[0]!.providerRevision).toBe(2);
  });

  it('a canceled client request remains canceled if START arrives later', async () => {
    const f = await setup();
    const who = owner();
    const request = start(who);
    await f.broker.handle(control(request, 'translation.cancel'), who);
    expect(await f.broker.handle(request, who)).toMatchObject({
      ok: true,
      data: { state: 'canceled' },
    });
    expect(f.host.start).not.toHaveBeenCalled();
    expect(f.repository.completionConfig).not.toHaveBeenCalled();
  });

  it('locks the real tab across page and manual tasks and rejects a fifth tab without queues', async () => {
    const f = await setup();
    const who = owner();
    await f.broker.handle(start(who), who);
    const popup: TaskOwner = { ...owner(), kind: 'manual' };
    expect(await f.broker.handle(start(popup), popup)).toEqual({ ok: false, error: 'TASK_BUSY' });
    for (let tabId = 2; tabId <= 4; tabId++) {
      const next = { ...owner(), tabId };
      await f.broker.handle(start(next), next);
    }
    const fifth = { ...owner(), tabId: 5 };
    expect(await f.broker.handle(start(fifth), fifth)).toEqual({ ok: false, error: 'TASK_BUSY' });
    expect(f.dispatches()).toBe(4);
  });

  it('forbids reading another tab, document or nonce even with the same client id', async () => {
    const f = await setup();
    const who = owner();
    const request = start(who);
    await f.broker.handle(request, who);
    for (const other of [
      { ...who, tabId: 2 },
      { ...who, documentId: crypto.randomUUID() },
      { ...who, documentNonce: crypto.randomUUID() },
    ]) {
      expect(await f.broker.handle(control(request, 'translation.status'), other)).toEqual({
        ok: false,
        error: 'NOT_FOUND',
      });
    }
  });

  it('checks current saved provider and host permission before creating an executor', async () => {
    const f = await setup();
    const who = owner();
    f.platform.permitted.mockResolvedValue(false);
    expect(await f.broker.handle(start(who), who)).toEqual({
      ok: false,
      error: 'PERMISSION_DENIED',
    });
    expect(f.host.start).not.toHaveBeenCalled();
    f.platform.permitted.mockResolvedValue(true);
    f.repository.completionConfig.mockRejectedValue(new Error('CONFIG_REQUIRED'));
    expect(await f.broker.handle(start(who), who)).toEqual({ ok: false, error: 'CONFIG_REQUIRED' });
    expect(f.host.start).not.toHaveBeenCalled();
  });

  it('does not dispatch when route persistence fails', async () => {
    const f = await setup();
    const who = owner();
    f.storage.write.mockRejectedValue(new Error('STORAGE_FAILURE'));
    expect(await f.broker.handle(start(who), who)).toEqual({
      ok: false,
      error: 'RUNTIME_UNAVAILABLE',
    });
    expect(f.dispatches()).toBe(0);
  });

  it('queries after a lost START acknowledgment instead of issuing a second START', async () => {
    const f = await setup();
    const who = owner();
    const original = f.host.start.getMockImplementation()!;
    f.host.start.mockImplementation(async (prepare) => {
      await original(prepare);
      throw new Error('ACK_LOST');
    });
    expect(await f.broker.handle(start(who), who)).toMatchObject({
      ok: true,
      data: { state: 'running', canApply: false },
    });
    expect(f.dispatches()).toBe(1);
    expect(f.host.task).toHaveBeenCalledWith('query', f.saved().routes[0]!.taskId, epoch);
    expect(f.saved().routes[0]!.recovered).toBe(true);
  });
});

describe('completion, recovery, and cleanup', () => {
  it('delivers to the owning document once, acknowledges, and never persists page text', async () => {
    const f = await setup();
    const who = owner();
    const request = start(who);
    await f.broker.handle(request, who);
    const route = f.saved().routes[0]!;
    f.views.set(route.taskId, { taskId: route.taskId, state: 'ready', result });
    await f.broker.reconcile();
    await f.broker.reconcile();
    expect(f.platform.deliver).toHaveBeenCalledOnce();
    expect(f.platform.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: who.documentId }),
      result,
      true,
    );
    expect(f.host.task).toHaveBeenCalledWith('ack', route.taskId, epoch);
    expect(JSON.stringify(f.saved())).not.toContain(result.text);
    expect(await f.broker.handle(request, who)).toMatchObject({ data: { state: 'delivered' } });
    expect(f.dispatches()).toBe(1);
  });

  it('restores only delivery after restart, and permanently disables automatic application', async () => {
    const f = await setup();
    const who = owner();
    await f.broker.handle(start(who), who);
    const route = f.saved().routes[0]!;
    f.views.set(route.taskId, { taskId: route.taskId, state: 'ready', result });
    const restarted = new TaskBroker(f.storage, f.repository, f.host, f.platform);
    await restarted.ready;
    expect(f.platform.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: route.taskId, recovered: true }),
      result,
      false,
    );
    expect(f.dispatches()).toBe(1);
    expect(f.saved().routes[0]!.state).toBe('delivered');
  });

  it('marks a missing executor interrupted and never replays work', async () => {
    const f = await setup();
    const who = owner();
    const request = start(who);
    await f.broker.handle(request, who);
    f.views.clear();
    const restarted = new TaskBroker(f.storage, f.repository, f.host, f.platform);
    await restarted.ready;
    expect(await restarted.handle(control(request, 'translation.status'), who)).toMatchObject({
      data: { state: 'interrupted', error: 'CONTEXT_LOST', canApply: false },
    });
    expect(f.dispatches()).toBe(1);
  });

  it('drops undeliverable results rather than delivering to a new document', async () => {
    const f = await setup();
    const who = owner();
    await f.broker.handle(start(who), who);
    const route = f.saved().routes[0]!;
    f.views.set(route.taskId, { taskId: route.taskId, state: 'ready', result });
    f.platform.deliver.mockResolvedValue(false);
    await f.broker.reconcile();
    expect(f.saved().routes[0]!).toMatchObject({ state: 'interrupted', error: 'CONTEXT_LOST' });
    expect(f.host.task).toHaveBeenCalledWith('cancel', route.taskId, epoch);
    expect(JSON.stringify(f.saved())).not.toContain(result.text);
  });

  it('cancellation wins over a late completion', async () => {
    const f = await setup();
    const who = owner();
    const request = start(who);
    await f.broker.handle(request, who);
    const route = f.saved().routes[0]!;
    await f.broker.handle(control(request, 'translation.cancel'), who);
    f.views.set(route.taskId, { taskId: route.taskId, state: 'ready', result });
    await f.broker.reconcile();
    expect(f.platform.deliver).not.toHaveBeenCalled();
    expect(f.saved().routes[0]!.state).toBe('canceled');
  });

  it('retains a manual draft/result before acknowledging and clears it when the tab closes', async () => {
    const f = await setup();
    const who: TaskOwner = { ...owner(), kind: 'manual' };
    const request = start(who);
    await f.broker.handle(request, who);
    const route = f.saved().routes[0]!;
    f.views.set(route.taskId, { taskId: route.taskId, state: 'ready', result });
    await f.broker.reconcile();
    expect(await f.broker.readManual(who.tabId)).toMatchObject({
      input: 'PRIVATE_SOURCE_TEXT',
      result: result.text,
    });
    expect(f.host.task).toHaveBeenCalledWith('ack', route.taskId, epoch);
    expect(f.platform.deliver).not.toHaveBeenCalled();
    await f.broker.cancelWhere((route) => route.tabId === who.tabId, who.tabId);
    expect(await f.broker.readManual(who.tabId)).toBeNull();
  });

  it('cancels provider tasks without canceling tasks on another provider', async () => {
    const f = await setup();
    const who = owner();
    await f.broker.handle(start(who), who);
    await f.broker.cancelWhere((route) => route.providerId === providerId);
    expect(f.saved().routes[0]!.state).toBe('canceled');
    expect(f.host.closeIfIdle).toHaveBeenCalled();
  });
});

it('revoking host A preserves active and completed tasks on still-authorized host B', async () => {
  const f = await setup();
  const providerB = crypto.randomUUID();
  f.repository.completionConfig.mockImplementation(async (id?: string) => ({
    providerId: id ?? providerId,
    providerRevision: 2,
    model: 'fixture-model',
    config: {
      baseUrl: id === providerB ? 'https://b.example/private/v1' : 'https://a.example/private/v1',
      apiKey: 'NEVER_PERSIST_KEY',
      model: 'fixture-model',
    },
  }));
  vi.mocked(f.repository.snapshot).mockResolvedValue({
    providers: [{ id: providerId }, { id: providerB }],
  } as unknown as Awaited<ReturnType<ConfigRepository['snapshot']>>);
  const manual: TaskOwner = { ...owner(), kind: 'manual' };
  const manualRequest = start(manual);
  manualRequest.payload.providerId = providerB;
  await f.broker.handle(manualRequest, manual);
  const manualRoute = f.saved().routes[0]!;
  f.views.set(manualRoute.taskId, { taskId: manualRoute.taskId, state: 'ready', result });
  await f.broker.reconcile();
  const onA = { ...owner(), tabId: 2 };
  const requestA = start(onA);
  await f.broker.handle(requestA, onA);
  const onB = { ...owner(), tabId: 3 };
  const requestB = start(onB);
  requestB.payload.providerId = providerB;
  await f.broker.handle(requestB, onB);
  f.platform.permitted.mockImplementation(
    async (baseUrl) => new URL(baseUrl).hostname !== 'a.example',
  );
  await f.broker.cancelRevokedOrigins(['https://a.example/*']);
  expect(await f.broker.handle(control(requestB, 'translation.status'), onB)).toMatchObject({
    data: { state: 'running' },
  });
  expect(await f.broker.readManual(manual.tabId)).toMatchObject({ result: result.text });
  expect(await f.broker.handle(control(requestA, 'translation.status'), onA)).toMatchObject({
    data: { state: 'canceled' },
  });
});

it('a website revocation only cancels tasks owned by that site', async () => {
  const f = await setup();
  const a = { ...owner(), siteOrigin: 'https://a.example' };
  const taskA = start(a);
  await f.broker.handle(taskA, a);
  const b = { ...owner(), tabId: 2, siteOrigin: 'https://b.example' };
  const taskB = start(b);
  await f.broker.handle(taskB, b);
  await f.broker.cancelRevokedOrigins(['https://a.example/*']);
  expect(await f.broker.handle(control(taskA, 'translation.status'), a)).toMatchObject({
    data: { state: 'canceled' },
  });
  expect(await f.broker.handle(control(taskB, 'translation.status'), b)).toMatchObject({
    data: { state: 'running' },
  });
});

it('uses the dispatched API origin snapshot after configuration changes and retains overlapping grants', async () => {
  const f = await setup();
  const who = owner();
  const request = start(who);
  await f.broker.handle(request, who);
  const route = f.saved().routes[0]!;
  expect(route.apiOrigin).toBe('https://model.example');
  await f.broker.cancelRevokedOrigins(['https://model.example/*']);
  expect(f.saved().routes[0]!.state).toBe('running');
  f.repository.completionConfig.mockRejectedValue(new Error('CONFIG_REQUIRED'));
  f.platform.permitted.mockResolvedValue(false);
  await f.broker.cancelRevokedOrigins(['https://model.example/*']);
  expect(f.saved().routes[0]!.state).toBe('canceled');
});
