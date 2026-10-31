import { z } from 'zod';
import { SourceInputSchema } from '../core/source-input';
import { LanguageSchema } from './executor-protocol';

const Owner = z.object({
  clientTaskId: z.uuid(),
  documentNonce: z.uuid(),
  tabId: z.int().nonnegative().optional(),
});
export const StartPayload = Owner.extend({
  providerId: z.uuid().optional(),
  mode: z.enum(['read', 'write', 'manual']),
  scope: z.enum(['selection', 'full']),
  source: SourceInputSchema,
  sourceLanguage: LanguageSchema,
  targetLanguage: LanguageSchema,
  editorSessionId: z.uuid().optional(),
  sourceRevision: z.int().nonnegative().optional(),
})
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.mode === 'read' && value.source.kind !== 'dom-selection') ||
      (value.mode === 'manual' && value.source.kind !== 'plain-text') ||
      (value.mode === 'write' &&
        (!value.editorSessionId ||
          value.sourceRevision === undefined ||
          value.source.kind === 'dom-selection'))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid source mode' });
    }
  });
export type StartPayload = z.infer<typeof StartPayload>;
const Envelope = { protocolVersion: z.literal(1), requestId: z.uuid() };
export const TaskMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...Envelope, type: z.literal('translation.start'), payload: StartPayload }).strict(),
  z
    .object({ ...Envelope, type: z.literal('translation.status'), payload: Owner.strict() })
    .strict(),
  z
    .object({ ...Envelope, type: z.literal('translation.cancel'), payload: Owner.strict() })
    .strict(),
  z
    .object({
      ...Envelope,
      type: z.literal('translation.manual.read'),
      payload: z.object({ tabId: z.int().nonnegative() }).strict(),
    })
    .strict(),
]);
export type TaskMessage = z.infer<typeof TaskMessageSchema>;

export const RouteSchema = z
  .object({
    taskId: z.uuid(),
    clientTaskId: z.uuid(),
    documentNonce: z.uuid(),
    tabId: z.int().nonnegative(),
    frameId: z.literal(0),
    documentId: z.string().min(1).max(160).optional(),
    mode: z.enum(['read', 'write', 'manual']),
    epoch: z.uuid(),
    providerId: z.uuid(),
    providerRevision: z.int().nonnegative(),
    model: z.string().max(160),
    startedAt: z.int().positive(),
    deadlineAt: z.int().positive(),
    expiresAt: z.int().positive(),
    state: z.enum([
      'running',
      'ready',
      'failed',
      'canceled',
      'timedOut',
      'delivered',
      'expired',
      'interrupted',
    ]),
    recovered: z.boolean(),
    error: z.string().max(48).optional(),
  })
  .strict();
export type TaskRoute = z.infer<typeof RouteSchema>;
export const SessionSchema = z
  .object({
    version: z.literal(1),
    routes: z.array(RouteSchema).max(256),
    canceled: z
      .array(z.object({ key: z.string().max(500), expiresAt: z.int().positive() }).strict())
      .max(256),
    manual: z
      .array(
        z
          .object({
            tabId: z.int().nonnegative(),
            clientTaskId: z.uuid(),
            documentNonce: z.uuid(),
            input: z.string().max(24_000),
            result: z.string().max(48_000).optional(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export type TaskSession = z.infer<typeof SessionSchema>;
