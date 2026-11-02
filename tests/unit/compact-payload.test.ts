import { describe, expect, it } from 'vitest';
import { createTranslationPlan, translationPayload } from '../../src/core/translation-plan';
import { RELEASE_SAMPLES } from '../../src/evaluation/release-samples';

describe('compact model protection metadata', () => {
  it('sends the MySQL sentence with a string marker and keeps the URL local', () => {
    const url = 'https://dev.mysql.com/doc/refman/8.4/en/json-function-reference.html';
    const plan = createTranslationPlan({
      kind: 'plain-text',
      text: `To which function JSON_* you are referring to? ${url}`,
    });
    expect(translationPayload(plan)).toEqual({
      segments: [
        {
          id: 's0',
          text: 'To which function JSON_* you are referring to? ⟦SV0:1⟧',
          protectedTokens: ['⟦SV0:1⟧'],
        },
      ],
    });
    expect(JSON.stringify(translationPayload(plan))).not.toContain(url);
  });

  it('preserves explicit format roles while omitting false whitespace flags', () => {
    const plan = createTranslationPlan({ kind: 'markdown', text: 'Read **this** first.' });
    expect(translationPayload(plan).segments[0]!.protectedTokens).toEqual([
      { marker: '⟦SV0:2⟧', role: 'format-open' },
      { marker: '⟦SV0:3⟧', role: 'format-close' },
    ]);
  });

  it('keeps true whitespace flags on a protected DOM code value', () => {
    const text = 'Read \u00a0limit\u00a0 only if the request fails.';
    const plan = createTranslationPlan({
      kind: 'dom-selection',
      text,
      protectedRanges: [{ kind: 'inline-code', start: 5, end: 12 }],
      marks: [],
    });
    const tokens = translationPayload(plan).segments.flatMap(
      (segment) => segment.protectedTokens ?? [],
    );
    expect(tokens).toContainEqual({
      marker: '⟦SV0:1⟧',
      role: 'content',
      leadingWhitespace: true,
      trailingWhitespace: true,
    });
  });

  it.each(RELEASE_SAMPLES)('retains every protection semantic for $id', (sample) => {
    const plan = createTranslationPlan(sample.source);
    const payload = translationPayload(plan);
    for (const [index, segment] of plan.segments.entries()) {
      const wire = payload.segments[index]!;
      expect(wire.text).toBe(segment.text);
      const expanded = (wire.protectedTokens ?? []).map((token) =>
        typeof token === 'string'
          ? { marker: token, role: 'content', leadingWhitespace: false, trailingWhitespace: false }
          : { leadingWhitespace: false, trailingWhitespace: false, ...token },
      );
      expect(expanded).toEqual(
        segment.tokens.map((token) => ({
          marker: token.marker,
          role: token.role,
          leadingWhitespace: token.leadingWhitespace,
          trailingWhitespace: token.trailingWhitespace,
        })),
      );
    }
  });
});
