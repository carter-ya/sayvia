import { expect, it, vi } from 'vitest';
import { RELEASE_SAMPLES } from '../../src/evaluation/release-samples';
import { M1_SAMPLES } from '../../src/evaluation/samples';
import { SourceInputSchema } from '../../src/core/source-input';
import {
  createTranslationPlan,
  needsTranslation,
  reconstructTranslation,
} from '../../src/core/translation-plan';
import { planResponse } from '../fixtures/plan-response';
import { runEvaluation } from '../../src/evaluation/run-evaluation';
it('extends the unchanged 12 M1 cases to 30 unique public cases across three source types', () => {
  expect(RELEASE_SAMPLES).toHaveLength(30);
  expect(RELEASE_SAMPLES.slice(0, 12)).toEqual(M1_SAMPLES);
  expect(new Set(RELEASE_SAMPLES.map((sample) => sample.id)).size).toBe(30);
  expect(
    Object.fromEntries(
      ['markdown', 'plain-text', 'dom-selection'].map((kind) => [
        kind,
        RELEASE_SAMPLES.filter((sample) => sample.source.kind === kind).length,
      ]),
    ),
  ).toEqual({ markdown: 12, 'plain-text': 9, 'dom-selection': 9 });
});
it.each(RELEASE_SAMPLES.slice(12))(
  '$id preserves declared code/links and has a valid translatable source',
  (sample) => {
    expect(SourceInputSchema.safeParse(sample.source).success).toBe(true);
    const plan = createTranslationPlan(sample.source);
    expect(needsTranslation(plan)).toBe(true);
    expect(reconstructTranslation(plan, planResponse(plan))).toBe(sample.source.text);
    const rebuilt = reconstructTranslation(
      plan,
      planResponse(plan, () => 'Translated text'),
    );
    for (const text of sample.protectedText) expect(rebuilt).toContain(text);
    expect(sample.referenceMeaning.trim()).not.toBe('');
    expect(sample.reviewFocus.trim()).not.toBe('');
  },
);
it('executes the selected 30-case suite once per case while retaining pending human quality fields', async () => {
  // Echo mock verifies transport/cardinality/structure, never translation quality.
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    return new Response(
      JSON.stringify({
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                segments: input.segments
                  .filter((part: { text?: string }) => part.text !== undefined)
                  .map((part: { id: string; text: string }) => ({ id: part.id, text: part.text })),
              }),
            },
          },
        ],
      }),
    );
  });
  const report = await runEvaluation(
    { baseUrl: 'https://example.test', model: 'fixture', apiKey: 'DUMMY_RELEASE_KEY' },
    () => undefined,
    fetcher,
    RELEASE_SAMPLES,
  );
  expect(fetcher).toHaveBeenCalledTimes(30);
  expect(report.sampleCount).toBe(30);
  expect(report.automatedPassed).toBe(true);
  expect(
    report.entries.every(
      (entry) => entry.semanticReview === 'pending' && entry.usabilityReview === 'pending',
    ),
  ).toBe(true);
  expect(JSON.stringify(report)).not.toContain('DUMMY_RELEASE_KEY');
});
