import { loadState } from './migrations';
import {
  SaveSchema,
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

  private mutate(expectedRevision: number, change: (state: StoredState) => void) {
    const operation = this.queue.then(async () => {
      await this.ready;
      if (this.state.revision !== expectedRevision) throw new Error('CONFLICT');
      const next = structuredClone(this.state);
      change(next);
      next.revision += 1;
      const checked = StateSchema.parse(next);
      await this.storage.write(checked);
      this.state = checked;
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
