import { z } from 'zod';
import {
  CaptionInputSchema,
  LearningValueSchema,
  LookupInputSchema,
} from '../core/learning-contract';
import { ResultMetricsSchema } from './translation-progress';

const Owner = {
  clientTaskId: z.uuid(),
  documentNonce: z.uuid(),
  providerId: z.uuid().optional(),
};
const LookupPage = z
  .object({
    ...Owner,
    purpose: z.literal('lookup'),
    origin: z.literal('page'),
    input: LookupInputSchema,
  })
  .strict();
const LookupManual = z
  .object({
    ...Owner,
    purpose: z.literal('lookup'),
    origin: z.literal('manual'),
    tabId: z.int().nonnegative(),
    manualRevision: z.int().nonnegative(),
    manualGeneration: z.uuid(),
    input: LookupInputSchema,
  })
  .strict();
export const LookupStartSchema = z.discriminatedUnion('origin', [LookupPage, LookupManual]);
export const CaptionStartSchema = z
  .object({
    ...Owner,
    purpose: z.literal('captions'),
    origin: z.literal('page'),
    input: CaptionInputSchema,
  })
  .strict();
export const LearningStartSchema = z.union([LookupStartSchema, CaptionStartSchema]);
export type LearningStart = z.infer<typeof LearningStartSchema>;
export const LearningStartMessage = z
  .object({
    protocolVersion: z.literal(1),
    requestId: z.uuid(),
    type: z.literal('learning.start'),
    payload: LearningStartSchema,
  })
  .strict();

export const LearningResultSchema = z
  .object({
    ...ResultMetricsSchema.shape,
    requested: z.literal(true),
    algorithmVersion: z.string().min(1).max(80),
    data: LearningValueSchema,
  })
  .strict();
export type LearningResult = z.infer<typeof LearningResultSchema>;
