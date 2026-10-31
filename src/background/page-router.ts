import { browser } from 'wxt/browser';
import { z } from 'zod';
import type { ConfigRepository } from '../storage/repository';
import { pageOwner, type MessageSender } from './task-router';

const Envelope = { protocolVersion: z.literal(1), requestId: z.uuid() };
const Request = z.discriminatedUnion('type', [
  z
    .object({
      ...Envelope,
      type: z.literal('page.open'),
      payload: z.object({ tabId: z.int().nonnegative(), mode: z.enum(['read', 'write']) }).strict(),
    })
    .strict(),
  z.object({ ...Envelope, type: z.literal('page.preferences') }).strict(),
]);
export async function handlePageMessage(
  message: unknown,
  sender: MessageSender,
  repository: ConfigRepository,
) {
  const parsed = Request.safeParse(message);
  if (!parsed.success) return { ok: false, error: 'INVALID_REQUEST' };
  try {
    const request = parsed.data;
    if (request.type === 'page.preferences') {
      if (!pageOwner(sender, crypto.randomUUID(), browser.runtime.id))
        return { ok: false, error: 'FORBIDDEN' };
      const snapshot = await repository.snapshot();
      return {
        ok: true,
        data: {
          readTarget: snapshot.preferences.readTarget,
          writeTarget: snapshot.preferences.writeTarget,
        },
      };
    }
    if (
      sender.id !== browser.runtime.id ||
      sender.origin !== new URL(browser.runtime.getURL('/')).origin ||
      sender.url?.split(/[?#]/)[0] !== browser.runtime.getURL('/popup.html')
    )
      return { ok: false, error: 'FORBIDDEN' };
    const tab = await browser.tabs.get(request.payload.tabId);
    const url = new URL(tab.url ?? '');
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
    )
      return { ok: false, error: 'UNSUPPORTED' };
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id!, frameIds: [0] },
      files: ['/content-scripts/translator.js'],
    });
    const documentId = results[0]?.documentId;
    if (!documentId) return { ok: false, error: 'CONTEXT_LOST' };
    return (await browser.tabs.sendMessage(
      tab.id!,
      { protocolVersion: 1, type: 'page.show', mode: request.payload.mode },
      { documentId, frameId: 0 },
    )) as unknown;
  } catch {
    return { ok: false, error: 'PERMISSION_DENIED' };
  }
}
