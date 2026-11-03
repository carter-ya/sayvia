import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
  runtime: {
    id: 'self',
    getURL: (path: string) => `chrome-extension://self${path}`,
    onMessage: { addListener: vi.fn() },
  },
  permissions: {
    contains: vi.fn(async () => true),
    onAdded: { addListener: vi.fn() },
    onRemoved: { addListener: vi.fn() },
  },
  scripting: {
    getRegisteredContentScripts: vi.fn(async (): Promise<Array<{ id: string }>> => []),
    registerContentScripts: vi.fn(async () => {}),
    updateContentScripts: vi.fn(async () => {}),
    unregisterContentScripts: vi.fn(async () => {}),
    executeScript: vi.fn(
      async (): Promise<Array<{ documentId: string; frameId: number; result: unknown }>> => [
        { documentId: 'doc', frameId: 0, result: 'https://www.youtube.com/watch?v=example' },
      ],
    ),
  },
  tabs: {
    query: vi.fn(async (): Promise<Array<{ id: number }>> => []),
    sendMessage: vi.fn(async (): Promise<unknown> => ({ ok: true })),
    onRemoved: { addListener: vi.fn() },
    onUpdated: { addListener: vi.fn() },
  },
  storage: {
    local: {
      get: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
      set: vi.fn(async () => {}),
    },
  },
}));
vi.mock('wxt/browser', () => ({ browser: api }));
import { installCaptions } from '../../src/background/captions';
import { emptyState } from '../../src/storage/schema';
import type { ConfigRepository } from '../../src/storage/repository';
import type { MessageSender } from '../../src/background/task-router';
let access: ReturnType<typeof installCaptions>;
const cancelWhere = vi.fn(async () => {});
const snapshot = vi.fn<ConfigRepository['snapshot']>();
const onCaptionConfigurationChange = vi.fn<ConfigRepository['onCaptionConfigurationChange']>(
  () => () => {},
);
const options = {
  id: 'self',
  url: 'chrome-extension://self/options.html',
  origin: new URL('chrome-extension://self/').origin,
} as MessageSender;
const owner = {
  id: 'self',
  url: 'https://www.youtube.com/watch?v=example',
  origin: 'https://www.youtube.com',
  tab: { id: 1 },
  frameId: 0,
  documentId: 'doc',
  documentLifecycle: 'active',
} as MessageSender;
const nonce = crypto.randomUUID();
function send(type: string, sender: MessageSender, fields = {}) {
  return new Promise<Record<string, unknown>>((resolve) => {
    api.runtime.onMessage.addListener.mock.calls[0]![0](
      { type, protocolVersion: 1, requestId: crypto.randomUUID(), ...fields },
      sender,
      resolve,
    );
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  api.permissions.contains.mockResolvedValue(true);
  api.tabs.query.mockResolvedValue([]);
  api.scripting.getRegisteredContentScripts.mockResolvedValue([]);
  api.storage.local.get.mockResolvedValue({});
  api.scripting.executeScript.mockResolvedValue([
    { documentId: 'doc', frameId: 0, result: 'https://www.youtube.com/watch?v=example' },
  ]);
  api.tabs.sendMessage.mockResolvedValue({ ok: true });
  snapshot.mockResolvedValue({ revision: 0, providers: [], preferences: emptyState().preferences });
  access = installCaptions({ cancelWhere }, { snapshot, onCaptionConfigurationChange });
  await access.ready;
});
it('only trusts the settings document to persist and register separate MAIN/ISOLATED document-start scripts', async () => {
  expect((await send('captions.settings.set', owner, { enabled: true })).ok).toBe(false);
  const result = await send('captions.settings.set', options, { enabled: true });
  expect(result.ok).toBe(true);
  expect(api.storage.local.set).toHaveBeenCalledWith({ 'sayvia.youtube-captions-enabled': true });
  expect(api.scripting.registerContentScripts).toHaveBeenCalledWith([
    expect.objectContaining({
      world: 'MAIN',
      runAt: 'document_start',
      matches: ['https://www.youtube.com/*'],
      allFrames: false,
    }),
  ]);
  expect(api.scripting.registerContentScripts).toHaveBeenCalledWith([
    expect.objectContaining({ world: 'ISOLATED', runAt: 'document_start' }),
  ]);
});
it('uses browser document IDs for confirmation and cannot be enabled by a bridge-shaped or wrong-frame message', async () => {
  await access.setEnabled(true);
  expect(
    (await send('captions.ensure', { ...owner, frameId: 1 }, { documentNonce: nonce })).ok,
  ).toBe(false);
  expect((await send('captions.ensure', owner, { documentNonce: nonce, tabId: 999 })).ok).toBe(
    false,
  );
  const result = await send('captions.ensure', owner, { documentNonce: nonce });
  expect(result.enabled).toBe(true);
  expect(api.scripting.executeScript).toHaveBeenCalledWith(
    expect.objectContaining({ target: { tabId: 1, documentIds: ['doc'] }, world: 'MAIN' }),
  );
  api.permissions.contains.mockResolvedValue(false);
  expect((await send('captions.ensure', owner, { documentNonce: nonce })).enabled).toBe(false);
});
it('denies translation grants on a changed browser video and never accepts client-supplied ownership', async () => {
  await access.setEnabled(true);
  const fields = {
    documentNonce: nonce,
    track: { videoId: 'example', lang: 'en', kind: null, name: null, tlang: null },
    captureGeneration: crypto.randomUUID(),
  };
  api.scripting.executeScript.mockResolvedValueOnce([
    { documentId: 'doc', frameId: 0, result: 'https://www.youtube.com/watch?v=other' },
  ]);
  expect((await send('captions.grant', owner, fields)).ok).toBe(false);
  const granted = await send('captions.grant', owner, fields);
  expect(granted.ok).toBe(true);
  expect(granted.session).toMatchObject({ videoId: 'example', generation: 0 });
  expect((await send('captions.grant', options, fields)).ok).toBe(false);
});
it('reports an unconfirmed document separately from successfully unregistered scripts', async () => {
  await access.setEnabled(true);
  await send('captions.ensure', owner, { documentNonce: nonce });
  api.scripting.getRegisteredContentScripts.mockResolvedValue([
    { id: 'sayvia-youtube-capture-v1' },
    { id: 'sayvia-youtube-controller-v1' },
  ]);
  api.scripting.executeScript.mockRejectedValue(new Error('frozen/unreachable'));
  const disabled = await access.setEnabled(false);
  expect(disabled).toMatchObject({
    desiredEnabled: false,
    registered: false,
    unconfirmedDocuments: 1,
  });
  expect(api.scripting.unregisterContentScripts).toHaveBeenCalled();
  expect(cancelWhere).toHaveBeenCalled();
});
it('registers no capture when host permission is absent and cleans obsolete script versions', async () => {
  api.scripting.getRegisteredContentScripts.mockResolvedValue([
    { id: 'sayvia-youtube-old' },
    { id: 'unrelated' },
  ]);
  api.permissions.contains.mockResolvedValue(false);
  expect(await access.setEnabled(true)).toMatchObject({ registered: false, error: true });
  expect(api.scripting.unregisterContentScripts).toHaveBeenCalledWith({
    ids: ['sayvia-youtube-old'],
  });
  expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());
it.each([false, true])(
  'compensates a late MAIN injection after disable (reply timed out: %s)',
  async (timeout) => {
    vi.useFakeTimers();
    await access.setEnabled(true);
    const injected = deferred<void>();
    let capturing = false;
    api.scripting.executeScript.mockImplementation(async (details?: unknown) => {
      const value = details as { files?: string[]; world?: string };
      if (value.files) {
        await injected.promise;
        capturing = true;
        return [{ documentId: 'doc', frameId: 0, result: undefined }];
      }
      if (value.world === 'MAIN') {
        capturing = false;
        return [{ documentId: 'doc', frameId: 0, result: true }];
      }
      return [{ documentId: 'doc', frameId: 0, result: 'https://www.youtube.com/watch?v=example' }];
    });
    const ensure = send('captions.ensure', owner, { documentNonce: nonce });
    await vi.waitFor(() =>
      expect(api.scripting.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({ files: expect.anything() }),
      ),
    );
    if (timeout) {
      await vi.advanceTimersByTimeAsync(2100);
      expect((await ensure).ok).toBe(false);
    }
    const disabled = await access.setEnabled(false);
    expect(disabled).toMatchObject({ registered: false, unconfirmedDocuments: 1 });
    injected.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await ensure;
    expect(capturing).toBe(false);
  },
);
it('does not pass unregister until a slow persistent registration has actually completed', async () => {
  vi.useFakeTimers();
  const registered = new Set<string>();
  const pending = deferred<void>();
  let first = true;
  api.scripting.getRegisteredContentScripts.mockImplementation(async () =>
    [...registered].map((id) => ({ id })),
  );
  api.scripting.registerContentScripts.mockImplementation(async (scripts?: unknown) => {
    if (first) {
      first = false;
      await pending.promise;
    }
    for (const item of scripts as Array<{ id: string }>) registered.add(item.id);
  });
  api.scripting.unregisterContentScripts.mockImplementation(async (filter?: unknown) => {
    for (const id of (filter as { ids: string[] }).ids) registered.delete(id);
  });
  const enable = access.setEnabled(true);
  await vi.waitFor(() => expect(api.scripting.registerContentScripts).toHaveBeenCalled());
  let disabled = false;
  const disable = access.setEnabled(false).then((value) => {
    disabled = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(2500);
  expect(disabled).toBe(false);
  expect(access.status().registered).toBe(false);
  pending.resolve();
  await Promise.all([enable, disable]);
  expect(registered.size).toBe(0);
  expect(access.status().desiredEnabled).toBe(false);
});

it('restoring permission reinjects existing documents instead of stopping them under a stale error', async () => {
  api.permissions.contains.mockResolvedValue(false);
  await access.setEnabled(true);
  expect(access.status().error).toBe(true);
  api.permissions.contains.mockResolvedValue(true);
  api.tabs.query.mockResolvedValue([{ id: 1 }]);
  api.scripting.executeScript.mockImplementation(async (details?: unknown) => {
    const value = details as { files?: string[]; world?: string };
    return [
      {
        documentId: 'doc',
        frameId: 0,
        result: value.files ? undefined : value.world === 'MAIN' ? true : 'https://www.youtube.com',
      },
    ];
  });
  await access.reconcile();
  expect(api.scripting.executeScript).toHaveBeenCalledWith(
    expect.objectContaining({ files: ['/content-scripts/youtube-capture.js'] }),
  );
  expect(api.scripting.executeScript).toHaveBeenCalledWith(
    expect.objectContaining({ files: ['/content-scripts/youtube-controller.js'] }),
  );
  expect(access.status()).toMatchObject({ registered: true, error: false });
});

it('only returns the selected public model identity to enabled current YouTube documents', async () => {
  const provider = { id: crypto.randomUUID(), revision: 3, model: 'selected-model' };
  snapshot.mockResolvedValue({
    revision: 1,
    providers: [
      {
        ...provider,
        hasApiKey: true,
        baseUrl: 'https://private-endpoint.test',
        name: 'private-label',
        secretRef: 'must-not-leak',
      },
    ],
    preferences: { defaultProviderId: provider.id, readTarget: 'zh-CN' },
  } as unknown as Awaited<ReturnType<ConfigRepository['snapshot']>>);
  const fields = { documentNonce: nonce };
  expect(await send('captions.configuration', owner, fields)).toMatchObject({ ok: false });
  expect(snapshot).not.toHaveBeenCalled();
  await access.setEnabled(true);
  expect(await send('captions.configuration', owner, fields)).toEqual({
    ok: true,
    provider,
    targetLanguage: 'zh-CN',
  });
  snapshot.mockClear();
  for (const sender of [
    options,
    { ...owner, frameId: 1 },
    { ...owner, origin: 'https://other.test' },
  ])
    expect(await send('captions.configuration', sender, fields)).toMatchObject({ ok: false });
  expect(snapshot).not.toHaveBeenCalled();
  api.permissions.contains.mockResolvedValue(false);
  expect(await send('captions.configuration', owner, fields)).toMatchObject({ ok: false });
  expect(snapshot).not.toHaveBeenCalled();
});
it('does not fall back to another provider when the current default is unconfigured', async () => {
  await access.setEnabled(true);
  snapshot.mockResolvedValue({
    revision: 0,
    providers: [{ id: crypto.randomUUID(), hasApiKey: true }],
    preferences: { defaultProviderId: crypto.randomUUID(), readTarget: 'zh-CN' },
  } as unknown as Awaited<ReturnType<ConfigRepository['snapshot']>>);
  expect(await send('captions.configuration', owner, { documentNonce: nonce })).toEqual({
    ok: false,
    error: 'CONFIG_REQUIRED',
  });
});

it('configuration changes revoke current video consent before sending a document-scoped notification', async () => {
  await access.setEnabled(true);
  const reply = await send('captions.grant', owner, {
    documentNonce: nonce,
    track: { videoId: 'example', lang: 'en', kind: null, name: null, tlang: null },
    captureGeneration: crypto.randomUUID(),
  });
  expect(reply.ok).toBe(true);
  const change = onCaptionConfigurationChange.mock.calls[0]![0];
  change();
  expect(api.tabs.sendMessage).toHaveBeenCalledWith(
    1,
    { protocolVersion: 1, type: 'captions.configuration-changed' },
    { documentId: 'doc', frameId: 0 },
  );
  expect(
    await send('captions.check', owner, { documentNonce: nonce, session: reply.session }),
  ).toMatchObject({ authorized: false, enabled: true });
});
