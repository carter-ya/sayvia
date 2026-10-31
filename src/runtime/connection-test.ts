import { z } from 'zod';

const Identity = z
  .object({
    providerId: z.uuid(),
    providerRevision: z.int().nonnegative(),
    clientTaskId: z.uuid(),
    documentNonce: z.uuid(),
  })
  .strict();
export const ConnectionTestRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('settings.test.start'), payload: Identity }).strict(),
  z.object({ type: z.literal('settings.test.status'), payload: Identity }).strict(),
  z.object({ type: z.literal('settings.test.cancel'), payload: Identity }).strict(),
]);
export const ConnectionTestView = Identity.omit({ documentNonce: true })
  .extend({
    state: z.enum(['running', 'passed', 'failed', 'canceled', 'stale']),
    error: z.string().max(48).optional(),
  })
  .strict();
export type ConnectionIdentity = z.infer<typeof Identity>;
export type ConnectionView = z.infer<typeof ConnectionTestView>;
