import { describe, expect, it } from 'vitest';
import { validateEditedTranslation } from '../../src/core/translation-plan';

describe('full candidate editing protection', () => {
  it('permits natural prose changes around preserved markdown and URLs', () => {
    const baseline = 'Read **the guide** [here](https://example.test) with `timeout`.';
    expect(
      validateEditedTranslation(
        'markdown',
        baseline,
        'Please read **our guide** [there](https://example.test) using `timeout`.',
      ),
    ).toBe(true);
  });
  it.each([
    ['Use `timeout` now.', 'Use `retries` now.'],
    ['Read [guide](https://safe.test).', 'Read [guide](https://other.test).'],
    ['Before <span>SECRET</span> after.', 'Before <span>CHANGED</span> after.'],
    ['First\nsecond', 'First second'],
    ['> First\n> second', '> First\nsecond'],
    ['- item\n  next', '- item\n next'],
    ['Hello **world**', 'Hello <img src="https://x.test"> world'],
    ['Code `a  b`', 'Code `a b`'],
  ])('rejects protected or structural changes: %s', (baseline, candidate) => {
    expect(validateEditedTranslation('markdown', baseline, candidate)).toBe(false);
  });
  it('treats plain syntax literally while preserving its addresses and exact line breaks', () => {
    expect(
      validateEditedTranslation(
        'plain-text',
        '<literal> hello\nhttps://example.test',
        '**literal** hi\nhttps://example.test',
      ),
    ).toBe(true);
    expect(
      validateEditedTranslation('plain-text', 'Hello @carter-ya #4', 'Hello @someone #4'),
    ).toBe(false);
    expect(validateEditedTranslation('plain-text', 'First\r\nsecond', 'First\nsecond')).toBe(false);
  });
  it('supports valid output above the input limit and rejects controls or oversized edits', () => {
    const baseline = 'a'.repeat(15_000);
    expect(validateEditedTranslation('markdown', baseline, baseline + 'b')).toBe(true);
    expect(validateEditedTranslation('plain-text', 'hello', 'x'.repeat(24_001))).toBe(false);
    expect(validateEditedTranslation('plain-text', 'hello', 'bad\u0000text')).toBe(false);
    expect(validateEditedTranslation('plain-text', 'hello', '\ud800')).toBe(false);
  });
});
