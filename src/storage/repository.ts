import { siteOrigin } from '../runtime/site-access';
import { CaptionProviderSchema, type CaptionProvider } from '../runtime/caption-protocol';
import { loadState } from './migrations';
import {
  SaveSchema,
  emptyState,
  PreferencesInputSchema,
  PanelAppearancePatch,
  type PanelAppearanceInput,
  type PreferencesInput,
  SnapshotSchema,
  StateSchema,
  type SaveInput,
  type StoredState,
} from './schema';

export interface ConfigStorage {
  restrictAccess(): Promise<void>;
  read(): Promise<unknown>;
  write(state: StoredState): Promise<void>;
}

export class ConfigRepository {
  readonly ready: Promise<void>;
  private state!: StoredState;
  private queue: Promise<void> = Promise.resolve();
  private readonly captionListeners = new Set<() => void>();

  onCaptionConfigurationChange(listener: () => void) {
    this.captionListeners.add(listener);
    return () => {
      this.captionListeners.delete(listener);
    };
  }
  private captionIdentity(state: StoredState) {
    const id = state.preferences.defaultProviderId;
    const selected = id ? state.providers[id] : undefined;
    return JSON.stringify([id, selected?.revision, selected?.model, state.preferences.readTarget]);
  }

  constructor(private readonly storage: ConfigStorage) {
    this.ready = this.initialize();
  }

  private async initialize() {
    await this.storage.restrictAccess();
    const loaded = loadState(await this.storage.read());
    if (loaded.write) await this.storage.write(loaded.state);
    this.state = loaded.state;
  }

  async snapshot() {
    await this.ready;
    await this.queue;
    return this.project();
  }

  // Only the background task broker may consume this credential-bearing snapshot.
  async completionConfig(id?: string) {
    await this.ready;
    await this.queue;
    return this.readCompletionConfig(id);
  }

  // Hold the configuration's mutation queue only through the executor's START
  // acceptance, never through model completion. The callback must not re-enter
  // this repository; it receives the credential-bearing snapshot directly.
  withCaptionConfig<T>(
    expected: CaptionProvider,
    dispatch: (config: ReturnType<ConfigRepository['readCompletionConfig']>) => Promise<T>,
  ): Promise<T> {
    const identity = CaptionProviderSchema.parse(expected);
    const operation = this.queue.then(async () => {
      await this.ready;
      const provider = this.readCompletionConfig();
      if (
        provider.providerId !== identity.id ||
        provider.providerRevision !== identity.revision ||
        provider.model !== identity.model
      )
        throw new Error('CONFLICT');
      return dispatch(provider);
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  private readCompletionConfig(id?: string) {
    const provider = this.state.providers[id ?? this.state.preferences.defaultProviderId ?? ''];
    const apiKey = provider && this.state.secrets[provider.secretRef]?.apiKey;
    if (!provider || !apiKey) throw new Error('CONFIG_REQUIRED');
    return {
      providerId: provider.id,
      providerRevision: provider.revision,
      model: provider.model,
      config: { baseUrl: provider.baseUrl, model: provider.model, apiKey },
    };
  }

  private project() {
    return SnapshotSchema.parse({
      revision: this.state.revision,
      preferences: structuredClone(this.state.preferences),
      providers: Object.values(this.state.providers).map(({ secretRef, ...provider }) => ({
        ...provider,
        hasApiKey: Boolean(this.state.secrets[secretRef]),
      })),
    });
  }

  private mutate(expectedRevision: number | undefined, change: (state: StoredState) => void) {
    const operation = this.queue.then(async () => {
      await this.ready;
      if (expectedRevision !== undefined && this.state.revision !== expectedRevision)
        throw new Error('CONFLICT');
      const next = structuredClone(this.state);
      change(next);
      next.revision += 1;
      const checked = StateSchema.parse(next);
      await this.storage.write(checked);
      const captionsChanged = this.captionIdentity(this.state) !== this.captionIdentity(checked);
      this.state = checked;
      // Synchronous invalidation only. Listeners must not await broker work or
      // re-enter this mutation queue; notifications run independently afterward.
      if (captionsChanged)
        for (const listener of this.captionListeners) {
          try {
            listener();
          } catch {
            /* A notification must not roll back saved configuration. */
          }
        }
      return this.project();
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  save(input: SaveInput) {
    const checked = SaveSchema.parse(input);
    return this.mutate(checked.expectedRevision, (state) => {
      const id = checked.id ?? crypto.randomUUID();
      const existing = state.providers[id];
      if (checked.id && !existing) throw new Error('NOT_FOUND');
      const secretRef = existing?.secretRef ?? crypto.randomUUID();
      state.providers[id] = {
        id,
        name: checked.name,
        kind: checked.kind,
        baseUrl: checked.baseUrl,
        model: checked.model,
        revision: (existing?.revision ?? -1) + 1,
        secretRef,
        protocol: 'chat-completions',
      };
      if (checked.key.action === 'set') state.secrets[secretRef] = { apiKey: checked.key.value };
      if (checked.key.action === 'clear') delete state.secrets[secretRef];
      if (checked.makeDefault || !state.preferences.defaultProviderId) {
        state.preferences.defaultProviderId = id;
      }
    });
  }

  preferences(input: PreferencesInput) {
    const checked = PreferencesInputSchema.parse(input);
    return this.mutate(checked.expectedRevision, (state) => {
      const id = checked.preferences.defaultProviderId;
      if (id && !state.providers[id]) throw new Error('NOT_FOUND');
      state.preferences = structuredClone(checked.preferences);
    });
  }

  panelAppearance(input: PanelAppearanceInput) {
    const patch = PanelAppearancePatch.parse(input);
    return this.mutate(undefined, (state) => {
      Object.assign(state.preferences, patch);
    });
  }

  async siteOrigins() {
    await this.ready;
    await this.queue;
    return [...this.state.allowedSites];
  }

  setSite(origin: string, enabled: boolean, expectedRevision: number) {
    const canonical = siteOrigin(origin);
    return this.mutate(expectedRevision, (state) => {
      state.allowedSites = state.allowedSites.filter((item) => item !== canonical);
      if (enabled) state.allowedSites.push(canonical);
      if (state.allowedSites.length > 200) throw new Error('SITE_LIMIT');
    });
  }

  // Only permission reconciliation may remove intent without a UI revision.
  removeSites(origins: string[]) {
    return this.mutate(undefined, (state) => {
      state.allowedSites = state.allowedSites.filter((origin) => !origins.includes(origin));
    });
  }

  clear(expectedRevision: number) {
    return this.mutate(expectedRevision, (state) => {
      state.providers = {};
      state.secrets = {};
      state.preferences = emptyState().preferences;
      state.allowedSites = [];
    });
  }

  delete(id: string, expectedRevision: number) {
    return this.mutate(expectedRevision, (state) => {
      const provider = state.providers[id];
      if (!provider) throw new Error('NOT_FOUND');
      delete state.secrets[provider.secretRef];
      delete state.providers[id];
      if (state.preferences.defaultProviderId === id) {
        const next = Object.keys(state.providers)[0];
        if (next) state.preferences.defaultProviderId = next;
        else delete state.preferences.defaultProviderId;
      }
    });
  }
}
