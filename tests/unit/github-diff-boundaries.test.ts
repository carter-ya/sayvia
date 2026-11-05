// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://github.com/exc-works/migrate/pull/21/changes"}
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReadingSelectionCache } from '../../src/adapters/selection-cache';
import { createTranslationPlan, translationPayload } from '../../src/core/translation-plan';
import { moduleComments, moduleDiff } from '../fixtures/github-module-diff';

const line = (i: number) => document.getElementById(`line-${i}`)!;
const number = (i: number) => document.getElementById(`number-${i}`)!;
function capture(range: Range) {
  const cache = new ReadingSelectionCache(true);
  const source = cache.captureRange(range, document);
  return {
    cache,
    text: cache.readText(document),
    payload: translationPayload(createTranslationPlan(source)),
  };
}
beforeEach(() => {
  document.body.innerHTML = moduleDiff();
});
afterEach(() => {
  document.body.replaceChildren();
});

describe('GitHub diff selection boundaries', () => {
  it.each(['gutter', 'marker', 'code', 'cell'])(
    'translates all three comments when the selection starts in the %s',
    (kind) => {
      const range = document.createRange();
      const start =
        kind === 'gutter'
          ? number(0).firstChild!
          : kind === 'marker'
            ? line(0).parentElement!.firstChild!.firstChild!
            : kind === 'code'
              ? line(0).parentElement!
              : line(0).closest('td')!;
      range.setStart(start, 0);
      range.setEnd(line(2), line(2).childNodes.length);
      const result = capture(range);
      expect(result.text).toBe(moduleComments.join('\n'));
      expect(result.payload.segments.map((s) => s.text)).toEqual(moduleComments);
    },
  );
  it('keeps partial text boundaries when the selection ends at the outer cell', () => {
    const range = document.createRange();
    range.setStart(line(0).firstChild!.firstChild!, 3);
    const cell = line(2).closest('td')!;
    range.setEnd(cell, cell.childNodes.length);
    expect(capture(range).text).toBe(
      [moduleComments[0]!.slice(3), ...moduleComments.slice(1)].join('\n'),
    );
  });
  it('does not expand a selection ending in the next line number into that line', () => {
    const range = document.createRange();
    range.setStart(number(0), 0);
    range.setEnd(number(2).firstChild!, 2);
    expect(capture(range).text).toBe(moduleComments.slice(0, 2).join('\n'));
  });
  it.each(['gutter', 'marker'])('does not translate or expand a %s-only selection', (kind) => {
    const range = document.createRange();
    range.selectNodeContents(kind === 'gutter' ? number(0) : line(0).parentElement!.firstChild!);
    expect(() => capture(range)).toThrow('EMPTY_SOURCE');
  });
  it('retains Markdown protection when a gutter boundary is normalized', () => {
    document.querySelector('table')!.setAttribute('aria-label', 'Diff for: README.md');
    line(0).textContent = 'Read `PRIVATE_CODE` and [guide](PRIVATE_TARGET).';
    const range = document.createRange();
    range.setStart(number(0), 0);
    range.setEnd(line(0), line(0).childNodes.length);
    const result = capture(range);
    expect(result.text).toBe('Read `PRIVATE_CODE` and [guide](PRIVATE_TARGET).');
    expect(JSON.stringify(result.payload)).toContain('Read');
    expect(JSON.stringify(result.payload)).not.toMatch(/PRIVATE_CODE|PRIVATE_TARGET/);
  });
  it('rejects a gutter on the opposite source side', () => {
    number(0).setAttribute('data-diff-side', 'left');
    const range = document.createRange();
    range.setStart(number(0), 0);
    range.setEnd(line(2), line(2).childNodes.length);
    expect(() => capture(range)).toThrow('UNSUPPORTED_SELECTION');
  });
  it('rejects conflicting gutter line metadata', () => {
    number(0).setAttribute('data-line-number', '99');
    const range = document.createRange();
    range.setStart(number(0), 0);
    range.setEnd(line(2), line(2).childNodes.length);
    expect(() => capture(range)).toThrow('UNSUPPORTED_SELECTION');
  });
  it('invalidates the capture if the selected source side changes', () => {
    const range = document.createRange();
    range.setStart(number(0), 0);
    range.setEnd(line(2), line(2).childNodes.length);
    const { cache } = capture(range);
    number(0).setAttribute('data-diff-side', 'left');
    expect(() => cache.read(document)).toThrow('SELECTION_LOST');
  });
});
