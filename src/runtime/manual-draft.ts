import { z } from 'zod';
import { ResultMetricsSchema, type TranslationProgress } from './translation-progress';
import { LanguageSchema } from './executor-protocol';
import { LookupResultSchema } from '../core/learning-contract';
// A draft may be temporarily blank; every nonblank value follows the start protocol.
const DraftLanguage = z
  .string()
  .trim()
  .pipe(LanguageSchema.or(z.literal('')));
export const ManualRecord = z
  .object({
    tabId: z.int().nonnegative(),
    clientTaskId: z.uuid(),
    documentNonce: z.uuid(),
    input: z.string().max(24_000),
    purpose: z.enum(['translate', 'lookup']).optional(),
    lookupResult: LookupResultSchema.optional(),
    result: z.string().max(48_000).optional(),
    metrics: ResultMetricsSchema.optional(),
    targetLanguage: DraftLanguage.optional(),
    sourceLanguage: DraftLanguage.optional(),
    providerId: z.uuid().optional(),
    revision: z.int().nonnegative().optional(),
    editSession: z.uuid().optional(),
    editSequence: z.int().nonnegative().optional(),
    editBaseRevision: z.int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.purpose === 'lookup' &&
        (value.result !== undefined || [...value.input].length > 80)) ||
      (value.purpose !== 'lookup' && value.lookupResult !== undefined)
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid draft purpose' });
  });
const TranslationManualSave = z
  .object({
    type: z.literal('translation.manual.save'),
    protocolVersion: z.literal(1),
    requestId: z.uuid(),
    payload: z
      .object({
        purpose: z.literal('translate').optional(),
        generation: z.uuid(),
        tabId: z.int().nonnegative(),
        input: z
          .string()
          .max(24_000)
          .refine((value) => [...value].length <= 12_000),
        result: z.string().max(48_000),
        targetLanguage: DraftLanguage,
        sourceLanguage: DraftLanguage.optional(),
        providerId: z.uuid().optional(),
        editSession: z.uuid(),
        sequence: z.int().nonnegative(),
        expectedRevision: z.int().nonnegative(),
      })
      .strict(),
  })
  .strict();
const LookupManualSave = z
  .object({
    type: z.literal('learning.manual.save'),
    protocolVersion: z.literal(1),
    requestId: z.uuid(),
    payload: TranslationManualSave.shape.payload
      .omit({ result: true, purpose: true, input: true })
      .extend({
        purpose: z.literal('lookup'),
        input: z
          .string()
          .max(160)
          .refine((value) => [...value].length <= 80),
      }),
  })
  .strict();
export const ManualSave = z.discriminatedUnion('type', [TranslationManualSave, LookupManualSave]);
export type ManualSavePayload = z.infer<typeof ManualSave>['payload'];
export type ManualDraftView = Pick<
  z.infer<typeof ManualRecord>,
  | 'tabId'
  | 'clientTaskId'
  | 'documentNonce'
  | 'input'
  | 'result'
  | 'purpose'
  | 'lookupResult'
  | 'metrics'
  | 'targetLanguage'
  | 'sourceLanguage'
  | 'providerId'
  | 'revision'
> & {
  task?: {
    state: string;
    startedAt?: number;
    progress?: TranslationProgress;
    error?: string;
    provider?: { model: string };
  };
};

export const PopupContext = z
  .object({ type: z.literal('popup.context'), tabId: z.int().nonnegative() })
  .strict();
