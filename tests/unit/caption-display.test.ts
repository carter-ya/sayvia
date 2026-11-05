// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=example"}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CaptionOverlay } from '../../src/captions/overlay';
import { HIDDEN_ATTRIBUTE, installDisplayLease } from '../../src/captions/display-lease';
let player: HTMLDivElement, video: HTMLVideoElement, native: HTMLDivElement;
let scope: { generation: string; trackKey: string; player: HTMLElement; ready: boolean };
let guard: ReturnType<typeof installDisplayLease>;
let overlay: CaptionOverlay;
let shadow: ShadowRoot;
const rows = [{ unitId: 'g', original: '<img src=x> Original', translation: '译文' }];
function message(type = 'renew', owner = overlay.owner, fields = {}) {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: JSON.stringify({
        channel: 'sayvia.caption.display.v1',
        type,
        owner,
        generation: scope.generation,
        trackKey: scope.trackKey,
        ...fields,
      }),
    }),
  );
}
function makeOverlay() {
  const result = new CaptionOverlay(player, video);
  vi.spyOn(result.host, 'getBoundingClientRect').mockReturnValue({
    left: 20,
    top: 220,
    right: 620,
    bottom: 290,
    width: 600,
    height: 70,
  } as DOMRect);
  return result;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01'));
  document.body.replaceChildren();
  player = document.createElement('div');
  player.id = 'movie_player';
  video = document.createElement('video');
  native = document.createElement('div');
  native.className = 'ytp-caption-window-container';
  native.textContent = 'Native caption';
  player.append(video, native);
  document.body.append(player);
  for (const element of [player, video])
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 640,
      bottom: 360,
      width: 640,
      height: 360,
    } as DOMRect);
  scope = { generation: crypto.randomUUID(), trackKey: 'track', player, ready: true };
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, options) {
    shadow = attach.call(this, options);
    return shadow;
  });
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
  Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: null });
  overlay = makeOverlay();
  guard = installDisplayLease(window, () => scope);
});
afterEach(() => {
  guard.dispose();
  overlay.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('renders text before a lease can hide native appearance without changing native text or CC', () => {
  message();
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  expect(overlay.render(rows, 'bilingual')).toBe(true);
  message();
  expect(player.getAttribute(HIDDEN_ATTRIBUTE)).toBe(overlay.owner);
  expect(getComputedStyle(native).visibility).toBe('hidden');
  expect(native.textContent).toBe('Native caption');
  expect(shadow.querySelector('img')).toBeNull();
  expect(shadow.textContent).toContain(rows[0]!.original);
  overlay.clear();
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
});
it('restores native for gaps and incomplete translation-only rows, then permits a current new group', async () => {
  overlay.render(rows, 'bilingual');
  message();
  expect(
    overlay.render(
      [...rows, { unitId: 'next', original: 'second', translation: undefined }],
      'translation',
    ),
  ).toBe(false);
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  expect(overlay.host.hidden).toBe(true);
  await vi.advanceTimersByTimeAsync(250);
  expect(overlay.render(rows, 'translation')).toBe(true);
  message();
  expect(player.getAttribute(HIDDEN_ATTRIBUTE)).toBe(overlay.owner);
  expect(overlay.render([], 'bilingual')).toBe(false);
  await vi.advanceTimersByTimeAsync(250);
  overlay.render(rows, 'bilingual');
  message();
  expect(player.getAttribute(HIDDEN_ATTRIBUTE)).toBe(overlay.owner);
});
it('expires a lost isolated controller lease and never revives that owner with a delayed renewal', async () => {
  overlay.render(rows, 'bilingual');
  message();
  await vi.advanceTimersByTimeAsync(2000);
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  message();
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
});
it('restores before processing queued renewal after a long execution gap', () => {
  overlay.render(rows, 'bilingual');
  message();
  vi.setSystemTime(Date.now() + 3000);
  message();
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
});
it('does not let stopped owners or old cleanup alter a newer owner', () => {
  overlay.render(rows, 'bilingual');
  message();
  const old = overlay.owner;
  message('stop');
  message();
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  const next = makeOverlay();
  next.render(rows, 'bilingual');
  message('renew', next.owner);
  message('renew', old);
  message('stop', old);
  overlay.dispose();
  expect(player.getAttribute(HIDDEN_ATTRIBUTE)).toBe(next.owner);
  next.dispose();
});
it.each(['generation', 'trackKey', 'ready'] as const)(
  'restores on %s invalidation and rejects old scope renewal',
  async (field) => {
    overlay.render(rows, 'bilingual');
    message();
    const old = { generation: scope.generation, trackKey: scope.trackKey };
    if (field === 'ready') scope.ready = false;
    else scope[field] = field === 'generation' ? crypto.randomUUID() : 'other';
    await vi.advanceTimersByTimeAsync(250);
    expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
    message('renew', overlay.owner, old);
    expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  },
);
it('restores on actual node replacement or removed overlay', async () => {
  overlay.render(rows, 'bilingual');
  message();
  video.replaceWith(document.createElement('video'));
  await vi.advanceTimersByTimeAsync(250);
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  expect(overlay.render(rows, 'bilingual')).toBe(false);
  player.prepend(video);
  player.querySelectorAll('video')[1]!.remove();
  const next = makeOverlay();
  next.render(rows, 'bilingual');
  message('renew', next.owner);
  next.host.remove();
  await vi.advanceTimersByTimeAsync(250);
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  next.dispose();
});
it('checks fullscreen containment and PiP, preserving native on unsupported display surfaces', async () => {
  Object.defineProperty(document, 'fullscreenElement', { value: player });
  expect(overlay.render(rows, 'bilingual')).toBe(true);
  message();
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(true);
  Object.defineProperty(document, 'fullscreenElement', { value: video });
  await vi.advanceTimersByTimeAsync(250);
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  expect(overlay.render(rows, 'bilingual')).toBe(false);
  Object.defineProperty(document, 'fullscreenElement', { value: null });
  Object.defineProperty(document, 'pictureInPictureElement', { value: video });
  expect(overlay.render(rows, 'bilingual')).toBe(false);
  Object.defineProperty(document, 'pictureInPictureElement', { value: null });
  overlay.render(rows, 'bilingual');
  message();
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(true);
});
it('restores synchronously on lifecycle handlers and guard disposal', () => {
  overlay.render(rows, 'bilingual');
  message();
  document.dispatchEvent(new Event('freeze'));
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  message();
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  guard.dispose();
  expect(document.head.querySelector('style')).toBeNull();
});
it('bounds visual layout and appearance without partially replacing unsupported content', () => {
  overlay.appearance(1000, -99);
  expect(overlay.host.style.getPropertyValue('--sayvia-caption-size')).toBe('48px');
  expect(overlay.host.style.getPropertyValue('--sayvia-caption-bottom')).toBe('16px');
  expect(
    overlay.render(
      Array.from({ length: 9 }, () => rows[0]!),
      'bilingual',
    ),
  ).toBe(false);
  expect(overlay.render([{ ...rows[0]!, original: 'x'.repeat(16001) }], 'bilingual')).toBe(false);
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
});

it('retains ownership across a normal gap so the replaced owner cannot reclaim display', async () => {
  overlay.render(rows, 'bilingual');
  message();
  const old = overlay.owner;
  overlay.clear();
  await vi.advanceTimersByTimeAsync(250);
  const next = makeOverlay();
  next.render(rows, 'bilingual');
  message('renew', next.owner);
  expect(player.getAttribute(HIDDEN_ATTRIBUTE)).toBe(next.owner);
  overlay.render(rows, 'bilingual');
  message('renew', old);
  message('stop', old);
  expect(player.getAttribute(HIDDEN_ATTRIBUTE)).toBe(next.owner);
  next.dispose();
});
it('restores if its own hiding stylesheet disappears', async () => {
  overlay.render(rows, 'bilingual');
  message();
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(true);
  document.head.querySelector('style')!.remove();
  await vi.advanceTimersByTimeAsync(250);
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
});

it('refuses full or partial clipping instead of hiding the native captions under an invisible overlay', () => {
  for (const top of [-60, -10, 330]) {
    vi.mocked(overlay.host.getBoundingClientRect).mockReturnValue({
      left: 20,
      right: 620,
      width: 600,
      top,
      bottom: top + 70,
      height: 70,
    } as DOMRect);
    expect(overlay.render(rows, 'bilingual')).toBe(false);
    message();
    expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  }
});
