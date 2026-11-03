import { browser } from 'wxt/browser';
import { SpeechMessageSchema, type SpeechOwner } from '../runtime/speech-protocol';
import { pageOwner, type MessageSender } from './task-router';
import type { SpeechService } from './speech-service';

const errors = new Set(['FORBIDDEN', 'SPEECH_EXPIRED', 'SPEECH_BUSY']);
export async function handleSpeechMessage(
  message: unknown,
  sender: MessageSender,
  service: SpeechService,
) {
  const parsed = SpeechMessageSchema.safeParse(message);
  if (!parsed.success) return { ok: false, error: 'INVALID_REQUEST' };
  const request = parsed.data;
  const source = request.payload.source;
  let owner: SpeechOwner;
  if (source.origin === 'manual') {
    if (
      sender.id !== browser.runtime.id ||
      sender.origin !== new URL(browser.runtime.getURL('/')).origin ||
      sender.url?.split(/[?#]/)[0] !== browser.runtime.getURL('/popup.html')
    )
      return { ok: false, error: 'FORBIDDEN' };
    try {
      await browser.tabs.get(source.tabId);
    } catch {
      return { ok: false, error: 'CONTEXT_LOST' };
    }
    owner = {
      kind: 'manual',
      tabId: source.tabId,
      cardId: source.cardId,
      documentNonce: source.documentNonce,
    };
  } else {
    const page = pageOwner(sender, source.documentNonce, browser.runtime.id);
    if (!page?.documentId || !page.siteOrigin) return { ok: false, error: 'FORBIDDEN' };
    owner = {
      kind: 'page',
      tabId: page.tabId,
      documentId: page.documentId,
      siteOrigin: page.siteOrigin,
      documentNonce: source.documentNonce,
      cardId: source.cardId,
    };
  }
  try {
    if (request.type === 'speech.ticket')
      return { ok: true, data: await service.ticket(owner, request.payload.clientSpeechId) };
    const state =
      request.type === 'speech.start'
        ? await service.start(owner, request.payload.ticket, request.payload.input)
        : await service.stop(owner, request.payload.ticket);
    return { ok: true, data: { state } };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && errors.has(error.message) ? error.message : 'SPEECH_UNAVAILABLE',
    };
  }
}
