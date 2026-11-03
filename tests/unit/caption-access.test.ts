import { beforeEach, expect, it, vi } from 'vitest';
import {
  CaptionAccess,
  type CaptionAccessPlatform,
  type CaptionOwner,
} from '../../src/background/caption-access';
import type { CaptionTrack } from '../../src/captions/contract';
const owner: CaptionOwner = {
  kind: 'page',
  tabId: 1,
  frameId: 0,
  documentId: 'doc',
  documentNonce: 'nonce',
  siteOrigin: 'https://www.youtube.com',
};
const track: CaptionTrack = { videoId: 'example', lang: 'en', kind: null, name: null, tlang: null };
const generation = crypto.randomUUID();
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let platform: CaptionAccessPlatform;
let access: CaptionAccess;
beforeEach(async () => {
  platform = {
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => {}),
    register: vi.fn(async () => {}),
    cleanup: vi.fn(async () => 0),
    current: vi.fn(async () => 'example'),
    cancel: vi.fn(async () => {}),
  };
  access = new CaptionAccess(platform);
  await access.ready;
});
it('starts disabled, persists intent before registering, and never restores video opt-in', async () => {
  expect(access.status().registered).toBe(false);
  await expect(access.grant(owner, track, generation)).rejects.toThrow('CAPTION_NOT_AUTHORIZED');
  const order: string[] = [];
  vi.mocked(platform.write).mockImplementation(async () => {
    order.push('write');
  });
  vi.mocked(platform.register).mockImplementation(async () => {
    order.push('register');
  });
  await access.setEnabled(true);
  expect(order).toEqual(['write', 'register']);
  const session = await access.grant(owner, track, generation);
  expect(await access.authorized(owner, session)).toBe(true);
  vi.mocked(platform.read).mockResolvedValue(true);
  const restarted = new CaptionAccess(platform);
  await restarted.ready;
  expect(restarted.status().registered).toBe(true);
  expect(await restarted.authorized(owner, session)).toBe(false);
});
it('revokes immediately even when an older enable is stuck in registration', async () => {
  await access.setEnabled(true);
  const session = await access.grant(owner, track, generation);
  const pending = deferred<void>();
  vi.mocked(platform.register).mockImplementationOnce(() => pending.promise);
  const enable = access.setEnabled(true);
  await vi.waitFor(() => expect(platform.register).toHaveBeenCalledTimes(3));
  const disable = access.setEnabled(false);
  expect(await access.authorized(owner, session)).toBe(false);
  pending.resolve();
  await Promise.all([enable, disable]);
  expect(access.status()).toMatchObject({ desiredEnabled: false, registered: false });
  expect(platform.register).toHaveBeenLastCalledWith(false);
});
it('fails closed on registration/storage errors and reports an uncertain cleanup', async () => {
  vi.mocked(platform.register).mockRejectedValueOnce(new Error('permission'));
  expect(await access.setEnabled(true)).toMatchObject({ registered: false, error: true });
  expect(platform.register).toHaveBeenLastCalledWith(false);
  await expect(access.grant(owner, track, generation)).rejects.toThrow();
  vi.mocked(platform.cleanup).mockResolvedValue(2);
  expect(await access.setEnabled(false)).toMatchObject({ unconfirmedDocuments: 2 });
  vi.mocked(platform.read).mockResolvedValue('invalid');
  const corrupt = new CaptionAccess(platform);
  await corrupt.ready;
  expect(corrupt.status()).toMatchObject({ registered: false, error: true });
  expect(platform.cleanup).toHaveBeenLastCalledWith(false);
});
it('checks the browser document/video and exact session identity, rotating on a source change', async () => {
  await access.setEnabled(true);
  vi.mocked(platform.current).mockResolvedValueOnce('other');
  await expect(access.grant(owner, track, generation)).rejects.toThrow();
  const first = await access.grant(owner, track, generation);
  expect(await access.authorized({ ...owner, documentId: 'other' }, first)).toBe(false);
  expect(await access.authorized(owner, { ...first, trackKey: 'other' })).toBe(false);
  await expect(access.grant(owner, { ...track, tlang: 'zh' }, generation)).rejects.toThrow();
  const second = await access.grant(owner, { ...track, kind: 'asr' }, generation, first.sessionId);
  expect(second.sessionId).toBe(first.sessionId);
  expect(second.generation).toBe(first.generation + 1);
  expect(await access.authorized(owner, first)).toBe(false);
  expect(await access.authorized(owner, second)).toBe(true);
  expect(platform.cancel).toHaveBeenCalledWith(owner);
});
it.each(['revoke', 'revokeTab'] as const)(
  'does not allow a late grant after %s while current-document validation is pending',
  async (method) => {
    await access.setEnabled(true);
    const pending = deferred<string>();
    vi.mocked(platform.current).mockImplementationOnce(() => pending.promise);
    const grant = access.grant(owner, track, generation);
    const outcome = expect(grant).rejects.toThrow('CAPTION_NOT_AUTHORIZED');
    await vi.waitFor(() => expect(platform.current).toHaveBeenCalled());
    if (method === 'revoke') await access.revoke(owner);
    else await access.revokeTab(owner.tabId);
    pending.resolve('example');
    await outcome;
  },
);
it('invalidates an authorization probe whose document check finishes after revocation', async () => {
  await access.setEnabled(true);
  const session = await access.grant(owner, track, generation);
  const pending = deferred<string>();
  vi.mocked(platform.current).mockImplementationOnce(() => pending.promise);
  const authorized = access.authorized(owner, session);
  await access.revoke(owner);
  pending.resolve('example');
  expect(await authorized).toBe(false);
});
it('can query authorization inside cancellation without waiting for the registration lock', async () => {
  await access.setEnabled(true);
  const session = await access.grant(owner, track, generation);
  vi.mocked(platform.cancel).mockImplementation(async () => {
    expect(await access.authorized(owner, session)).toBe(false);
  });
  await access.setEnabled(false);
  expect(platform.cancel).toHaveBeenCalled();
});
it('does not let a stale reconcile re-enable capture after a newer disable intent', async () => {
  await access.setEnabled(true);
  const pending = deferred<void>();
  vi.mocked(platform.register).mockImplementationOnce(() => pending.promise);
  const reconcile = access.reconcile();
  await vi.waitFor(() => expect(platform.register).toHaveBeenCalledTimes(3));
  const disable = access.setEnabled(false);
  pending.resolve();
  await Promise.all([reconcile, disable]);
  expect(access.status().registered).toBe(false);
  expect(platform.cleanup).toHaveBeenLastCalledWith(false);
});

it('keeps a disable cancellation and document-cleanup barrier when immediately re-enabled', async () => {
  await access.setEnabled(true);
  const session = await access.grant(owner, track, generation);
  const calls: string[] = [];
  vi.mocked(platform.cancel).mockImplementation(async () => {
    calls.push('cancel');
  });
  vi.mocked(platform.cleanup).mockImplementation(async (enabled) => {
    calls.push(`cleanup:${enabled}`);
    return 0;
  });
  await Promise.all([access.setEnabled(false), access.setEnabled(true)]);
  expect(calls).toContain('cancel');
  expect(calls.indexOf('cleanup:false')).toBeLessThan(calls.indexOf('cleanup:true'));
  expect(await access.authorized(owner, session)).toBe(false);
  expect(access.status().registered).toBe(true);
});

it('rejects a queued grant from before a disable even if the user re-enables before it runs', async () => {
  const pending = deferred<void>();
  vi.mocked(platform.register).mockImplementationOnce(() => pending.promise);
  const enable = access.setEnabled(true);
  await vi.waitFor(() => expect(platform.register).toHaveBeenCalledTimes(2));
  const grant = access.grant(owner, track, generation);
  const outcome = expect(grant).rejects.toThrow('CAPTION_NOT_AUTHORIZED');
  const disable = access.setEnabled(false);
  const reenable = access.setEnabled(true);
  pending.resolve();
  await Promise.all([enable, disable, reenable, outcome]);
  expect(access.status().registered).toBe(true);
  expect(platform.cancel).toHaveBeenCalled();
});

it('recovers a startup registration failure through a successful reconcile', async () => {
  vi.mocked(platform.read).mockResolvedValue(true);
  vi.mocked(platform.register).mockRejectedValueOnce(new Error('temporary failure'));
  const recovering = new CaptionAccess(platform);
  await recovering.ready;
  expect(recovering.status().error).toBe(true);
  await recovering.reconcile();
  expect(recovering.status()).toMatchObject({
    desiredEnabled: true,
    registered: true,
    error: false,
  });
  expect(await recovering.enabledFor(owner)).toBe(true);
  const session = await recovering.grant(owner, track, generation);
  expect(await recovering.authorized(owner, session)).toBe(true);
});
