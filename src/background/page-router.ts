import { siteOrigin } from '../runtime/site-access';
import { browser } from 'wxt/browser';
import { z } from 'zod';
import type { SiteAccess } from './site-access';
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
  z.object({ ...Envelope, type: z.literal('page.automatic-status') }).strict(),
]);
export async function handlePageMessage(
  message: unknown,
  sender: MessageSender,
  repository: ConfigRepository,
  sites?: Pick<SiteAccess, 'permitted'>,
) {
  const parsed = Request.safeParse(message);
  if (!parsed.success) return { ok: false, error: 'INVALID_REQUEST' };
  try {
    const request = parsed.data;
    if (request.type === 'page.automatic-status') {
      const owner = pageOwner(sender, crypto.randomUUID(), browser.runtime.id);
      if (!owner?.siteOrigin || !sites) return { ok: false, error: 'FORBIDDEN' };
      return { ok: true, enabled: await sites.permitted(owner.siteOrigin) };
    }
    if (request.type === 'page.preferences') {
      if (!pageOwner(sender, crypto.randomUUID(), browser.runtime.id))
        return { ok: false, error: 'FORBIDDEN' };
      const snapshot = await repository.snapshot();
      return {
        ok: true,
        data: {
          quickReplace: snapshot.preferences.quickReplace,
          theme: snapshot.preferences.theme,
          model: snapshot.providers.find(
            (provider) => provider.id === snapshot.preferences.defaultProviderId,
          )?.model,
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
    return await openPage(request.payload.tabId, request.payload.mode);
  } catch {
    return { ok: false, error: 'PERMISSION_DENIED' };
  }
}

// Only trusted browser gesture handlers call this; it is not a public message action.
export async function openPage(tabId: number, mode: 'read' | 'write', autoTranslate = false) {
  try {
    const tab = await browser.tabs.get(tabId);
    try {
      siteOrigin(tab.url ?? '');
    } catch {
      return { ok: false, error: 'UNSUPPORTED' };
    }
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id!, frameIds: [0] },
      // Obtain the current document without restarting WXT's content-script context.
      func: () => undefined,
    });
    const documentId = results[0]?.documentId;
    if (!documentId) return { ok: false, error: 'CONTEXT_LOST' };
    let ready = false;
    try {
      const response = (await browser.tabs.sendMessage(
        tab.id!,
        { protocolVersion: 1, type: 'page.probe' },
        { documentId, frameId: 0 },
      )) as { ok?: boolean; type?: string; protocolVersion?: number } | undefined;
      ready =
        response?.ok === true && response.type === 'page.ready' && response.protocolVersion === 1;
    } catch {
      // No live controller in this document: inject once, then open that same document.
    }
    if (!ready) {
      await browser.scripting.executeScript({
        target: { tabId: tab.id!, documentIds: [documentId] },
        files: ['/content-scripts/translator.js'],
      });
    }
    return (await browser.tabs.sendMessage(
      tab.id!,
      {
        protocolVersion: 1,
        type: 'page.show',
        mode,
        ...(autoTranslate ? { autoTranslate: true } : {}),
      },
      { documentId, frameId: 0 },
    )) as unknown;
  } catch {
    return { ok: false, error: 'PERMISSION_DENIED' };
  }
}
