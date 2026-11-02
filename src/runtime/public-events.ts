import { z } from 'zod';
import { ProgressSchema, TranslationResultSchema } from './translation-progress';
const Identity = {
  protocolVersion: z.literal(1),
  taskId: z.uuid(),
  clientTaskId: z.uuid(),
  documentNonce: z.uuid(),
};
export const TaskEventSchema = z.discriminatedUnion('type', [
  z
    .object({ ...Identity, type: z.literal('translation.progress'), progress: ProgressSchema })
    .strict(),
  z
    .object({
      ...Identity,
      type: z.literal('translation.result'),
      canApply: z.boolean(),
      quickReplaceAllowed: z.boolean().optional(),
      result: TranslationResultSchema,
      provider: z
        .object({ id: z.uuid(), revision: z.int().nonnegative(), model: z.string().max(160) })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...Identity,
      type: z.literal('translation.state'),
      state: z.enum(['failed', 'canceled', 'timedOut', 'interrupted', 'expired', 'delivered']),
      error: z.string().max(48).optional(),
    })
    .strict(),
]);
