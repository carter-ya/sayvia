import { browser } from 'wxt/browser';
import { TaskMessageSchema, type TaskMessage } from '../runtime/task-protocol';
import type { TaskBroker, TaskOwner } from './task-broker';

export type MessageSender = Parameters<
  Parameters<typeof browser.runtime.onMessage.addListener>[0]
>[1];
export function pageOwner(
  sender: MessageSender,
  documentNonce: string,
  extensionId: string,
): TaskOwner | undefined {
  if (
    sender.id !== extensionId ||
    sender.tab?.id === undefined ||
    sender.frameId !== 0 ||
    !sender.documentId ||
    (sender.documentLifecycle && sender.documentLifecycle !== 'active')
  )
    return;
  try {
    const url = new URL(sender.url ?? '');
    if (
      sender.origin !== url.origin ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    )
      return;
    return {
      tabId: sender.tab.id,
      frameId: 0,
      documentId: sender.documentId,
      documentNonce,
      kind: 'page',
      siteOrigin: url.origin,
    };
  } catch {
    return;
  }
}
export function isOffscreenSender(sender: MessageSender) {
  return (
    sender.id === browser.runtime.id &&
    !sender.tab &&
    sender.url === browser.runtime.getURL('/offscreen.html')
  );
}
export async function handleTaskMessage(
  message: unknown,
  sender: MessageSender,
  broker: TaskBroker,
) {
  const parsed = TaskMessageSchema.safeParse(message);
  if (!parsed.success) return { ok: false, error: 'INVALID_REQUEST' };
  const request: TaskMessage = parsed.data;
  const popup =
    sender.id === browser.runtime.id &&
    sender.origin === new URL(browser.runtime.getURL('/')).origin &&
    sender.url?.split(/[?#]/)[0] === browser.runtime.getURL('/popup.html');
  if (request.type === 'translation.manual.read') {
    if (!popup) return { ok: false, error: 'FORBIDDEN' };
    try {
      await browser.tabs.get(request.payload.tabId);
      return { ok: true, data: await broker.readManual(request.payload.tabId) };
    } catch {
      return { ok: false, error: 'CONTEXT_LOST' };
    }
  }
  const payload = request.payload;
  if (popup) {
    if (
      payload.tabId === undefined ||
      (request.type === 'translation.start' && request.payload.mode !== 'manual')
    )
      return { ok: false, error: 'FORBIDDEN' };
    try {
      await browser.tabs.get(payload.tabId);
    } catch {
      return { ok: false, error: 'CONTEXT_LOST' };
    }
    return broker.handle(request, {
      tabId: payload.tabId,
      frameId: 0,
      documentNonce: payload.documentNonce,
      kind: 'manual',
    });
  }
  if (
    payload.tabId !== undefined ||
    (request.type === 'translation.start' && request.payload.mode === 'manual')
  )
    return { ok: false, error: 'FORBIDDEN' };
  const owner = pageOwner(sender, payload.documentNonce, browser.runtime.id);
  if (!owner) return { ok: false, error: 'FORBIDDEN' };
  return broker.handle(request, owner);
}

export function permissionPattern(baseUrl: string) {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.hostname}/*`;
}
