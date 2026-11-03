import { afterEach, expect, it, vi } from 'vitest';
import { captionWords } from '../../src/captions/words';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ['en', 'Hello, world!'],
  ['zh', '你好，世界！'],
  ['ja', '私は日本語を勉強しています。'],
  ['ko', '한국어를 공부합니다.'],
  ['fr', 'Bonjour, les enfants !'],
  ['de', 'Wir lernen Deutsch.'],
  ['es', '¡Hola, mundo!'],
])('offers word fragments without changing the %s original', (language, original) => {
  const parts = captionWords(original, language);
  expect(parts.map((part) => part.text).join('')).toBe(original);
  expect(parts.some((part) => part.lookup)).toBe(true);
  for (const part of parts.filter((part) => part.lookup)) {
    expect([...part.text].length).toBeGreaterThan(0);
    expect([...part.text].length).toBeLessThanOrEqual(80);
  }
});

it('preserves punctuation, whitespace, combining marks, emoji and line breaks exactly', () => {
  const original = '  “cafe\u0301”,\t世界！\n👩🏽‍💻 — don’t\u00a0stop.  ';
  const parts = captionWords(original, 'en');
  expect(parts.map((part) => part.text).join('')).toBe(original);
  expect(parts.find((part) => part.text === 'cafe\u0301')?.lookup).toBe(true);
  expect(parts.find((part) => part.text.includes('👩'))?.lookup).toBe(false);
  expect(
    parts.filter((part) => /^[\s\p{P}\p{S}]+$/u.test(part.text)).every((part) => !part.lookup),
  ).toBe(true);
});

it('uses code points for the 80-character limit and keeps longer words as text', () => {
  const accepted = '𐐀'.repeat(80);
  const rejected = '𐐀'.repeat(81);
  expect(captionWords(accepted, 'en')).toEqual([{ text: accepted, lookup: true }]);
  expect(captionWords(rejected, 'en')).toEqual([{ text: rejected, lookup: false }]);
});

it('falls back to the whole unchanged text when the locale is unsupported', () => {
  vi.spyOn(Intl.Segmenter, 'supportedLocalesOf').mockReturnValue([]);
  expect(captionWords('A 字幕！', 'zz')).toEqual([{ text: 'A 字幕！', lookup: false }]);
});

it('falls back when the locale is malformed or the segmentation engine is unavailable', () => {
  expect(captionWords('A 字幕！', 'not_a_locale')).toEqual([{ text: 'A 字幕！', lookup: false }]);
  vi.stubGlobal('Intl', Object.create(Intl, { Segmenter: { value: undefined } }));
  expect(captionWords('A 字幕！', 'en')).toEqual([{ text: 'A 字幕！', lookup: false }]);
});

it('accepts 256 word controls but falls back without truncation at 257', () => {
  const accepted = Array.from({ length: 256 }, () => 'word').join(' , ');
  const rejected = `${accepted} , word`;
  const parts = captionWords(accepted, 'en');
  expect(parts.filter((part) => part.lookup)).toHaveLength(256);
  expect(parts.map((part) => part.text).join('')).toBe(accepted);
  expect(captionWords(rejected, 'en')).toEqual([{ text: rejected, lookup: false }]);
});
