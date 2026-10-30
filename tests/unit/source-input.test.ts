import { describe, expect, it } from 'vitest';
import { MAX_SOURCE_CHARACTERS, parseSourceInput } from '../../src/core/source-input';

describe('translation source contract', () => {
  it('keeps source types explicit and does not normalize source bytes', () => {
    for (const kind of ['plain-text', 'markdown'] as const) {
      const source = { kind, text: '  中文\n<literal> #123' };
      expect(parseSourceInput(source)).toEqual(source);
    }
  });

  it('counts Unicode code points separately from UTF-16 spans', () => {
    const text = '🙂'.repeat(MAX_SOURCE_CHARACTERS);
    expect(parseSourceInput({ kind: 'plain-text', text }).text).toBe(text);
    expect(() => parseSourceInput({ kind: 'plain-text', text: text + 'a' })).toThrow(
      'SOURCE_TOO_LONG',
    );
  });

  it.each(['', ' \t\n'])('rejects empty source without creating a task', (text) => {
    expect(() => parseSourceInput({ kind: 'plain-text', text })).toThrow('EMPTY_SOURCE');
  });

  it('rejects malformed Unicode and unknown input kinds', () => {
    expect(() => parseSourceInput({ kind: 'plain-text', text: '\ud800' })).toThrow(
      'INVALID_SOURCE',
    );
    expect(() => parseSourceInput({ kind: 'html', text: '<script>bad()</script>' })).toThrow(
      'INVALID_SOURCE',
    );
  });

  it('allows paragraph marks across protected code but rejects overlapping protections', () => {
    const source = {
      kind: 'dom-selection',
      text: 'read timeout',
      protectedRanges: [{ kind: 'inline-code', start: 5, end: 12 }],
      marks: [{ kind: 'paragraph', start: 0, end: 12 }],
    };
    expect(parseSourceInput(source)).toEqual(source);
    expect(() =>
      parseSourceInput({
        ...source,
        protectedRanges: [...source.protectedRanges, { kind: 'url', start: 6, end: 12 }],
      }),
    ).toThrow('INVALID_SOURCE');
  });

  it('rejects out-of-bounds and surrogate-splitting metadata', () => {
    const source = { kind: 'dom-selection', text: '🙂a', protectedRanges: [], marks: [] };
    expect(() =>
      parseSourceInput({
        ...source,
        protectedRanges: [{ kind: 'inline-code', start: 1, end: 2 }],
      }),
    ).toThrow('INVALID_SOURCE');
    expect(() =>
      parseSourceInput({
        ...source,
        marks: [{ kind: 'paragraph', start: 0, end: 99 }],
      }),
    ).toThrow('INVALID_SOURCE');
    expect(
      parseSourceInput({
        ...source,
        protectedRanges: [{ kind: 'inline-code', start: 0, end: 2 }],
      }).text,
    ).toBe('🙂a');
  });

  it('does not accept hidden HTML or link targets in source metadata', () => {
    expect(() =>
      parseSourceInput({
        kind: 'dom-selection',
        text: 'documentation',
        protectedRanges: [],
        marks: [{ kind: 'link-label', start: 0, end: 13, href: 'https://private.example/secret' }],
      }),
    ).toThrow('INVALID_SOURCE');
    expect(() =>
      parseSourceInput({
        kind: 'plain-text',
        text: 'visible',
        innerHTML: '<b>hidden</b>',
      }),
    ).toThrow('INVALID_SOURCE');
  });
});
