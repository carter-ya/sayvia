import { describe, expect, it, vi } from 'vitest';
import type { ConfigRepository } from '../../src/storage/repository';
import type { TaskBroker } from '../../src/background/task-broker';
import type { MessageSender } from '../../src/background/task-router';
import type { ConnectionIdentity } from '../../src/runtime/connection-test';
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'self',
      getURL: (path: string) => `chrome-extension://self${path}`,
    },
  },
}));
import { handleConnectionTest } from '../../src/background/connection-test';
const sender: MessageSender = {
  id: 'self',
  origin: new URL('chrome-extension://self/').origin,
  url: 'chrome-extension://self/options.html',
  tab: { id: 17 },
} as MessageSender;
function fixture() {
  const identity: ConnectionIdentity = {
    providerId: crypto.randomUUID(),
    providerRevision: 2,
    clientTaskId: crypto.randomUUID(),
    documentNonce: crypto.randomUUID(),
  };
  const task = {
    taskId: crypto.randomUUID(),
    clientTaskId: identity.clientTaskId,
    documentNonce: identity.documentNonce,
    state: 'running' as const,
    canApply: false,
    provider: { id: identity.providerId, revision: 2, model: 'test-model' },
  };
  const repository = {
    snapshot: vi.fn<ConfigRepository['snapshot']>().mockResolvedValue({
      revision: 4,
      preferences: {
        readTarget: 'zh-Hans',
        writeTarget: 'en',
        quickReplace: false,
        theme: 'system',
      },
      providers: [
        {
          id: identity.providerId,
          name: 'Test',
          kind: 'openai',
          baseUrl: 'https://example.test',
          model: 'test-model',
          revision: 2,
          protocol: 'chat-completions',
          hasApiKey: true,
        },
      ],
    }),
  };
  const broker = {
    handle: vi.fn<TaskBroker['handle']>().mockResolvedValue({ ok: true, data: task }),
    readManual: vi.fn<TaskBroker['readManual']>().mockResolvedValue({
      tabId: 17,
      clientTaskId: identity.clientTaskId,
      documentNonce: identity.documentNonce,
      input: 'Hello from Sayvia.',
      task,
    }),
  };
  const request = (action = 'start', payload = identity) => ({
    type: `settings.test.${action}`,
    payload,
  });
  return {
    identity,
    task,
    repository,
    broker,
    request,
    run: (action = 'start') => handleConnectionTest(request(action), sender, repository, broker),
  };
}
describe('saved-provider connection testing', () => {
  it('uses a fixed public sample, browser-derived tab and pinned saved provider revision', async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({
      ok: true,
      data: { state: 'running', providerRevision: 2 },
    });
    expect(f.broker.handle).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'translation.start',
        payload: expect.objectContaining({
          source: { kind: 'plain-text', text: 'Hello from Sayvia.' },
          providerId: f.identity.providerId,
        }),
      }),
      { tabId: 17, frameId: 0, documentNonce: f.identity.documentNonce, kind: 'manual' },
      2,
    );
  });
  it('rejects page and popup senders, extra configuration and stale revisions before network dispatch', async () => {
    const f = fixture();
    for (const url of ['https://example.test', 'chrome-extension://self/popup.html'])
      expect(
        await handleConnectionTest(f.request(), { ...sender, url }, f.repository, f.broker),
      ).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(
      await handleConnectionTest(
        { ...f.request(), payload: { ...f.identity, apiKey: 'not-accepted' } },
        sender,
        f.repository,
        f.broker,
      ),
    ).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(
      await handleConnectionTest(
        f.request('start', { ...f.identity, providerRevision: 1 }),
        sender,
        f.repository,
        f.broker,
      ),
    ).toEqual({ ok: false, error: 'CONFLICT' });
    expect(f.broker.handle).not.toHaveBeenCalled();
  });
  it('does not mistake another task or nonce for this configuration test', async () => {
    const f = fixture();
    const draft = (await f.broker.readManual(17))!;
    f.broker.readManual.mockResolvedValue({ ...draft, documentNonce: crypto.randomUUID() });
    expect(await f.run('status')).toEqual({ ok: false, error: 'NOT_FOUND' });
  });
  it('reports a parsed successful result without returning generated text or credentials', async () => {
    const f = fixture();
    const draft = (await f.broker.readManual(17))!;
    f.broker.readManual.mockResolvedValue({
      ...draft,
      result: 'Do not return model text',
      task: { ...f.task, state: 'delivered' },
    });
    const result = await f.run('status');
    expect(result).toMatchObject({ ok: true, data: { state: 'passed' } });
    expect(JSON.stringify(result)).not.toContain('Do not return model text');
  });
  it('invalidates the old conclusion when configuration changes during execution', async () => {
    const f = fixture();
    const snapshot = await f.repository.snapshot();
    f.repository.snapshot.mockResolvedValueOnce(snapshot).mockResolvedValue({
      ...snapshot,
      providers: snapshot.providers.map((p) => ({ ...p, revision: 3 })),
    });
    expect(await f.run()).toMatchObject({ ok: true, data: { state: 'stale' } });
    expect(f.broker.handle).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'translation.cancel' }),
      expect.objectContaining({ tabId: 17 }),
    );
  });
  it('can cancel before START and preserves safe allowlisted failure codes', async () => {
    const f = fixture();
    expect(await f.run('cancel')).toMatchObject({ ok: true, data: { state: 'canceled' } });
    expect(f.broker.readManual).not.toHaveBeenCalled();
    f.broker.handle.mockResolvedValue({ ok: false, error: 'PERMISSION_DENIED' });
    expect(await f.run()).toEqual({ ok: false, error: 'PERMISSION_DENIED' });
  });
});
