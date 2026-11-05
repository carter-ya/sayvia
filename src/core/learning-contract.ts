import { z } from 'zod';

const text = (limit: number) =>
  z
    .string()
    .max(limit * 2)
    .trim()
    .min(1)
    .refine((value) => [...value].length <= limit);

const identifier = (limit: number) =>
  z
    .string()
    .min(1)
    .max(limit)
    .refine((value) => value === value.trim());

export const LocaleSchema = z
  .string()
  .max(40)
  .transform((value, ctx) => {
    try {
      if (value === 'auto') throw new Error('INVALID_LOCALE');
      const canonical = Intl.getCanonicalLocales(value);
      if (canonical.length !== 1) throw new Error('INVALID_LOCALE');
      return canonical[0]!;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid language tag' });
      return z.NEVER;
    }
  });
export const LookupInputSchema = z
  .object({
    text: text(80),
    sourceLanguage: z.union([z.literal('auto'), LocaleSchema]),
    explanationLanguage: LocaleSchema,
  })
  .strict();
export type LookupInput = z.infer<typeof LookupInputSchema>;

export const LookupResultSchema = z
  .object({
    detectedLanguage: LocaleSchema.nullable(),
    meanings: z
      .array(
        z
          .object({
            partOfSpeech: text(48).nullable(),
            definition: text(300),
          })
          .strict(),
      )
      .min(1)
      .max(3),
    example: z
      .object({ text: text(240), translation: text(400) })
      .strict()
      .nullable(),
    note: text(240).nullable(),
  })
  .strict();
export type LookupResult = z.infer<typeof LookupResultSchema>;

export const CaptionIdentitySchema = z
  .object({
    sessionId: z.uuid(),
    generation: z.int().nonnegative(),
    videoId: text(64),
    trackKey: text(256),
    batchId: z.uuid(),
  })
  .strict();
export const CaptionUnitSchema = z
  .object({
    unitId: identifier(160),
    revision: z.int().nonnegative(),
    text: text(4000),
  })
  .strict();
export const CaptionInputSchema = CaptionIdentitySchema.extend({
  sourceLanguage: LocaleSchema,
  targetLanguage: LocaleSchema,
  units: z.array(CaptionUnitSchema).min(1).max(20),
}).superRefine((value, ctx) => {
  if (new Set(value.units.map((unit) => unit.unitId)).size !== value.units.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate caption ID', path: ['units'] });
  if (value.units.reduce((size, unit) => size + [...unit.text].length, 0) > 6000)
    ctx.addIssue({ code: 'custom', message: 'Caption batch too large', path: ['units'] });
});
export type CaptionInput = z.infer<typeof CaptionInputSchema>;

export const LearningInputSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('lookup'), input: LookupInputSchema }).strict(),
  z.object({ purpose: z.literal('captions'), input: CaptionInputSchema }).strict(),
]);
export type LearningInput = z.infer<typeof LearningInputSchema>;

export const CaptionResultSchema = CaptionIdentitySchema.extend({
  units: z.array(CaptionUnitSchema).min(1).max(20),
}).superRefine((value, ctx) => {
  if (
    new Set(value.units.map((unit) => unit.unitId)).size !== value.units.length ||
    value.units.reduce((size, unit) => size + [...unit.text].length, 0) > 48000
  )
    ctx.addIssue({ code: 'custom', message: 'Invalid caption result', path: ['units'] });
});
export type CaptionResult = z.infer<typeof CaptionResultSchema>;
export const LearningValueSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('lookup'), value: LookupResultSchema }).strict(),
  z.object({ purpose: z.literal('captions'), value: CaptionResultSchema }).strict(),
]);
export type LearningValue = z.infer<typeof LearningValueSchema>;

export class LearningFormatError extends Error {
  constructor() {
    super('FORMAT_INVALID');
  }
}

function boundedJson(content: string, limit: number): unknown {
  if (content.length > limit || new TextEncoder().encode(content).length > limit)
    throw new LearningFormatError();
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new LearningFormatError();
  }
}

export function parseLookupResult(content: string): LookupResult {
  const parsed = LookupResultSchema.safeParse(boundedJson(content, 16 * 1024));
  if (!parsed.success) throw new LearningFormatError();
  return parsed.data;
}

const CaptionModelResult = z
  .object({
    cues: z
      .array(
        z
          .object({
            id: identifier(160),
            text: text(4000).refine((value) => !/[\r\n]/.test(value)),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

// Times, revisions and document identity are reconstructed from the trusted local request.
export function parseCaptionResult(content: string, input: CaptionInput): CaptionResult {
  const source = CaptionInputSchema.safeParse(input);
  const parsed = CaptionModelResult.safeParse(boundedJson(content, 256 * 1024));
  if (
    !source.success ||
    !parsed.success ||
    parsed.data.cues.length !== source.data.units.length ||
    parsed.data.cues.some((cue, index) => cue.id !== source.data.units[index]?.unitId)
  )
    throw new LearningFormatError();
  const identity = CaptionIdentitySchema.parse({
    sessionId: source.data.sessionId,
    generation: source.data.generation,
    videoId: source.data.videoId,
    trackKey: source.data.trackKey,
    batchId: source.data.batchId,
  });
  const result = CaptionResultSchema.safeParse({
    ...identity,
    units: source.data.units.map((unit, index) => ({
      ...unit,
      text: parsed.data.cues[index]!.text,
    })),
  });
  if (!result.success) throw new LearningFormatError();
  return result.data;
}
