import { beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
  permissions: { contains: vi.fn(async () => true) },
  scripting: {
    getRegisteredContentScripts: vi.fn(async (): Promise<object[]> => []),
    registerContentScripts: vi.fn(async () => undefined),
    updateContentScripts: vi.fn(async () => undefined),
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
let sites: SiteAccess;
beforeEach(() => {
  vi.clearAllMocks();
  api.permissions.contains.mockResolvedValue(true);
  sites = new SiteAccess();
});
it('accepts ordinary web hosts while rejecting credentials and unsupported schemes', () => {
  expect(siteOrigin('https://Example.test:8443/a?q=hello')).toBe('https://example.test');
  expect(siteOrigin('http://remote.test/page')).toBe('http://remote.test');
  for (const value of [
    'https://*.example.test',
    'file:///tmp/a',
    'https://user:password@example.test',
  ])
    expect(() => siteOrigin(value)).toThrow();
});
it('enables web entry without a separate saved website allowlist', async () => {
  await sites.reconcile();
  expect(api.scripting.registerContentScripts).toHaveBeenCalledWith([
    expect.objectContaining({
      matches: ['https://*/*', 'http://*/*'],
      allFrames: false,
      persistAcrossSessions: true,
    }),
  ]);
  expect(await sites.permitted('https://example.test')).toBe(true);
});
it('respects Chrome withholding access to a declared host', async () => {
  api.permissions.contains.mockResolvedValue(false);
  expect(await sites.permitted('https://example.test')).toBe(false);
});
it('reuses the verified existing document without duplicate injection', async () => {
  api.tabs.query.mockResolvedValueOnce([{ id: 8, url: 'https://example.test/path' }]);
  await sites.reconcile();
  expect(api.tabs.sendMessage).toHaveBeenCalledWith(
    8,
    { protocolVersion: 1, type: 'page.automatic', enabled: true },
    { documentId: 'exact-document', frameId: 0 },
  );
  expect(api.scripting.executeScript).toHaveBeenCalledTimes(1);
});
it('updates the previous narrow registration when upgrading', async () => {
  api.scripting.getRegisteredContentScripts.mockResolvedValueOnce([
    { id: 'sayvia-selection-v1', matches: ['https://github.com/*'] },
  ]);
  await sites.reconcile();
  expect(api.scripting.updateContentScripts).toHaveBeenCalledWith([
    expect.objectContaining({ matches: ['https://*/*', 'http://*/*'] }),
  ]);
});
it('disables live controllers when Chrome withholds a host or its tab URL', async () => {
  api.permissions.contains.mockResolvedValue(false);
  api.tabs.query.mockResolvedValueOnce([{ id: 12 }, { id: 13, url: 'https://example.test' }]);
  await sites.reconcile();
  for (const id of [12, 13])
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(
      id,
      { protocolVersion: 1, type: 'page.automatic', enabled: false },
      { frameId: 0 },
    );
  expect(api.scripting.executeScript).not.toHaveBeenCalled();
});
