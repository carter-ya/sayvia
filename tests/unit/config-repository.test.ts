import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigRepository, type ConfigStorage } from '../../src/storage/repository';
import { emptyState, type SaveInput, type StoredState } from '../../src/storage/schema';
import { handleSettings } from '../../src/background/settings-router';

const KEY = 'fixture-secret-not-a-real-key';
const input = (revision: number, extra: Partial<SaveInput> = {}): SaveInput => ({
  expectedRevision: revision,
  name: '个人模型',
  kind: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'fixture-model',
  makeDefault: true,
  key: { action: 'set', value: KEY },
  ...extra,
});

describe('permanent configuration repository', () => {
  let raw: unknown;
  let events: string[];
  let storage: ConfigStorage;
  beforeEach(() => {
    raw = undefined;
    events = [];
    storage = {
      async restrictAccess() {
        events.push('restrict');
      },
      async read() {
        events.push('read');
        return structuredClone(raw);
      },
      async write(state) {
        events.push('write');
        raw = structuredClone(state);
      },
    };
  });

  it('restricts access before reading or storing credentials', async () => {
    const repo = new ConfigRepository(storage);
    const snapshot = await repo.save(input(0));
    expect(events.slice(0, 3)).toEqual(['restrict', 'read', 'write']);
    expect(JSON.stringify(snapshot)).not.toContain(KEY);
    expect(JSON.stringify(snapshot)).not.toContain('secretRef');
    expect(snapshot.providers[0]?.hasApiKey).toBe(true);
  });

  it('retains credentials after repository restarts and empty-key updates', async () => {
    const first = await new ConfigRepository(storage).save(input(0));
    const provider = first.providers[0]!;
    const restarted = new ConfigRepository(storage);
    expect(await restarted.snapshot()).toEqual(first);
    const updated = await restarted.save(
      input(first.revision, {
        id: provider.id,
        name: '重命名',
        key: { action: 'keep' },
      }),
    );
    expect(updated.providers[0]?.hasApiKey).toBe(true);
    expect(Object.values((raw as StoredState).secrets)[0]?.apiKey).toBe(KEY);
  });

  it('rejects stale concurrent writes without losing the first saved config', async () => {
    const repo = new ConfigRepository(storage);
    const results = await Promise.allSettled([repo.save(input(0)), repo.save(input(0))]);
    expect(results.map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
    expect((await repo.snapshot()).providers).toHaveLength(1);
    expect((await repo.snapshot()).revision).toBe(1);
  });

  it('does not overwrite future or damaged state', async () => {
    raw = { ...emptyState(), schemaVersion: 99, secrets: { private: KEY } };
    const original = structuredClone(raw);
    const repo = new ConfigRepository(storage);
    await expect(repo.snapshot()).rejects.toThrow('CONFIG_UNAVAILABLE');
    expect(raw).toEqual(original);
    expect(events).not.toContain('write');
  });

  it('does not read storage when access restriction fails', async () => {
    storage.restrictAccess = async () => {
      throw new Error('permission unavailable');
    };
    await expect(new ConfigRepository(storage).snapshot()).rejects.toThrow();
    expect(events).toEqual([]);
  });

  it('preserves prior in-memory and stored state if a write fails', async () => {
    const repo = new ConfigRepository(storage);
    const initial = await repo.save(input(0));
    const prior = structuredClone(raw);
    storage.write = vi.fn().mockRejectedValue(new Error('private upstream text'));
    await expect(
      repo.save(input(1, { id: initial.providers[0]!.id, name: '新名称' })),
    ).rejects.toThrow();
    expect(await repo.snapshot()).toEqual(initial);
    expect(raw).toEqual(prior);
    const result = await handleSettings({ type: 'settings.save', payload: input(1) }, repo);
    expect(JSON.stringify(result)).not.toContain('private upstream text');
    expect(result).toEqual({ ok: false, error: 'CONFIG_UNAVAILABLE' });
  });

  it('clears a credential explicitly and deletes credentials with the config', async () => {
    const repo = new ConfigRepository(storage);
    const first = await repo.save(input(0));
    const id = first.providers[0]!.id;
    const cleared = await repo.save(input(1, { id, key: { action: 'clear' } }));
    expect(cleared.providers[0]?.hasApiKey).toBe(false);
    expect(Object.keys((raw as StoredState).secrets)).toHaveLength(0);
    await repo.save(input(2, { id }));
    const deleted = await repo.delete(id, 3);
    expect(deleted.providers).toEqual([]);
    expect(deleted.preferences.defaultProviderId).toBeUndefined();
    expect((raw as StoredState).secrets).toEqual({});
  });

  it('migrates the explicit flat prototype format without losing keys', async () => {
    const id = crypto.randomUUID();
    raw = {
      schemaVersion: 0,
      providers: [
        {
          id,
          name: '原有配置',
          kind: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
          model: 'fixture-model',
          apiKey: KEY,
        },
      ],
      defaultProviderId: id,
    };
    const snapshot = await new ConfigRepository(storage).snapshot();
    expect(snapshot.providers[0]?.hasApiKey).toBe(true);
    expect((raw as StoredState).schemaVersion).toBe(1);
    expect(Object.values((raw as StoredState).secrets)[0]?.apiKey).toBe(KEY);
  });

  it('rejects malformed settings commands without modifying storage', async () => {
    const repo = new ConfigRepository(storage);
    await repo.ready;
    const before = structuredClone(raw);
    const result = await handleSettings(
      {
        type: 'settings.save',
        payload: { ...input(0), baseUrl: 'http://remote.example/v1' },
      },
      repo,
    );
    expect(result).toEqual({ ok: false, error: 'INVALID_REQUEST' });
    expect(raw).toEqual(before);
  });
});
