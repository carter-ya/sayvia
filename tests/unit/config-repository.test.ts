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

  it('adds appearance defaults to existing v1 config without losing keys, models or revisions', async () => {
    const initial = await new ConfigRepository(storage).save(input(0));
    const oldPreferences = (raw as { preferences: Record<string, unknown> }).preferences;
    for (const key of ['palette', 'panelMaterial', 'panelOpacity', 'readingProtection'])
      delete oldPreferences[key];
    oldPreferences.theme = 'dark';
    const before = structuredClone(raw);
    const upgraded = await new ConfigRepository(storage).snapshot();
    expect(upgraded.revision).toBe(initial.revision);
    expect(upgraded.providers).toEqual(initial.providers);
    expect(upgraded.preferences).toMatchObject({
      theme: 'dark',
      palette: 'crystal',
      panelMaterial: 'liquid',
      panelOpacity: 14,
      readingProtection: true,
    });
    expect(raw).toEqual(before);
    expect(Object.values((raw as StoredState).secrets)[0]?.apiKey).toBe(KEY);
  });

  it('merges panel-only updates without resetting appearance or unrelated preferences', async () => {
    const repo = new ConfigRepository(storage);
    const initial = await repo.save(input(0));
    await repo.preferences({
      expectedRevision: initial.revision,
      preferences: { ...initial.preferences, palette: 'pearl', theme: 'dark', readTarget: 'ja' },
    });
    await repo.panelAppearance({ panelMaterial: 'solid', readingProtection: false });
    await repo.panelAppearance({ panelOpacity: 83 });
    await Promise.all([
      repo.panelAppearance({ panelOpacity: 72 }),
      repo.panelAppearance({ readingProtection: true }),
    ]);
    const current = await repo.snapshot();
    expect(current.preferences).toMatchObject({
      palette: 'pearl',
      theme: 'dark',
      panelMaterial: 'solid',
      panelOpacity: 72,
      readingProtection: true,
      readTarget: 'ja',
    });
    expect(current.providers).toEqual(initial.providers);
    expect(Object.values((raw as StoredState).secrets)[0]?.apiKey).toBe(KEY);
    for (const patch of [
      {},
      { panelOpacity: 7 },
      { panelOpacity: 101 },
      { panelOpacity: 2.5 },
      { quickReplace: true },
      { panelMaterial: 'unknown' },
    ]) {
      expect(() => repo.panelAppearance(patch as never)).toThrow();
    }
  });

  it('normalizes newly saved path prefixes while retaining old configuration and its permanent key', async () => {
    const first = await new ConfigRepository(storage).save(input(0));
    const state = raw as StoredState;
    state.providers[first.providers[0]!.id]!.baseUrl = 'https://api.openai.com/v1/chat/completions';
    const restarted = new ConfigRepository(storage);
    expect((await restarted.snapshot()).providers[0]!.hasApiKey).toBe(true);
    const old = structuredClone(raw);
    expect(() =>
      restarted.save(
        input(1, {
          id: first.providers[0]!.id,
          baseUrl: 'https://api.openai.com/v1/chat/completions',
          key: { action: 'keep' },
        }),
      ),
    ).toThrow();
    expect(raw).toEqual(old);
    const corrected = await restarted.save(
      input(1, {
        id: first.providers[0]!.id,
        baseUrl: 'https://EXAMPLE.test/gateway/v1///',
        key: { action: 'keep' },
      }),
    );
    expect(corrected.providers[0]!.baseUrl).toBe('https://example.test/gateway/v1');
    expect(Object.values((raw as StoredState).secrets)[0]!.apiKey).toBe(KEY);
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

  it('saves preferences without changing provider revisions or exposing keys', async () => {
    const repo = new ConfigRepository(storage);
    const first = await repo.save(input(0));
    const second = await repo.save(input(1, { name: '备用', makeDefault: false }));
    const preferences = {
      ...second.preferences,
      defaultProviderId: second.providers[1]!.id,
      readTarget: 'ja',
      writeTarget: 'fr',
      quickReplace: true,
      theme: 'dark' as const,
    };
    const changed = await handleSettings(
      {
        type: 'settings.preferences',
        payload: {
          expectedRevision: 2,
          preferences,
        },
      },
      repo,
    );
    expect(changed).toEqual({ ok: true, data: { ...second, revision: 3, preferences } });
    expect((await repo.completionConfig()).providerId).toBe(second.providers[1]!.id);
    expect(JSON.stringify(changed)).not.toContain(KEY);
    expect((await repo.snapshot()).providers[0]!.revision).toBe(first.providers[0]!.revision);
    expect((await new ConfigRepository(storage).snapshot()).preferences).toEqual(preferences);
    await expect(repo.preferences({ expectedRevision: 2, preferences })).rejects.toThrow(
      'CONFLICT',
    );
    await expect(
      repo.preferences({
        expectedRevision: 3,
        preferences: {
          ...preferences,
          defaultProviderId: crypto.randomUUID(),
        },
      }),
    ).rejects.toThrow('NOT_FOUND');
    expect((await repo.snapshot()).revision).toBe(3);
  });

  it('clears permanent keys and preferences without reusing an old revision', async () => {
    const repo = new ConfigRepository(storage);
    await repo.save(input(0));
    const cleared = await repo.clear(1);
    expect(cleared).toEqual({ revision: 2, providers: [], preferences: emptyState().preferences });
    expect((raw as StoredState).secrets).toEqual({});
    expect((raw as StoredState).allowedSites).toEqual([]);
    await expect(repo.completionConfig()).rejects.toThrow('CONFIG_REQUIRED');
    await expect(repo.save(input(1))).rejects.toThrow('CONFLICT');
    expect(await new ConfigRepository(storage).snapshot()).toEqual(cleared);
  });
  it('never clears configuration without the task lifecycle coordinator', async () => {
    const repo = new ConfigRepository(storage);
    await repo.save(input(0));
    const before = structuredClone(raw);
    expect(
      await handleSettings({ type: 'settings.clear', payload: { expectedRevision: 1 } }, repo),
    ).toEqual({ ok: false, error: 'CLEAR_INCOMPLETE' });
    expect(raw).toEqual(before);
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

  it('holds configuration saves and clears until caption START acceptance, then releases both', async () => {
    const repo = new ConfigRepository(storage);
    const initial = await repo.save(input(0));
    const selected = initial.providers[0]!;
    let accept!: () => void;
    let entered!: () => void;
    const ack = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const starting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const dispatch = repo.withCaptionConfig(
      { id: selected.id, revision: selected.revision, model: selected.model },
      async (provider) => {
        entered();
        await ack;
        return provider.providerId;
      },
    );
    await starting;
    const save = repo.save(
      input(initial.revision, { id: selected.id, model: 'new-model', key: { action: 'keep' } }),
    );
    const clear = repo.clear(initial.revision + 1);
    await Promise.resolve();
    expect((raw as StoredState).providers[selected.id]!.model).toBe(selected.model);
    accept();
    expect(await dispatch).toBe(selected.id);
    await save;
    expect((await clear).providers).toEqual([]);
  });
  it.each(['revision', 'default'])(
    'rejects a stale %s before a caption dispatch callback runs',
    async (change) => {
      const repo = new ConfigRepository(storage);
      const initial = await repo.save(input(0));
      const selected = initial.providers[0]!;
      const save = repo.save(
        input(
          initial.revision,
          change === 'revision' ? { id: selected.id, model: 'new-model' } : { name: 'second' },
        ),
      );
      const dispatch = vi.fn(async () => 'should not start');
      await expect(
        repo.withCaptionConfig(
          { id: selected.id, revision: selected.revision, model: selected.model },
          dispatch,
        ),
      ).rejects.toThrow('CONFLICT');
      await save;
      expect(dispatch).not.toHaveBeenCalled();
    },
  );
  it('releases the configuration queue after a lost START acknowledgement without repeating dispatch', async () => {
    const repo = new ConfigRepository(storage);
    const initial = await repo.save(input(0));
    const selected = initial.providers[0]!;
    const dispatch = vi.fn(async () => {
      throw new Error('START_ACK_LOST');
    });
    await expect(
      repo.withCaptionConfig(
        { id: selected.id, revision: selected.revision, model: selected.model },
        dispatch,
      ),
    ).rejects.toThrow('START_ACK_LOST');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await repo.clear(initial.revision)).providers).toEqual([]);
  });
});

it('invalidates caption configuration only after a successful relevant commit, without awaiting notifications', async () => {
  let state: unknown;
  const write = vi.fn(async (next: StoredState) => {
    state = structuredClone(next);
  });
  const repo = new ConfigRepository({
    restrictAccess: async () => {},
    read: async () => state,
    write,
  });
  const changed = vi.fn();
  const unsubscribe = repo.onCaptionConfigurationChange(changed);
  const initial = await repo.save(input(0));
  expect(changed).toHaveBeenCalledTimes(1);
  await repo.preferences({
    expectedRevision: initial.revision,
    preferences: { ...initial.preferences, theme: 'dark' },
  });
  expect(changed).toHaveBeenCalledTimes(1);
  const current = await repo.snapshot();
  await repo.save(input(current.revision, { name: 'other', makeDefault: false }));
  expect(changed).toHaveBeenCalledTimes(1);
  const before = await repo.snapshot();
  write.mockRejectedValueOnce(new Error('storage failed'));
  await expect(
    repo.preferences({
      expectedRevision: before.revision,
      preferences: { ...before.preferences, readTarget: 'fr' },
    }),
  ).rejects.toThrow();
  expect(changed).toHaveBeenCalledTimes(1);
  let afterNotification: Promise<unknown> | undefined;
  repo.onCaptionConfigurationChange(() => {
    afterNotification = repo.snapshot();
  });
  await repo.preferences({
    expectedRevision: before.revision,
    preferences: { ...before.preferences, readTarget: 'fr' },
  });
  expect(
    ((await afterNotification) as { preferences: { readTarget: string } }).preferences.readTarget,
  ).toBe('fr');
  expect(changed).toHaveBeenCalledTimes(2);
  unsubscribe();
  await repo.delete(initial.providers[0]!.id, before.revision + 1);
  expect(changed).toHaveBeenCalledTimes(2);
});
