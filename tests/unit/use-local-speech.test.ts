// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useLocalSpeech } from '../../src/ui/use-local-speech';
import type { SpeechSource } from '../../src/runtime/speech-protocol';

const runtime = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  listeners: new Set<(message: unknown, sender: unknown) => void>(),
}));
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'extension',
      getURL: (path: string) => `chrome-extension://extension${path}`,
      sendMessage: runtime.sendMessage,
      onMessage: {
        addListener: (listener: (message: unknown, sender: unknown) => void) =>
          runtime.listeners.add(listener),
        removeListener: (listener: (message: unknown, sender: unknown) => void) =>
          runtime.listeners.delete(listener),
      },
    },
  },
}));
const ticket = {
  speechId: crypto.randomUUID(),
  epoch: crypto.randomUUID(),
  expiresAt: Date.now() + 30_000,
};
let source: SpeechSource;
let root: Root;
let container: HTMLElement;
let controls: ReturnType<typeof useLocalSpeech>;
function Card({ language = 'en' }: { language?: string }) {
  controls = useLocalSpeech(source, 'bank', language);
  return createElement('span', null, controls.state);
}
const stops = () =>
  runtime.sendMessage.mock.calls.filter(([message]) => message.type === 'speech.stop');
beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  runtime.sendMessage.mockReset();
  source = { origin: 'page', cardId: crypto.randomUUID(), documentNonce: crypto.randomUUID() };
  runtime.sendMessage.mockImplementation(async ({ type }) =>
    type === 'speech.ticket'
      ? { ok: true, data: ticket }
      : { ok: true, data: { state: 'speaking' } },
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Card)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  runtime.listeners.clear();
});
test('a lost start reply stops that ticket once and cannot be revived by a late speaking event', async () => {
  runtime.sendMessage.mockImplementation(async ({ type }) => {
    if (type === 'speech.ticket') return { ok: true, data: ticket };
    if (type === 'speech.start') throw new Error('reply lost after delivery');
    return { ok: true };
  });
  await act(async () => controls.play(1));
  expect(controls.state).toBe('failed');
  expect(stops()).toHaveLength(1);
  expect(stops()[0]![0].payload).toEqual({ source, ticket });
  await act(async () => {
    for (const listener of runtime.listeners)
      listener(
        { type: 'speech.state', ticket, ...source, state: 'speaking' },
        { id: 'extension', url: 'chrome-extension://extension/background.js' },
      );
    controls.stop();
  });
  expect(stops()).toHaveLength(1);
  expect(controls.state).toBe('canceled');
});
test('closing before a ticket arrives sends only stop when it arrives', async () => {
  let resolve!: (value: unknown) => void;
  runtime.sendMessage.mockImplementation(({ type }) =>
    type === 'speech.ticket'
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve({ ok: true }),
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = controls.play(1);
  });
  await act(async () => controls.stop());
  await act(async () => {
    resolve({ ok: true, data: ticket });
    await pending;
  });
  expect(runtime.sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
    'speech.ticket',
    'speech.stop',
  ]);
});
test('changing language cancels the old card and ignores its later event', async () => {
  await act(async () => controls.play(1));
  await act(async () => root.render(createElement(Card, { language: 'fr' })));
  expect(stops()).toHaveLength(1);
  await act(async () => {
    for (const listener of runtime.listeners)
      listener(
        { type: 'speech.state', ticket, ...source, state: 'speaking' },
        { id: 'extension', url: 'chrome-extension://extension/background.js' },
      );
  });
  expect(controls.state).toBe('ended');
});
