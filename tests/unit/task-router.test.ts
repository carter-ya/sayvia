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
      siteOrigin: 'https://github.com',
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
    { url: 'https://user:password@github.com/test', origin: 'https://github.com' },
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

it('never permits a web page or settings context to save a popup draft', async () => {
  const f = stub();
  const message = {
    type: 'translation.manual.save',
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    payload: {
      generation: crypto.randomUUID(),
      tabId: 9,
      input: 'private draft',
      result: '',
      targetLanguage: 'en',
      editSession: crypto.randomUUID(),
      sequence: 1,
      expectedRevision: 0,
    },
  };
  expect(await handleTaskMessage(message, sender, f.broker)).toEqual({
    ok: false,
    error: 'FORBIDDEN',
  });
  expect(
    await handleTaskMessage(
      { ...message, payload: { ...message.payload, apiKey: 'fake' } },
      sender,
      f.broker,
    ),
  ).toEqual({ ok: false, error: 'INVALID_REQUEST' });
});

it('accepts a verified ordinary HTTP page without relaxing sender identity', () => {
  const page = { ...sender, url: 'http://remote.example/article', origin: 'http://remote.example' };
  expect(pageOwner(page, nonce, 'self')).toMatchObject({
    kind: 'page',
    siteOrigin: 'http://remote.example',
  });
  expect(pageOwner({ ...page, origin: 'http://different.example' }, nonce, 'self')).toBeUndefined();
});

it('routes lookup by browser owner and rejects forged mode, tab and manual origin', async () => {
  const f = stub();
  const message = {
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    type: 'learning.start',
    payload: {
      clientTaskId: crypto.randomUUID(),
      documentNonce: nonce,
      purpose: 'lookup',
      origin: 'page',
      input: { text: 'bank', sourceLanguage: 'en', explanationLanguage: 'zh' },
    },
  };
  expect(await handleTaskMessage(message, sender, f.broker)).toEqual({ ok: true });
  expect(f.handle).toHaveBeenLastCalledWith(
    message,
    expect.objectContaining({ tabId: 9, documentId: 'real-document', kind: 'page' }),
  );
  for (const extra of [{ tabId: 999 }, { mode: 'write' }, { canApply: true }]) {
    expect(
      await handleTaskMessage(
        { ...message, payload: { ...message.payload, ...extra } },
        sender,
        f.broker,
      ),
    ).toMatchObject({ ok: false, error: 'INVALID_REQUEST' });
  }
  const manual = {
    ...message,
    payload: {
      ...message.payload,
      origin: 'manual',
      tabId: 9,
      manualRevision: 0,
      manualGeneration: crypto.randomUUID(),
    },
  };
  expect(await handleTaskMessage(manual, sender, f.broker)).toEqual({
    ok: false,
    error: 'FORBIDDEN',
  });
  const popup = {
    id: 'self',
    origin: new URL('chrome-extension://self/').origin,
    url: 'chrome-extension://self/popup.html',
  };
  expect(await handleTaskMessage(manual, popup, f.broker)).toEqual({ ok: true });
  expect(f.handle).toHaveBeenLastCalledWith(manual, {
    tabId: 9,
    frameId: 0,
    documentNonce: nonce,
    kind: 'manual',
  });
  expect(await handleTaskMessage(message, popup, f.broker)).toEqual({
    ok: false,
    error: 'FORBIDDEN',
  });
});
