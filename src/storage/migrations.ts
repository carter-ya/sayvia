import { z } from 'zod';
import { emptyState, SaveSchema, StateSchema, type StoredState } from './schema';

// The flat prototype format is retained as an explicit migration fixture, not a released version.
const LegacySchema = z
  .object({
    schemaVersion: z.literal(0),
    providers: z.array(
      SaveSchema.omit({ id: true, expectedRevision: true, makeDefault: true, key: true }).extend({
        id: z.uuid(),
        apiKey: z.string().min(1),
      }),
    ),
    defaultProviderId: z.uuid().optional(),
  })
  .strict();

export function loadState(raw: unknown): { state: StoredState; write: boolean } {
  if (raw === undefined) return { state: emptyState(), write: true };
  const current = StateSchema.safeParse(raw);
  if (current.success) return { state: current.data, write: false };
  const legacy = LegacySchema.safeParse(raw);
  if (!legacy.success) throw new Error('CONFIG_UNAVAILABLE');
  const state = emptyState();
  for (const item of legacy.data.providers) {
    if (state.providers[item.id]) throw new Error('CONFIG_UNAVAILABLE');
    const { apiKey, ...provider } = item;
    state.providers[item.id] = {
      ...provider,
      revision: 0,
      secretRef: item.id,
      protocol: 'chat-completions',
    };
    state.secrets[item.id] = { apiKey };
  }
  const defaultId = legacy.data.defaultProviderId ?? legacy.data.providers[0]?.id;
  if (defaultId) state.preferences.defaultProviderId = defaultId;
  const result = StateSchema.safeParse(state);
  if (!result.success) throw new Error('CONFIG_UNAVAILABLE');
  return { state: result.data, write: true };
}
