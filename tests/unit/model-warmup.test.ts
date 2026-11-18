import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
  runtime: { id: 'self', getURL: (path: string) => `chrome-extension://self${path}` },
  permissions: { contains: vi.fn(async () => true) },
}));
vi.mock('wxt/browser', () => ({ browser: api }));
import { handleModelWarmup } from '../../src/background/model-warmup';
import type { ConfigRepository } from '../../src/storage/repository';
import type { MessageSender } from '../../src/background/task-router';
const id = crypto.randomUUID(),
  other = crypto.randomUUID();
const providers = [
  { id, baseUrl: 'https://one.test/v1', hasApiKey: true },
  { id: other, baseUrl: 'https://two.test/prefix', hasApiKey: true },
];
const repository = {
  snapshot: vi.fn(async () => ({ providers, preferences: { defaultProviderId: id } })),
} as unknown as Pick<ConfigRepository, 'snapshot'>;
const host = { warmup: vi.fn(async () => {}) };
const sites = { permitted: vi.fn(async () => true) };
const popup = {
  id: 'self',
  origin: new URL('chrome-extension://self/').origin,
  url: 'chrome-extension://self/popup.html',
} as MessageSender;
const page = {
  id: 'self',
  origin: 'https://page.test',
  url: 'https://page.test/doc',
  frameId: 0,
  documentId: 'doc',
  tab: { id: 1 },
} as MessageSender;
const message = { protocolVersion: 1, type: 'model.warmup' };
beforeEach(() => {
  vi.clearAllMocks();
  api.permissions.contains.mockResolvedValue(true);
  sites.permitted.mockResolvedValue(true);
});
describe('model warmup routing', () => {
  it('uses only the saved default or selected provider origin', async () => {
    expect(await handleModelWarmup(message, page, repository, host, sites)).toEqual({ ok: true });
    expect(host.warmup).toHaveBeenLastCalledWith('https://one.test');
    await handleModelWarmup({ ...message, providerId: other }, popup, repository, host, sites);
    expect(host.warmup).toHaveBeenLastCalledWith('https://two.test');
    expect(api.permissions.contains).toHaveBeenCalledWith({ origins: ['https://two.test/*'] });
  });
  it('does not initialize an executor without a configured key', async () => {
    providers[0]!.hasApiKey = false;
    try {
      expect(await handleModelWarmup(message, popup, repository, host, sites)).toEqual({
        ok: false,
      });
      expect(host.warmup).not.toHaveBeenCalled();
    } finally {
      providers[0]!.hasApiKey = true;
    }
  });
  it('rejects forged senders, arbitrary URLs and missing providers', async () => {
    for (const sender of [
      { ...page, id: 'other' },
      { ...page, frameId: 1 },
      { ...page, origin: 'https://forged.test' },
    ]) {
      expect(await handleModelWarmup(message, sender, repository, host, sites)).toEqual({
        ok: false,
      });
    }
    await handleModelWarmup(
      { ...message, origin: 'https://attacker.test' },
      popup,
      repository,
      host,
      sites,
    );
    await handleModelWarmup(
      { ...message, providerId: crypto.randomUUID() },
      popup,
      repository,
      host,
      sites,
    );
    expect(host.warmup).not.toHaveBeenCalled();
  });
  it('respects site and API access permissions, and treats warmup failure as optional', async () => {
    sites.permitted.mockResolvedValue(false);
    await handleModelWarmup(message, page, repository, host, sites);
    api.permissions.contains.mockResolvedValue(false);
    await handleModelWarmup(message, popup, repository, host, sites);
    expect(host.warmup).not.toHaveBeenCalled();
    api.permissions.contains.mockResolvedValue(true);
    host.warmup.mockRejectedValueOnce(new Error('unavailable'));
    expect(await handleModelWarmup(message, popup, repository, host, sites)).toEqual({ ok: false });
  });
});
