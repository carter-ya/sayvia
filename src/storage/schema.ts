import { z } from 'zod';
import { normalizeBaseUrl } from '../providers/endpoint';

const Id = z.uuid();
export const ProviderKind = z.enum(['openai', 'deepseek', 'openai-compatible']);
const BaseUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  );
});
const ApiKey = z
  .string()
  .trim()
  .min(1)
  .max(8192)
  .refine((value) => !/[\r\n]/.test(value));
const ProviderFields = {
  name: z.string().trim().min(1).max(80),
  kind: ProviderKind,
  baseUrl: BaseUrl,
  model: z.string().trim().min(1).max(160),
};
const Provider = z
  .object({
    ...ProviderFields,
    id: Id,
    revision: z.int().nonnegative(),
    secretRef: Id,
    protocol: z.literal('chat-completions'),
  })
  .strict();
const Preferences = z
  .object({
    defaultProviderId: Id.optional(),
    readTarget: z.string().min(1).max(20),
    writeTarget: z.string().min(1).max(20),
    quickReplace: z.boolean(),
    theme: z.enum(['system', 'light', 'dark']),
  })
  .strict();

export const StateSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.int().nonnegative(),
    providers: z.record(Id, Provider),
    secrets: z.record(Id, z.object({ apiKey: ApiKey }).strict()),
    preferences: Preferences,
    allowedSites: z.array(z.url()),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (Object.entries(state.providers).some(([id, value]) => id !== value.id)) {
      ctx.addIssue({ code: 'custom', message: 'Inconsistent provider identity' });
    }
    const referenced = new Set(Object.values(state.providers).map((value) => value.secretRef));
    if (Object.keys(state.secrets).some((id) => !referenced.has(id))) {
      ctx.addIssue({ code: 'custom', message: 'Orphaned credential' });
    }
    if (
      state.preferences.defaultProviderId &&
      !state.providers[state.preferences.defaultProviderId]
    ) {
      ctx.addIssue({ code: 'custom', message: 'Unknown default provider' });
    }
  });
export type StoredState = z.infer<typeof StateSchema>;

export const SnapshotSchema = z
  .object({
    revision: z.int().nonnegative(),
    providers: z.array(Provider.omit({ secretRef: true }).extend({ hasApiKey: z.boolean() })),
    preferences: Preferences,
  })
  .strict();
export type ConfigSnapshot = z.infer<typeof SnapshotSchema>;

export const SaveSchema = z
  .object({
    ...ProviderFields,
    baseUrl: BaseUrl.max(2048).transform((value, ctx) => {
      try {
        return normalizeBaseUrl(value);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Invalid API Base URL' });
        return z.NEVER;
      }
    }),
    id: Id.optional(),
    expectedRevision: z.int().nonnegative(),
    makeDefault: z.boolean(),
    key: z.discriminatedUnion('action', [
      z.object({ action: z.literal('keep') }).strict(),
      z.object({ action: z.literal('set'), value: ApiKey }).strict(),
      z.object({ action: z.literal('clear') }).strict(),
    ]),
  })
  .strict();
export type SaveInput = z.infer<typeof SaveSchema>;

export const RequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('settings.read') }).strict(),
  z.object({ type: z.literal('settings.save'), payload: SaveSchema }).strict(),
  z
    .object({
      type: z.literal('settings.delete'),
      payload: z.object({ id: Id, expectedRevision: z.int().nonnegative() }).strict(),
    })
    .strict(),
]);

export function emptyState(): StoredState {
  return {
    schemaVersion: 1,
    revision: 0,
    providers: {},
    secrets: {},
    allowedSites: [],
    preferences: { readTarget: 'zh-Hans', writeTarget: 'en', quickReplace: false, theme: 'system' },
  };
}
