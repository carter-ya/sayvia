import { describe, expect, it, vi } from 'vitest';
import { TaskBroker, type TaskOwner, type TaskPlatform } from '../../src/background/task-broker';
import type { ExecutionView } from '../../src/runtime/executor-protocol';
import {
  SessionSchema,
  type StartPayload,
  type TaskMessage,
  type TaskSession,
} from '../../src/runtime/task-protocol';
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
async function setup(initial?: TaskSession, loseCancelAck = false) {
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
      if (type === 'cancel' && loseCancelAck) throw new Error('EXECUTOR_UNAVAILABLE');
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
    captionAuthorized: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    sitePermitted: vi.fn<(origin: string) => Promise<boolean>>().mockResolvedValue(true),
    permitted: vi.fn<(baseUrl: string) => Promise<boolean>>().mockResolvedValue(true),
    deliver: vi.fn<TaskPlatform['deliver']>().mockResolvedValue(true),
    progress: vi.fn(async () => {}),
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

const lookupValue = {
  detectedLanguage: 'en',
  meanings: [{ partOfSpeech: '名词', definition: '银行' }],
  example: null,
  note: null,
};
const lookupResult = {
  requested: true as const,
  durationMs: 10,
  algorithmVersion: 'lookup-v3',
  data: { purpose: 'lookup' as const, value: lookupValue },
};
function lookup(who: TaskOwner): Extract<TaskMessage, { type: 'learning.start' }> {
  return {
    type: 'learning.start',
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    payload: {
      clientTaskId: crypto.randomUUID(),
      documentNonce: who.documentNonce,
      purpose: 'lookup',
      origin: 'page',
      input: { text: 'bank', sourceLanguage: 'en', explanationLanguage: 'zh' },
    },
  };
}
function captions(who: TaskOwner): Extract<TaskMessage, { type: 'learning.start' }> {
  return {
    ...lookup(who),
    payload: {
      clientTaskId: crypto.randomUUID(),
      documentNonce: who.documentNonce,
      purpose: 'captions',
      origin: 'page',
      input: {
        sessionId: crypto.randomUUID(),
        generation: 1,
        videoId: 'public-video',
        trackKey: 'en:manual',
        batchId: crypto.randomUUID(),
        sourceLanguage: 'en',
        targetLanguage: 'zh',
        units: [{ unitId: 'u0', revision: 1, text: 'Hello.' }],
      },
    },
  };
}

describe('learning routes and permission lifetime', () => {
  it('delivers page lookup without write rights, source persistence, or duplicate dispatch', async () => {
    const f = await setup();
    const who = { ...owner(), siteOrigin: 'https://example.test' };
    const request = lookup(who);
    expect(await f.broker.handle(request, who)).toMatchObject({
      ok: true,
      data: { purpose: 'lookup', canApply: false },
    });
    await f.broker.handle(request, who);
    expect(f.dispatches()).toBe(1);
    expect(JSON.stringify(f.saved())).not.toMatch(/bank|银行/);
    const route = f.saved().routes[0]!;
    f.views.set(route.taskId, {
      taskId: route.taskId,
      purpose: 'lookup',
      state: 'ready',
      result: lookupResult,
    });
    await f.broker.reconcile();
    expect(f.platform.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'lookup' }),
      lookupResult,
      false,
    );
    expect(f.saved().routes[0]!.state).toBe('delivered');
    expect(SessionSchema.safeParse(f.saved()).success).toBe(true);
  });

  it.each(['translate', 'lookup'] as const)(
    'rejects a result of a different purpose for %s',
    async (purpose) => {
      const f = await setup();
      const who = { ...owner(), siteOrigin: 'https://example.test' };
      await f.broker.handle(purpose === 'lookup' ? lookup(who) : start(who), who);
      const route = f.saved().routes[0]!;
      f.views.set(route.taskId, {
        taskId: route.taskId,
        state: 'ready',
        result: purpose === 'lookup' ? result : lookupResult,
      });
      await f.broker.reconcile();
      expect(f.saved().routes[0]).toMatchObject({ state: 'failed', error: 'FORMAT_INVALID' });
      expect(f.platform.deliver).not.toHaveBeenCalled();
    },
  );

  it('checks caption authority both before preparing and immediately before dispatch', async () => {
    const f = await setup();
    const who = { ...owner(), siteOrigin: 'https://www.youtube.com' };
    f.platform.captionAuthorized.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await f.broker.handle(captions(who), who)).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(f.dispatches()).toBe(0);
    expect(f.saved().routes).toHaveLength(0);
  });

  it.each(['wrong-site', 'disabled-site', 'no-video-consent'])(
    'denies captions at %s before executor creation',
    async (scenario) => {
      const f = await setup();
      const who = {
        ...owner(),
        siteOrigin: scenario === 'wrong-site' ? 'https://example.test' : 'https://www.youtube.com',
      };
      if (scenario === 'disabled-site') f.platform.sitePermitted.mockResolvedValue(false);
      if (scenario === 'no-video-consent') f.platform.captionAuthorized.mockResolvedValue(false);
      expect(await f.broker.handle(captions(who), who)).toMatchObject({ ok: false });
      expect(f.host.start).not.toHaveBeenCalled();
    },
  );

  it.each(['revoked', 'stale-batch', 'valid'])(
    'gates completed captions against %s identity/authority',
    async (scenario) => {
      const f = await setup();
      const who = { ...owner(), siteOrigin: 'https://www.youtube.com' };
      await f.broker.handle(captions(who), who);
      const route = f.saved().routes[0]!;
      const value = {
        ...route.captionIdentity!,
        units: [{ unitId: 'u0', revision: 1, text: '你好。' }],
      };
      if (scenario === 'revoked') f.platform.captionAuthorized.mockResolvedValue(false);
      if (scenario === 'stale-batch') value.batchId = crypto.randomUUID();
      f.views.set(route.taskId, {
        taskId: route.taskId,
        state: 'ready',
        result: { ...lookupResult, data: { purpose: 'captions', value } },
      });
      await f.broker.reconcile();
      expect(f.saved().routes[0]!.state).toBe(scenario === 'valid' ? 'delivered' : 'canceled');
      expect(f.platform.deliver).toHaveBeenCalledTimes(scenario === 'valid' ? 1 : 0);
      if (scenario === 'valid') expect(f.platform.deliver.mock.calls[0]?.[2]).toBe(false);
    },
  );

  it('awaits caption cancellation before same-tab lookup and keeps other tabs independent', async () => {
    const f = await setup();
    const who = { ...owner(), siteOrigin: 'https://www.youtube.com' };
    await f.broker.handle(captions(who), who);
    const route = f.saved().routes[0]!;
    let release!: () => void;
    const canceled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.host.task.getMockImplementation()!;
    f.host.task.mockImplementation(async (...args) => {
      if (args[0] === 'cancel') await canceled;
      return original(...args);
    });
    const next = f.broker.handle(lookup(who), who);
    await vi.waitFor(() => expect(f.host.task).toHaveBeenCalledWith('cancel', route.taskId, epoch));
    expect(f.dispatches()).toBe(1);
    release();
    expect(await next).toMatchObject({ ok: true, data: { purpose: 'lookup' } });
    expect(f.dispatches()).toBe(2);
    expect(f.saved().routes[0]!.state).toBe('canceled');
  });

  it('does not start another paid task after a lost cancellation acknowledgement, including retries', async () => {
    const f = await setup();
    const who = { ...owner(), siteOrigin: 'https://www.youtube.com' };
    await f.broker.handle(captions(who), who);
    f.host.task.mockRejectedValue(new Error('LOST_ACK'));
    const request = lookup(who);
    for (let i = 0; i < 2; i++)
      expect(await f.broker.handle(request, who)).toMatchObject({ ok: false });
    expect(f.dispatches()).toBe(1);
    expect(f.saved().routes[0]!.state).toBe('running');
  });

  it('cancels captions on background recovery without replay or result delivery', async () => {
    const f = await setup();
    const who = { ...owner(), siteOrigin: 'https://www.youtube.com' };
    await f.broker.handle(captions(who), who);
    const restarted = await setup(f.saved());
    expect(restarted.saved().routes[0]).toMatchObject({ state: 'canceled', recovered: true });
    expect(restarted.host.start).not.toHaveBeenCalled();
    expect(restarted.platform.deliver).not.toHaveBeenCalled();
    expect(restarted.host.task).toHaveBeenCalledWith('cancel', f.saved().routes[0]!.taskId, epoch);
  });

  it('retains a cancel-pending slot after recovery failure until cancellation is confirmed', async () => {
    const f = await setup();
    const who = { ...owner(), siteOrigin: 'https://www.youtube.com' };
    await f.broker.handle(captions(who), who);
    const restarted = await setup(f.saved(), true);
    expect(restarted.saved().routes[0]).toMatchObject({ state: 'canceled', cancelPending: true });
    expect(SessionSchema.safeParse(restarted.saved()).success).toBe(true);
    expect(await restarted.broker.handle(lookup(who), who)).toMatchObject({ ok: false });
    expect(restarted.dispatches()).toBe(0);
    expect(restarted.platform.deliver).not.toHaveBeenCalled();
    const route = restarted.saved().routes[0]!;
    restarted.host.task.mockResolvedValue({ taskId: route.taskId, state: 'canceled' });
    expect(await restarted.broker.handle(lookup(who), who)).toMatchObject({ ok: true });
    expect(restarted.dispatches()).toBe(1);
    expect(restarted.saved().routes[0]).not.toHaveProperty('cancelPending');
  });

  it('preserves pending caption cancellation after failed delivery and configuration clearing', async () => {
    const f = await setup();
    const who = { ...owner(), siteOrigin: 'https://www.youtube.com' };
    await f.broker.handle(captions(who), who);
    const route = f.saved().routes[0]!;
    const ready: ExecutionView = {
      taskId: route.taskId,
      state: 'ready',
      result: {
        ...lookupResult,
        data: {
          purpose: 'captions',
          value: {
            ...route.captionIdentity!,
            units: [{ unitId: 'u0', revision: 1, text: '你好' }],
          },
        },
      },
    };
    f.host.task.mockImplementation(async (type) => {
      if (type === 'cancel') throw new Error('LOST_ACK');
      return ready;
    });
    f.platform.deliver.mockResolvedValue(false);
    await f.broker.reconcile();
    expect(f.saved().routes[0]).toMatchObject({ state: 'canceled', cancelPending: true });
    expect(SessionSchema.safeParse(f.saved()).success).toBe(true);
    await f.broker.clearAll(async () => {});
    expect(f.saved().routes[0]).toMatchObject({ state: 'canceled', cancelPending: true });
    expect(f.saved().manual).toEqual([]);
    expect(await f.broker.handle(lookup(who), who)).toMatchObject({ ok: false });
    expect(f.dispatches()).toBe(1);
  });

  it('restores typed manual lookup and clears results on changed input or purpose', async () => {
    const f = await setup();
    const who = { ...owner(), kind: 'manual' as const };
    const request = lookup(who);
    if (request.payload.purpose !== 'lookup') throw new Error('fixture');
    request.payload = {
      ...request.payload,
      origin: 'manual',
      tabId: who.tabId,
      manualRevision: 0,
      manualGeneration: await f.broker.manualGeneration(),
    };
    await f.broker.handle(request, who);
    const route = f.saved().routes[0]!;
    f.views.set(route.taskId, { taskId: route.taskId, state: 'ready', result: lookupResult });
    await f.broker.reconcile();
    expect(await f.broker.readManual(who.tabId)).toMatchObject({
      purpose: 'lookup',
      input: 'bank',
      lookupResult: lookupValue,
    });
    expect(f.saved().manual[0]).not.toHaveProperty('result');
    const restarted = await setup(f.saved());
    expect(await restarted.broker.readManual(who.tabId)).toMatchObject({
      lookupResult: lookupValue,
    });
    const save = {
      generation: await f.broker.manualGeneration(),
      tabId: who.tabId,
      expectedRevision: f.saved().manual[0]!.revision!,
      editSession: crypto.randomUUID(),
      sequence: 1,
      input: 'bank',
      sourceLanguage: 'en',
      targetLanguage: 'zh',
      purpose: 'lookup' as const,
    };
    await f.broker.saveManual(save);
    expect(f.saved().manual[0]!.lookupResult).toEqual(lookupValue);
    await f.broker.saveManual({ ...save, sequence: 2, input: 'river' });
    expect(f.saved().manual[0]).not.toHaveProperty('lookupResult');
    await f.broker.saveManual({ ...save, sequence: 3, purpose: 'translate', result: '' });
    expect(f.saved().manual[0]!.clientTaskId).not.toBe(route.clientTaskId);
    expect(f.saved().manual[0]).not.toHaveProperty('lookupResult');
    expect(SessionSchema.safeParse(f.saved()).success).toBe(true);
  });
});

describe('task ownership and durable dispatch', () => {
  it('holds dispatch while clearing, aborts active work and removes private session drafts', async () => {
    const f = await setup();
    const first = owner();
    const manual = { ...owner(), tabId: 2, kind: 'manual' as const };
    await f.broker.handle(start(first), first);
    await f.broker.handle(start(manual), manual);
    expect(JSON.stringify(f.saved())).toContain('PRIVATE_SOURCE_TEXT');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const clear = f.broker.clearAll(async () => {
      await gate;
      f.repository.completionConfig.mockRejectedValue(new Error('CONFIG_REQUIRED'));
      return 'cleared';
    });
    const next = { ...owner(), tabId: 3 };
    const queued = f.broker.handle(start(next), next);
    expect(f.dispatches()).toBe(2);
    release();
    expect(await clear).toBe('cleared');
    expect(await queued).toEqual({ ok: false, error: 'CONFIG_REQUIRED' });
    expect(f.saved()).toEqual({
      version: 1,
      routes: [],
      canceled: [],
      manual: [],
      manualGeneration: expect.any(String),
    });
    expect(f.host.task.mock.calls.filter(([type]) => type === 'cancel')).toHaveLength(2);
    expect(f.dispatches()).toBe(2);
  });
  it('does not cancel tasks or lose drafts if configuration deletion fails', async () => {
    const f = await setup();
    const who = owner();
    await f.broker.handle(start(who), who);
    const before = f.saved();
    await expect(
      f.broker.clearAll(async () => {
        throw new Error('CONFLICT');
      }),
    ).rejects.toThrow('CONFLICT');
    expect(f.saved()).toEqual(before);
    expect(f.host.task).not.toHaveBeenCalled();
  });
  it('reports an incomplete session deletion while still aborting work and closing the executor', async () => {
    const f = await setup();
    const who = owner();
    await f.broker.handle(start(who), who);
    f.storage.write.mockRejectedValue(new Error('SESSION_WRITE_FAILED'));
    await expect(f.broker.clearAll(async () => 'keys-cleared')).rejects.toThrow(
      'SESSION_WRITE_FAILED',
    );
    expect(f.host.task).toHaveBeenCalledWith('cancel', expect.any(String), epoch);
    expect(f.host.closeIfIdle).toHaveBeenCalled();
  });

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

it.each(['read', 'write'] as const)(
  'checks %s website opt-in before executor creation and again before dispatch',
  async (mode) => {
    const f = await setup();
    const who = { ...owner(), siteOrigin: 'https://site.example' };
    const request = start(who);
    request.payload =
      mode === 'write'
        ? { ...request.payload, entry: 'inline' }
        : {
            clientTaskId: request.payload.clientTaskId,
            documentNonce: who.documentNonce,
            entry: 'inline',
            mode: 'read',
            scope: 'selection',
            source: { kind: 'dom-selection', text: 'Hello', protectedRanges: [], marks: [] },
            sourceLanguage: 'auto',
            targetLanguage: 'zh-Hans',
          };
    f.platform.sitePermitted.mockResolvedValue(false);
    expect(await f.broker.handle(request, who)).toEqual({ ok: false, error: 'SITE_DISABLED' });
    expect(f.host.start).not.toHaveBeenCalled();
    f.platform.sitePermitted.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await f.broker.handle(request, who)).toEqual({ ok: false, error: 'SITE_DISABLED' });
    expect(f.dispatches()).toBe(0);
    expect(f.saved().routes).toEqual([]);
  },
);
it('saves immediately dispatched draft edits in sequence and rejects stale competing windows', async () => {
  const f = await setup();
  const base = {
    generation: await f.broker.manualGeneration(),
    tabId: 1,
    input: 'first',
    result: '',
    targetLanguage: 'en',
    editSession: crypto.randomUUID(),
    sequence: 1,
    expectedRevision: 0,
  };
  await f.broker.saveManual(base);
  await f.broker.saveManual({ ...base, sequence: 3, input: 'newest' });
  await f.broker.saveManual({ ...base, sequence: 2, input: 'stale' });
  expect((await f.broker.readManual(1))?.input).toBe('newest');
  const saved = await f.broker.readManual(1);
  expect(saved).not.toHaveProperty('editSession');
  await f.broker.saveManual({
    ...base,
    editSession: crypto.randomUUID(),
    expectedRevision: saved!.revision,
    input: 'another window',
  });
  await expect(
    f.broker.saveManual({ ...base, sequence: 4, input: 'late old window' }),
  ).rejects.toThrow('CONFLICT');
  expect(f.dispatches()).toBe(0);
});
it('rotates draft generation on clear and prevents old windows from resurrecting cleared text', async () => {
  const f = await setup();
  const old = {
    generation: await f.broker.manualGeneration(),
    tabId: 1,
    input: 'private draft',
    result: '',
    targetLanguage: 'en',
    editSession: crypto.randomUUID(),
    sequence: 1,
    expectedRevision: 0,
  };
  await f.broker.saveManual(old);
  await f.broker.clearAll(async () => undefined);
  await expect(f.broker.saveManual({ ...old, sequence: 2 })).rejects.toThrow('CONFLICT');
  expect(await f.broker.readManual(1)).toBeNull();
  expect(await f.broker.manualGeneration()).not.toBe(old.generation);
});
it('preserves the prior draft after a session write fails', async () => {
  const f = await setup();
  const base = {
    generation: await f.broker.manualGeneration(),
    tabId: 1,
    input: 'kept draft',
    result: '',
    targetLanguage: 'en',
    editSession: crypto.randomUUID(),
    sequence: 1,
    expectedRevision: 0,
  };
  await f.broker.saveManual(base);
  f.storage.write.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(
    f.broker.saveManual({ ...base, sequence: 2, input: 'failed change' }),
  ).rejects.toThrow();
  expect((await f.broker.readManual(1))?.input).toBe('kept draft');
});

it('persists an accepted long manual language without poisoning unrelated session writes', async () => {
  const f = await setup();
  const originalWrite = f.storage.write.getMockImplementation()!;
  f.storage.write.mockImplementation(async (state) => {
    SessionSchema.parse(state);
    return originalWrite(state);
  });
  const manual = { ...owner(), kind: 'manual' as const };
  const request = start(manual);
  request.payload.targetLanguage = 'English for technical documentation';
  expect(await f.broker.handle(request, manual)).toMatchObject({
    ok: true,
    data: { state: 'running' },
  });
  expect(f.saved().manual[0]!.targetLanguage).toBe(request.payload.targetLanguage);
  const other = { ...owner(), tabId: 2 };
  expect(await f.broker.handle(start(other), other)).toMatchObject({
    ok: true,
    data: { state: 'running' },
  });
  expect(f.dispatches()).toBe(2);
});

it('allows an incomplete blank language draft without weakening the eventual start schema', async () => {
  const f = await setup();
  await f.broker.saveManual({
    generation: await f.broker.manualGeneration(),
    tabId: 1,
    input: 'kept input',
    result: '',
    targetLanguage: '',
    editSession: crypto.randomUUID(),
    sequence: 1,
    expectedRevision: 0,
  });
  expect(SessionSchema.safeParse(f.saved()).success).toBe(true);
  expect((await f.broker.readManual(1))?.targetLanguage).toBe('');
});

it.each(['ja', undefined])(
  'preserves manual source language %s through saving and task start',
  async (sourceLanguage) => {
    const f = await setup();
    const who: TaskOwner = { ...owner(), kind: 'manual' };
    const generation = await f.broker.manualGeneration();
    await f.broker.saveManual({
      generation,
      tabId: who.tabId,
      input: 'PRIVATE_SOURCE_TEXT',
      result: '',
      targetLanguage: 'en',
      ...(sourceLanguage ? { sourceLanguage } : {}),
      editSession: crypto.randomUUID(),
      sequence: 1,
      expectedRevision: 0,
    });
    const saved = (await f.broker.readManual(who.tabId))!;
    expect(saved.sourceLanguage).toBe(sourceLanguage ?? 'auto');
    const request = start(who);
    Object.assign(request.payload, {
      sourceLanguage: sourceLanguage ?? 'auto',
      manualGeneration: generation,
      manualRevision: saved.revision,
    });
    expect(await f.broker.handle(request, who)).toMatchObject({ ok: true });
    expect((await f.broker.readManual(who.tabId))?.sourceLanguage).toBe(sourceLanguage ?? 'auto');
    expect(() => SessionSchema.parse(f.saved())).not.toThrow();
  },
);

describe('ephemeral stream routing', () => {
  it('routes only newer progress, never persists partial text and ignores late chunks after cancel', async () => {
    const f = await setup(),
      who = owner(),
      request = start(who);
    const response = await f.broker.handle(request, who);
    expect(response.ok).toBe(true);
    const id = f.saved().routes[0]!.taskId;
    const progress = {
      text: 'PRIVATE_PARTIAL_OUTPUT',
      elapsedMs: 100,
      phase: 'translating' as const,
      estimates: { inputTokens: 20, outputTokens: 3 },
    };
    f.views.set(id, { taskId: id, state: 'running', progress });
    const writes = f.storage.write.mock.calls.length;
    await f.broker.reconcile(true);
    expect(f.platform.progress).toHaveBeenCalledTimes(1);
    expect(f.storage.write.mock.calls.length).toBe(writes);
    expect(JSON.stringify(f.saved())).not.toContain(progress.text);
    await f.broker.reconcile(true);
    expect(f.platform.progress).toHaveBeenCalledTimes(1);
    await f.broker.handle(control(request, 'translation.cancel'), who);
    f.views.set(id, { taskId: id, state: 'running', progress: { ...progress, elapsedMs: 200 } });
    await f.broker.reconcile(true);
    expect(f.platform.progress).toHaveBeenCalledTimes(1);
    expect(f.saved().routes[0]!.state).toBe('canceled');
  });
  it('returns ephemeral progress to the owning manual popup and retains only final usage', async () => {
    const f = await setup(),
      who = { ...owner(), kind: 'manual' as const },
      request = start(who);
    const response = await f.broker.handle(request, who),
      id = f.saved().routes[0]!.taskId;
    expect(response.ok).toBe(true);
    const progress = {
      text: 'MANUAL_PARTIAL',
      elapsedMs: 100,
      phase: 'translating' as const,
      estimates: { inputTokens: 20, outputTokens: 3 },
    };
    f.views.set(id, { taskId: id, state: 'running', progress });
    expect((await f.broker.readManual(who.tabId))?.task?.progress?.text).toBe('MANUAL_PARTIAL');
    expect(JSON.stringify(f.saved())).not.toContain('MANUAL_PARTIAL');
    expect(await f.broker.readManual(who.tabId + 1)).toBeNull();
    f.views.set(id, {
      taskId: id,
      state: 'ready',
      result: { ...result, usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } },
    });
    const final = await f.broker.readManual(who.tabId);
    expect(final?.task?.progress).toBeUndefined();
    expect(final?.metrics?.usage?.totalTokens).toBe(20);
    expect(SessionSchema.safeParse(f.saved()).success).toBe(true);
  });
});
