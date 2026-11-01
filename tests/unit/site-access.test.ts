import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
  permissions: { contains: vi.fn(async () => true) },
  scripting: {
    getRegisteredContentScripts: vi.fn(async (): Promise<object[]> => []),
    registerContentScripts: vi.fn(async () => undefined),
    updateContentScripts: vi.fn(async () => undefined),
    unregisterContentScripts: vi.fn(async () => undefined),
    executeScript: vi.fn(async () => [{ documentId: 'exact-document' }]),
  },
  tabs: {
    query: vi.fn(async (): Promise<object[]> => []),
    sendMessage: vi.fn(async () => ({ ok: true, type: 'page.ready' })),
  },
}));
vi.mock('wxt/browser', () => ({ browser: api }));
import { SiteAccess } from '../../src/background/site-access';
import { siteOrigin } from '../../src/runtime/site-access';
import { ConfigRepository } from '../../src/storage/repository';
import { emptyState, type StoredState } from '../../src/storage/schema';
let raw: StoredState;
let repository: ConfigRepository;
let sites: SiteAccess;
beforeEach(() => {
  vi.clearAllMocks();
  api.permissions.contains.mockResolvedValue(true);
  raw = emptyState();
  repository = new ConfigRepository({
    restrictAccess: async () => undefined,
    read: async () => raw,
    write: async (state) => {
      raw = structuredClone(state);
    },
  });
  sites = new SiteAccess(repository);
});
const enable = (origin: string, expectedRevision = 0) => ({
  type: 'settings.sites.set',
  payload: { origin, enabled: true, expectedRevision },
});
it('normalizes host scope and rejects sensitive or unsupported URLs', () => {
  expect(siteOrigin('https://Example.test:8443/a?q=hello')).toBe('https://example.test');
  expect(siteOrigin('http://localhost:5173/')).toBe('http://localhost');
  for (const value of ['http://remote.test', 'file:///tmp/a', 'https://user:password@example.test'])
    expect(() => siteOrigin(value)).toThrow();
});
it('API permission alone never registers automatic website capture', async () => {
  await sites.reconcile();
  expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
  expect(await sites.permitted('https://api.openai.com')).toBe(false);
});
it('rejects missing permissions and stale mutations before enabling capture', async () => {
  api.permissions.contains.mockResolvedValue(false);
  expect(await sites.handle(enable('https://example.test'))).toEqual({
    ok: false,
    error: 'PERMISSION_REQUIRED',
  });
  expect(raw.allowedSites).toEqual([]);
  api.permissions.contains.mockResolvedValue(true);
  expect(await sites.handle(enable('https://example.test', 20))).toEqual({
    ok: false,
    error: 'CONFLICT',
  });
  expect(api.scripting.registerContentScripts).not.toHaveBeenCalled();
});
it('persists explicit intent and registers only the selected exact host', async () => {
  const response = await sites.handle(enable('https://example.test:8443/a'));
  expect(response).toMatchObject({
    ok: true,
    config: { revision: 1 },
    data: { sites: [{ origin: 'https://example.test', active: false }] },
  });
  // The mock getRegisteredContentScripts remains empty; never claim readiness from intent alone.
  expect(raw.allowedSites).toEqual(['https://example.test']);
  expect(api.scripting.registerContentScripts).toHaveBeenCalledWith([
    expect.objectContaining({ matches: ['https://example.test/*'], allFrames: false }),
  ]);
  expect(
    await new ConfigRepository({
      restrictAccess: async () => undefined,
      read: async () => raw,
      write: async () => undefined,
    }).siteOrigins(),
  ).toEqual(raw.allowedSites);
});
it('forgets revoked intent even if the same host has already been granted again', async () => {
  await repository.setSite('https://child.example.test', true, 0);
  await sites.reconcile(['https://*.example.test/*']);
  expect(raw.allowedSites).toEqual([]);
  expect(await sites.permitted('https://child.example.test')).toBe(false);
});
it('does not overwrite concurrent model preferences during browser-driven removal', async () => {
  await repository.setSite('https://example.test', true, 0);
  await Promise.all([
    repository.preferences({
      expectedRevision: 1,
      preferences: { ...raw.preferences, readTarget: 'ja' },
    }),
    repository.removeSites(['https://example.test']),
  ]);
  expect(raw.preferences.readTarget).toBe('ja');
  expect(raw.allowedSites).toEqual([]);
  expect(raw.revision).toBe(3);
});
it('targets a verified existing document and reuses its controller', async () => {
  api.tabs.query.mockResolvedValueOnce([{ id: 8, url: 'https://example.test/path' }]);
  await sites.handle(enable('https://example.test'));
  expect(api.tabs.sendMessage).toHaveBeenCalledWith(
    8,
    { protocolVersion: 1, type: 'page.automatic', enabled: true },
    { documentId: 'exact-document', frameId: 0 },
  );
  expect(api.scripting.executeScript).toHaveBeenCalledTimes(1);
});
it('reports a failed script registration without clearing other configuration', async () => {
  api.scripting.registerContentScripts.mockRejectedValueOnce(new Error('private native failure'));
  expect(await sites.handle(enable('https://example.test'))).toEqual({
    ok: false,
    error: 'SITE_UNAVAILABLE',
  });
  expect(raw.allowedSites).toEqual(['https://example.test']);
  expect(raw.providers).toEqual({});
});
