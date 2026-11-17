import { z } from 'zod';
const Count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const UsageSchema = z
  .object({
    inputTokens: Count,
    outputTokens: Count,
    totalTokens: Count,
    reasoningTokens: Count.optional(),
  })
  .strict();
export type TokenUsage = z.infer<typeof UsageSchema>;
export const EstimatesSchema = z.object({ inputTokens: Count, outputTokens: Count }).strict();
const TimingSchema = z
  .object({
    responseHeadersMs: z.number().nonnegative(),
    firstContentMs: z.number().nonnegative().optional(),
  })
  .strict();
export const ProgressSchema = z
  .object({
    text: z.string().max(48_000),
    elapsedMs: z.number().nonnegative().max(120_000),
    phase: z.enum(['connecting', 'waiting', 'thinking', 'translating', 'validating']),
    estimates: EstimatesSchema,
    usage: UsageSchema.optional(),
    timing: TimingSchema.optional(),
  })
  .strict();
export type TranslationProgress = z.infer<typeof ProgressSchema>;
export const TranslationResultSchema = z
  .object({
    text: z.string().max(48_000),
    requested: z.boolean(),
    durationMs: z.number().nonnegative(),
    algorithmVersion: z.string().max(80),
    streamed: z.boolean().optional(),
    usage: UsageSchema.optional(),
    timing: TimingSchema.optional(),
    estimates: EstimatesSchema.optional(),
  })
  .strict();
export const ResultMetricsSchema = TranslationResultSchema.omit({
  text: true,
  algorithmVersion: true,
});
export type ResultMetrics = z.infer<typeof ResultMetricsSchema>;
export type TranslationResult = z.infer<typeof TranslationResultSchema>;
