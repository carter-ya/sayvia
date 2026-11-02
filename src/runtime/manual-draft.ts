import { z } from 'zod';
import { ResultMetricsSchema, type TranslationProgress } from './translation-progress';
import { LanguageSchema } from './executor-protocol';
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
  .strict();
export const ManualSave = z
  .object({
    type: z.literal('translation.manual.save'),
    protocolVersion: z.literal(1),
    requestId: z.uuid(),
    payload: z
      .object({
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
export type ManualSavePayload = z.infer<typeof ManualSave>['payload'];
export type ManualDraftView = Pick<
  z.infer<typeof ManualRecord>,
  | 'tabId'
  | 'clientTaskId'
  | 'documentNonce'
  | 'input'
  | 'result'
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
