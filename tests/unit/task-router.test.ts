import { describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { id: 'self', getURL: (path: string) => `chrome-extension://self${path}` },
    tabs: { get: vi.fn(async (id: number) => ({ id })) },
  },
}));
import {
  handleTaskMessage,
  pageOwner,
  permissionPattern,
  type MessageSender,
} from '../../src/background/task-router';
import { TaskMessageSchema } from '../../src/runtime/task-protocol';
import type { TaskBroker } from '../../src/background/task-broker';
const nonce = crypto.randomUUID();
const sender = {
  id: 'self',
  tab: { id: 9 },
  frameId: 0,
  documentId: 'real-document',
  documentLifecycle: 'active',
  url: 'https://github.com/test',
  origin: 'https://github.com',
} as MessageSender;
const request = () => ({
  protocolVersion: 1,
  requestId: crypto.randomUUID(),
  type: 'translation.start',
  payload: {
    clientTaskId: crypto.randomUUID(),
    documentNonce: nonce,
    source: { kind: 'plain-text', text: 'hello' },
    mode: 'write',
    scope: 'full',
    editorSessionId: crypto.randomUUID(),
    sourceRevision: 0,
    sourceLanguage: 'auto',
    targetLanguage: 'en',
  },
});
const stub = () => {
  const handle = vi.fn(async () => ({ ok: true }));
  const readManual = vi.fn(async () => null);
  return { handle, readManual, broker: { handle, readManual } as unknown as TaskBroker };
};

describe('browser-derived task ownership', () => {
  it('uses actual tab and document fields rather than fields supplied by the page', async () => {
    const f = stub();
    await handleTaskMessage(request(), sender, f.broker);
    expect(f.handle).toHaveBeenCalledWith(expect.anything(), {
      tabId: 9,
      frameId: 0,
      documentId: 'real-document',
      documentNonce: nonce,
      kind: 'page',
    });
    const forged = request();
    Object.assign(forged.payload, { tabId: 999 });
    expect(await handleTaskMessage(forged, sender, f.broker)).toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });
    expect(f.handle).toHaveBeenCalledOnce();
  });
  it.each([
    { id: 'different-extension' },
    { frameId: 1 },
    { documentId: undefined },
    { origin: 'https://attacker.test' },
    { documentLifecycle: 'prerender' },
    { url: 'about:blank' },
    { url: 'http://remote.example', origin: 'http://remote.example' },
    { tab: undefined },
  ])('rejects missing or untrusted browser context %j', (overrides) => {
    expect(pageOwner({ ...sender, ...overrides } as MessageSender, nonce, 'self')).toBeUndefined();
  });
  it('only permits popup manual messages and refuses settings/offscreen/page masquerades', async () => {
    const f = stub();
    const message = {
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      type: 'translation.manual.read',
      payload: { tabId: 9 },
    };
    for (const path of ['options.html', 'offscreen.html', 'background.js']) {
      const source = {
        id: 'self',
        origin: new URL('chrome-extension://self/').origin,
        url: `chrome-extension://self/${path}`,
      };
      expect(await handleTaskMessage(message, source, f.broker)).toEqual({
        ok: false,
        error: 'FORBIDDEN',
      });
    }
    expect(await handleTaskMessage(message, sender, f.broker)).toEqual({
      ok: false,
      error: 'FORBIDDEN',
    });
    expect(
      await handleTaskMessage(
        message,
        {
          id: 'self',
          origin: new URL('chrome-extension://self/').origin,
          url: 'chrome-extension://self/popup.html',
        },
        f.broker,
      ),
    ).toEqual({ ok: true, data: null });
    expect(
      await handleTaskMessage(
        message,
        {
          id: 'self',
          origin: new URL('chrome-extension://self/').origin,
          url: 'chrome-extension://self/popup.html',
          tab: { id: 10 },
        } as MessageSender,
        f.broker,
      ),
    ).toEqual({ ok: true, data: null });
    expect(f.readManual).toHaveBeenCalledWith(9);
  });
  it('strictly rejects extra envelopes, endpoint fields, modes, and oversized source', () => {
    const original = request();
    expect(TaskMessageSchema.safeParse(original).success).toBe(true);
    expect(
      TaskMessageSchema.safeParse({ ...original, endpoint: 'https://attacker.test' }).success,
    ).toBe(false);
    expect(
      TaskMessageSchema.safeParse({
        ...original,
        payload: { ...original.payload, apiKey: 'secret' },
      }).success,
    ).toBe(false);
    expect(
      TaskMessageSchema.safeParse({ ...original, payload: { ...original.payload, mode: 'read' } })
        .success,
    ).toBe(false);
    expect(
      TaskMessageSchema.safeParse({
        ...original,
        payload: { ...original.payload, source: { kind: 'plain-text', text: 'x'.repeat(12001) } },
      }).success,
    ).toBe(false);
  });
  it('treats host permission as a host boundary while retaining exact configured URL separately', () => {
    expect(permissionPattern('http://127.0.0.1:9123/private/v1')).toBe('http://127.0.0.1/*');
    expect(permissionPattern('https://api.example/prefix')).toBe('https://api.example/*');
  });
});
