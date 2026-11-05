// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CaptionOverlay } from '../../src/captions/overlay';

let player: HTMLDivElement;
let video: HTMLVideoElement;
let overlay: CaptionOverlay;
const open = vi.fn();

beforeEach(() => {
  document.body.replaceChildren();
  open.mockReset();
  player = document.createElement('div');
  video = document.createElement('video');
  player.append(video);
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
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
  Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: null });
  overlay = new CaptionOverlay(player, video, { language: 'ar', open });
  vi.spyOn(overlay.host, 'getBoundingClientRect').mockReturnValue({
    left: 20,
    top: 220,
    right: 620,
    bottom: 290,
    width: 600,
    height: 70,
  } as DOMRect);
});
afterEach(() => {
  overlay.dispose();
  vi.restoreAllMocks();
});

it('retains the source word node and its focus when only its translation changes', () => {
  const row = { unitId: 'g', original: 'مرحبا بالعالم', translation: undefined };
  expect(overlay.render([row], 'bilingual')).toBe(true);
  const shadow = overlay.host.shadowRoot!;
  const word = shadow.querySelector<HTMLButtonElement>('button')!;
  word.focus();
  expect(shadow.activeElement).toBe(word);
  expect(overlay.render([{ ...row, translation: '你好，世界' }], 'bilingual')).toBe(true);
  expect(shadow.querySelector('button')).toBe(word);
  expect(shadow.activeElement).toBe(word);
  expect(shadow.querySelector('.translation')?.textContent).toBe('你好，世界');
});

it('renders markup in both languages as exact text, with only source words interactive', () => {
  const original = '<img src=x onerror=alert(1)> مرحبا\n& "العالم"';
  const translation = '<script>alert(1)</script> 译文';
  expect(overlay.render([{ unitId: 'g', original, translation }], 'bilingual')).toBe(true);
  const shadow = overlay.host.shadowRoot!;
  expect(shadow.querySelector('.original')?.textContent).toBe(original);
  expect(shadow.querySelector('.translation')?.textContent).toBe(translation);
  expect(shadow.querySelector('img, script')).toBeNull();
  expect(shadow.querySelector('.translation button')).toBeNull();
  const source = shadow.querySelector<HTMLElement>('.original')!;
  expect(source.lang).toBe('ar');
  expect(source.dir).toBe('auto');
  const word = source.querySelector('button')!;
  expect(word.type).toBe('button');
  expect(word.getAttribute('aria-label')).toBe(`查词：${word.textContent}`);
});

it('rejects synthetic activation and prevents word keyboard/click events reaching the player', () => {
  overlay.render([{ unitId: 'g', original: 'مرحبا', translation: '你好' }], 'bilingual');
  const word = overlay.host.shadowRoot!.querySelector('button')!;
  const listener = vi.fn();
  for (const type of ['click', 'keydown', 'keyup']) player.addEventListener(type, listener);
  word.click();
  for (const type of ['keydown', 'keyup'])
    word.dispatchEvent(new KeyboardEvent(type, { key: ' ', bubbles: true, composed: true }));
  expect(open).not.toHaveBeenCalled();
  expect(listener).not.toHaveBeenCalled();
  overlay.clear();
  word.click();
  expect(open).not.toHaveBeenCalled();
});

it('does not create word controls in translation-only mode', () => {
  expect(
    overlay.render([{ unitId: 'g', original: 'مرحبا', translation: '你好' }], 'translation'),
  ).toBe(true);
  expect(overlay.host.shadowRoot!.querySelector('button, .original')).toBeNull();
});
