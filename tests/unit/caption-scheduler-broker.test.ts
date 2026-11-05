import { afterEach, expect, it, vi } from 'vitest';
import { TaskBroker, type TaskOwner } from '../../src/background/task-broker';
import { ConfigRepository } from '../../src/storage/repository';
import { SessionSchema, type TaskMessage, type TaskSession } from '../../src/runtime/task-protocol';
import type { Execution, ExecutionView } from '../../src/runtime/executor-protocol';
import { CaptionScheduler } from '../../src/captions/scheduler';
import { CAPTION_VERSION } from '../../src/core/learning-processor';
const flush = () => new Promise<void>((r) => setImmediate(r));
const all: CaptionScheduler[] = [];
afterEach(async () => {
  for (const s of all.splice(0)) await s.stop();
});
async function fixture(immediate = true) {
  const repository = new ConfigRepository({
    restrictAccess: async () => {},
    read: async () => undefined,
    write: async () => {},
  });
  const config = await repository.save({
    expectedRevision: 0,
    name: 'fixture',
    kind: 'openai',
    baseUrl: 'https://model.example/v1',
    model: 'fixture-model',
    makeDefault: true,
    key: { action: 'set', value: 'FAKE_KEY' },
  });
  const provider = config.providers[0]!;
  const owner: TaskOwner = {
    kind: 'page',
    tabId: 1,
    frameId: 0,
    documentId: crypto.randomUUID(),
    documentNonce: crypto.randomUUID(),
    siteOrigin: 'https://www.youtube.com',
  };
  let saved: TaskSession = { version: 1, routes: [], canceled: [], manual: [] };
  const storage = {
    read: async () => saved,
    write: async (s: TaskSession) => {
      saved = SessionSchema.parse(s);
    },
  };
  const views = new Map<string, ExecutionView>();
  const inputs = new Map<string, Execution>();
  const ready = (execution: Execution): ExecutionView => {
    if (!('purpose' in execution) || execution.purpose !== 'captions')
      throw new Error('unexpected');
    const { sessionId, generation, videoId, trackKey, batchId, units } = execution.input;
    const identity = { sessionId, generation, videoId, trackKey, batchId, units };
    return {
      taskId: execution.taskId,
      state: 'ready',
      result: {
        requested: true,
        durationMs: 3,
        algorithmVersion: CAPTION_VERSION,
        data: {
          purpose: 'captions',
          value: { ...identity, units: identity.units.map((u) => ({ ...u, text: '已翻译' })) },
        },
      },
    };
  };
  const host = {
    start: vi.fn(async (prepare: (epoch: string) => Promise<Execution>) => {
      const input = await prepare(crypto.randomUUID());
      inputs.set(input.taskId, input);
      const view: ExecutionView =
        immediate && 'purpose' in input && input.purpose === 'captions'
          ? ready(input)
          : { taskId: input.taskId, state: 'running' };
      views.set(input.taskId, view);
      return view;
    }),
    task: vi.fn(async (type: 'query' | 'cancel' | 'ack', id: string) => {
      const view = views.get(id);
      if (!view) return { taskId: id, state: 'missing' as const };
      if (type !== 'query') {
        view.state = type === 'cancel' ? 'canceled' : 'delivered';
        delete view.result;
      }
      return structuredClone(view);
    }),
    closeIfIdle: vi.fn(async () => {}),
  };
  const broker: TaskBroker = new TaskBroker(storage, repository, host, {
    permitted: async () => true,
    sitePermitted: async () => true,
    captionAuthorized: async () => true,
    deliver: async (route, result) =>
      scheduler.receive({
        protocolVersion: 1,
        type: 'learning.result',
        taskId: route.taskId,
        clientTaskId: route.clientTaskId,
        documentNonce: route.documentNonce,
        canApply: false,
        provider: { id: route.providerId, revision: route.providerRevision, model: route.model },
        result,
      }),
    notify: async (route) => {
      if (route.purpose === 'captions')
        scheduler.receive({
          protocolVersion: 1,
          type: 'learning.state',
          taskId: route.taskId,
          clientTaskId: route.clientTaskId,
          documentNonce: route.documentNonce,
          state: route.state,
          error: route.error,
          cancelPending: route.cancelPending === true,
          ...(route.cancelReason ? { cancelReason: route.cancelReason } : {}),
        });
    },
  });
  await broker.ready;
  let now = 0;
  const request = vi.fn((r: Record<string, unknown>) =>
    broker.handle(r as unknown as Exclude<TaskMessage, { type: 'translation.manual.read' }>, owner),
  );
  const scheduler: CaptionScheduler = new CaptionScheduler(
    {
      session: {
        sessionId: crypto.randomUUID(),
        generation: 0,
        videoId: 'video',
        trackKey: 'track',
        captureGeneration: crypto.randomUUID(),
      },
      provider: { id: provider.id, revision: provider.revision, model: provider.model },
      documentNonce: owner.documentNonce,
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
    },
    [
      {
        unitId: 'g',
        revision: 0,
        start: 0,
        end: 5000,
        windowId: '1',
        text: 'hello',
        sources: [{ id: 's', revision: 0 }],
      },
    ],
    { request, now: () => now },
  );
  all.push(scheduler);
  const advance = async () => {
    now += 1100;
    scheduler.tick(0);
    await flush();
  };
  return {
    scheduler,
    broker,
    repository,
    config,
    host,
    request,
    owner,
    views,
    inputs,
    ready,
    advance,
    saved: () => saved,
  };
}
it('accepts real broker delivery before START resolves, while the configuration reservation remains deadlock-free', async () => {
  const f = await fixture();
  f.scheduler.start();
  await vi.waitFor(() => expect(f.scheduler.snapshot().translated).toBe(1));
  expect(f.scheduler.visible(1000)[0]!.translation).toBe('已翻译');
  expect(f.saved().routes[0]!.state).toBe('delivered');
  await f.advance();
  expect(f.host.start).toHaveBeenCalledTimes(1);
});
it('waits behind an explicit lookup and restarts only the confirmed preemption with fresh attempt IDs', async () => {
  const f = await fixture(false);
  f.scheduler.start();
  await flush();
  const old = f.saved().routes[0]!;
  const lookup: Extract<TaskMessage, { type: 'learning.start' }> = {
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    type: 'learning.start',
    payload: {
      purpose: 'lookup',
      origin: 'page',
      clientTaskId: crypto.randomUUID(),
      documentNonce: f.owner.documentNonce,
      input: { text: 'hello', sourceLanguage: 'en', explanationLanguage: 'zh-CN' },
    },
  };
  expect(await f.broker.handle(lookup, f.owner)).toMatchObject({ ok: true });
  await f.advance();
  expect(f.scheduler.snapshot().state).toBe('waiting');
  expect(f.host.start).toHaveBeenCalledTimes(2);
  await f.broker.handle(
    {
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      type: 'translation.cancel',
      payload: { clientTaskId: lookup.payload.clientTaskId, documentNonce: f.owner.documentNonce },
    },
    f.owner,
  );
  await f.advance();
  expect(f.host.start).toHaveBeenCalledTimes(3);
  const latest = f.saved().routes.at(-1)!;
  expect(latest.clientTaskId).not.toBe(old.clientTaskId);
  expect(latest.captionIdentity!.batchId).not.toBe(old.captionIdentity!.batchId);
  f.views.set(latest.taskId, f.ready(f.inputs.get(latest.taskId)!));
  await f.broker.reconcile();
  expect(f.scheduler.snapshot().translated).toBe(1);
});
it('does not accept a result after the actual default configuration changes', async () => {
  const f = await fixture(false);
  f.scheduler.start();
  await flush();
  const route = f.saved().routes[0]!;
  await f.repository.save({
    expectedRevision: f.config.revision,
    name: 'new',
    kind: 'openai',
    baseUrl: 'https://model.example/v1',
    model: 'other-model',
    makeDefault: true,
    key: { action: 'set', value: 'OTHER_FAKE_KEY' },
  });
  f.views.set(route.taskId, f.ready(f.inputs.get(route.taskId)!));
  await f.broker.reconcile();
  expect(f.scheduler.snapshot()).toMatchObject({ state: 'paused', translated: 0 });
  await f.advance();
  expect(f.host.start).toHaveBeenCalledTimes(1);
});
