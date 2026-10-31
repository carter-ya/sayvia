import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({
  runtime: { id: 'self', getURL: (path: string) => `chrome-extension://self${path}` },
  tabs: {
    get: vi.fn(async (id: number) => ({ id, url: 'https://github.com/test' })),
    sendMessage: vi.fn(async (): Promise<unknown> => ({ ok: true })),
  },
  scripting: {
    executeScript: vi.fn(async () => [{ documentId: 'verified-document', frameId: 0 }]),
  },
}));
vi.mock('wxt/browser', () => ({ browser: api }));
import { handlePageMessage } from '../../src/background/page-router';
import type { ConfigRepository } from '../../src/storage/repository';
import type { MessageSender } from '../../src/background/task-router';
const popup: MessageSender = {
  id: 'self',
  origin: new URL('chrome-extension://self/').origin,
  url: 'chrome-extension://self/popup.html',
};
const page = {
  id: 'self',
  frameId: 0,
  documentId: 'page-document',
  tab: { id: 8 },
  origin: 'https://github.com',
  url: 'https://github.com/test',
} as MessageSender;
const repository = {
  snapshot: vi.fn(async () => ({
    preferences: { readTarget: 'zh-Hans', writeTarget: 'en' },
    secrets: 'SECRET_NEVER_PROJECT',
  })),
} as unknown as ConfigRepository;
const open = () => ({
  protocolVersion: 1,
  requestId: crypto.randomUUID(),
  type: 'page.open',
  payload: { tabId: 8, mode: 'write' },
});
beforeEach(() => vi.clearAllMocks());

describe('explicit page translation entry', () => {
  it('only permits trusted popup injection and targets the browser-verified document', async () => {
    expect(await handlePageMessage(open(), popup, repository)).toEqual({ ok: true });
    expect(api.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 8, frameIds: [0] },
      func: expect.any(Function),
    });
    expect(api.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 8, documentIds: ['verified-document'] },
      files: ['/content-scripts/translator.js'],
    });
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(
      8,
      { protocolVersion: 1, type: 'page.show', mode: 'write' },
      { documentId: 'verified-document', frameId: 0 },
    );
  });
  it('reuses a live controller without executing the WXT bundle again', async () => {
    api.tabs.sendMessage.mockResolvedValueOnce({
      ok: true,
      protocolVersion: 1,
      type: 'page.ready',
    });
    expect(await handlePageMessage(open(), popup, repository)).toEqual({ ok: true });
    expect(api.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(api.tabs.sendMessage).toHaveBeenNthCalledWith(
      1,
      8,
      { protocolVersion: 1, type: 'page.probe' },
      { documentId: 'verified-document', frameId: 0 },
    );
  });
  it('injects when the document has no live receiver', async () => {
    api.tabs.sendMessage.mockRejectedValueOnce(new Error('No receiver'));
    expect(await handlePageMessage(open(), popup, repository)).toEqual({ ok: true });
    expect(api.scripting.executeScript).toHaveBeenCalledTimes(2);
  });
  it('does not retarget a replacement document if navigation invalidates the captured one', async () => {
    api.scripting.executeScript.mockResolvedValueOnce([{ documentId: 'old-document', frameId: 0 }]);
    api.scripting.executeScript.mockRejectedValueOnce(new Error('Document no longer exists'));
    expect(await handlePageMessage(open(), popup, repository)).toEqual({
      ok: false,
      error: 'PERMISSION_DENIED',
    });
    expect(api.scripting.executeScript).toHaveBeenLastCalledWith({
      target: { tabId: 8, documentIds: ['old-document'] },
      files: ['/content-scripts/translator.js'],
    });
    expect(api.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('never lets a web page or options page request injection into another tab', async () => {
    expect(await handlePageMessage(open(), page, repository)).toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });
    expect(
      await handlePageMessage(
        open(),
        { ...popup, url: 'chrome-extension://self/options.html' },
        repository,
      ),
    ).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });
  it('projects language preferences without provider details or secrets', async () => {
    const request = {
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      type: 'page.preferences',
    };
    expect(await handlePageMessage(request, page, repository)).toEqual({
      ok: true,
      data: { readTarget: 'zh-Hans', writeTarget: 'en' },
    });
    expect(await handlePageMessage(request, { ...page, frameId: 1 }, repository)).toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });
  });
  it('rejects unknown fields and unsupported page protocols before injection', async () => {
    const request = open();
    expect(
      await handlePageMessage(
        { ...request, payload: { ...request.payload, apiKey: 'secret' } },
        popup,
        repository,
      ),
    ).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    api.tabs.get.mockResolvedValueOnce({ id: 8, url: 'chrome://extensions' });
    expect(await handlePageMessage(request, popup, repository)).toEqual({
      ok: false,
      error: 'UNSUPPORTED',
    });
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });
});
