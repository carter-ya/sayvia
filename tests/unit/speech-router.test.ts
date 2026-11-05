import { expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { id: 'self', getURL: (path: string) => `chrome-extension://self${path}` },
    tabs: { get: vi.fn(async (id: number) => ({ id })) },
  },
}));
import { handleSpeechMessage } from '../../src/background/speech-router';
import type { SpeechService } from '../../src/background/speech-service';
import type { MessageSender } from '../../src/background/task-router';

it('derives a page speech owner from the browser and rejects tab/frame/manual forgeries', async () => {
  const ticket = vi.fn(async () => ({ speechId: crypto.randomUUID() }));
  const service = { ticket } as unknown as SpeechService;
  const sender: MessageSender = {
    id: 'self',
    tab: { id: 9 } as NonNullable<MessageSender['tab']>,
    frameId: 0,
    documentId: 'real-document',
    url: 'https://example.test/page',
    origin: 'https://example.test',
  };
  const source = {
    origin: 'page',
    documentNonce: crypto.randomUUID(),
    cardId: crypto.randomUUID(),
  };
  const request = {
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    type: 'speech.ticket',
    payload: { source, clientSpeechId: crypto.randomUUID() },
  };
  expect(await handleSpeechMessage(request, sender, service)).toMatchObject({ ok: true });
  expect(ticket).toHaveBeenCalledWith(
    {
      kind: 'page',
      tabId: 9,
      documentId: 'real-document',
      siteOrigin: 'https://example.test',
      documentNonce: source.documentNonce,
      cardId: source.cardId,
    },
    request.payload.clientSpeechId,
  );
  expect(await handleSpeechMessage(request, { ...sender, frameId: 1 }, service)).toMatchObject({
    ok: false,
    error: 'FORBIDDEN',
  });
  expect(
    await handleSpeechMessage(
      { ...request, payload: { ...request.payload, source: { ...source, tabId: 10 } } },
      sender,
      service,
    ),
  ).toMatchObject({ ok: false, error: 'INVALID_REQUEST' });
  expect(
    await handleSpeechMessage(
      {
        ...request,
        payload: { ...request.payload, source: { ...source, origin: 'manual', tabId: 9 } },
      },
      sender,
      service,
    ),
  ).toMatchObject({ ok: false, error: 'FORBIDDEN' });
  expect(ticket).toHaveBeenCalledOnce();
});
