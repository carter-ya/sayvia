import { z } from 'zod';
const Identity = {
  protocolVersion: z.literal(1),
  taskId: z.uuid(),
  clientTaskId: z.uuid(),
  documentNonce: z.uuid(),
};
export const TaskEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...Identity,
      type: z.literal('translation.result'),
      canApply: z.boolean(),
      result: z
        .object({
          text: z.string().max(48_000),
          requested: z.boolean(),
          durationMs: z.number().nonnegative(),
          algorithmVersion: z.string().max(80),
        })
        .strict(),
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
