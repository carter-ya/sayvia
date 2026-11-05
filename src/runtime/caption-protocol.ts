import { z } from 'zod';
import { TrackSchema } from '../captions/contract';

export const CaptionProviderSchema = z
  .object({
    id: z.uuid(),
    revision: z.int().nonnegative(),
    model: z.string().min(1).max(160),
  })
  .strict();
export type CaptionProvider = z.infer<typeof CaptionProviderSchema>;

export const CaptureSettingsSchema = z
  .object({
    desiredEnabled: z.boolean(),
    registered: z.boolean(),
    unconfirmedDocuments: z.int().nonnegative(),
    error: z.boolean(),
  })
  .strict();
export const CaptionSessionSchema = z
  .object({
    sessionId: z.uuid(),
    generation: z.int().nonnegative(),
    videoId: z.string().min(1).max(64),
    trackKey: z.string().min(1).max(256),
    captureGeneration: z.uuid(),
  })
  .strict();
const common = { protocolVersion: z.literal(1), requestId: z.uuid() };
const page = { ...common, documentNonce: z.uuid() };
export const CaptionRequestSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('captions.settings.read') }).strict(),
  z.object({ ...common, type: z.literal('captions.settings.set'), enabled: z.boolean() }).strict(),
  z.object({ ...page, type: z.literal('captions.ensure') }).strict(),
  z.object({ ...page, type: z.literal('captions.configuration') }).strict(),
  z
    .object({
      ...page,
      type: z.literal('captions.check'),
      session: CaptionSessionSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...page,
      type: z.literal('captions.grant'),
      track: TrackSchema,
      captureGeneration: z.uuid(),
      previousSessionId: z.uuid().optional(),
    })
    .strict(),
  z.object({ ...page, type: z.literal('captions.revoke') }).strict(),
]);
