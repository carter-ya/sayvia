import { describe, expect, it } from 'vitest';
import { M1_SAMPLES } from '../../src/evaluation/samples';
import { planResponse } from '../fixtures/plan-response';
import {
  createTranslationPlan,
  needsTranslation,
  reconstructTranslation,
  translationPayload,
} from '../../src/core/translation-plan';

describe('fixed public M1 evaluation samples', () => {
  it('has the same 12 stable, uniquely identified cases for each provider', () => {
    expect(M1_SAMPLES).toHaveLength(12);
    expect(new Set(M1_SAMPLES.map((sample) => sample.id)).size).toBe(12);
    expect(new Set(M1_SAMPLES.map((sample) => sample.source.kind)).size).toBe(3);
  });

  it.each(M1_SAMPLES)('$id: $title has a reconstructible plan with local protection', (sample) => {
    const plan = createTranslationPlan(sample.source);
    expect(needsTranslation(plan)).toBe(true);
    expect(reconstructTranslation(plan, planResponse(plan))).toBe(sample.source.text);
    const synthetic = planResponse(plan, () => 'Translated text');
    const output = reconstructTranslation(plan, synthetic);
    for (const token of sample.protectedText) expect(output).toContain(token);

    const json = JSON.stringify(translationPayload(plan));
    for (const token of sample.protectedText) {
      expect(sample.source.text).toContain(token);
      // Single-character syntax can also occur in JSON delimiters, not source text.
      for (const part of translationPayload(plan).segments) {
        if ('text' in part) expect(part.text).not.toContain(token);
      }
    }
    expect(json).not.toContain('referenceMeaning');
    expect(json).not.toContain('reviewFocus');
  });
});
