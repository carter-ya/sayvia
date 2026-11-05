import { useEffect, useRef, useState, type FormEvent } from 'react';
import { browser } from 'wxt/browser';
import type { ConfigSnapshot } from '../storage/schema';
import { settingsRequest } from './settings-client';
import { ProviderForm } from './ProviderForm';
import { PreferencesForm } from './PreferencesForm';
import { applyAppearance } from './appearance';
import { CaptionsSettings } from './CaptionsSettings';

export function SettingsScreen() {
  const [snapshot, setSnapshot] = useState<ConfigSnapshot>();
  const [selected, setSelected] = useState('');
  const [formEpoch, setFormEpoch] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const ownClearRevision = useRef<number | undefined>(undefined);
  const provider = snapshot?.providers.find((item) => item.id === selected);
  const discard = () => !dirty || window.confirm('还有尚未保存的设置，是否放弃这些修改？');
  function apply(next: ConfigSnapshot) {
    setSnapshot(next);
    setDirty(false);
    setFormEpoch((value) => value + 1);
  }
  useEffect(() => {
    let active = true;
    void settingsRequest({ type: 'settings.read' }).then(
      (next) => {
        if (active) {
          setSnapshot(next);
          setSelected(next.preferences.defaultProviderId ?? '');
        }
      },
      () => {
        if (active) setStatus('本机配置暂不可用，原有数据已保留。');
      },
    );
    const cleared: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
      message,
      sender,
    ) => {
      if (
        sender.id !== browser.runtime.id ||
        sender.url !== browser.runtime.getURL('/background.js') ||
        message?.type !== 'app.data-cleared'
      )
        return;
      void settingsRequest({ type: 'settings.read' })
        .then((next) => {
          if (active) {
            apply(next);
            setSelected('');
            setDirty(false);
            if (ownClearRevision.current !== next.revision)
              setStatus('本地数据已清除，请重新配置。');
          }
        })
        .catch(() => undefined);
    };
    browser.runtime.onMessage.addListener(cleared);
    return () => {
      active = false;
      browser.runtime.onMessage.removeListener(cleared);
    };
  }, []);
  useEffect(() => {
    if (snapshot) applyAppearance(document.documentElement, snapshot.preferences);
  }, [snapshot]);
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  async function reload() {
    if (!discard()) return;
    try {
      const next = await settingsRequest({ type: 'settings.read' });
      apply(next);
      if (selected && !next.providers.some((item) => item.id === selected))
        setSelected(next.preferences.defaultProviderId ?? '');
      setStatus('已载入最新设置。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '载入未完成。');
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || busy) return;
    const data = new FormData(event.currentTarget);
    const key = String(data.get('apiKey') ?? '').trim();
    setBusy(true);
    setStatus('');
    try {
      const next = await settingsRequest({
        type: 'settings.save',
        payload: {
          ...(selected ? { id: selected } : {}),
          expectedRevision: snapshot.revision,
          name:
            String(data.get('name') ?? '').trim() || String(data.get('model')).trim().slice(0, 80),
          kind: String(data.get('kind')),
          baseUrl: String(data.get('baseUrl')),
          model: String(data.get('model')),
          makeDefault: false,
          key: key ? { action: 'set', value: key } : { action: 'keep' },
        },
      });
      apply(next);
      setSelected(
        selected ||
          next.providers.find((item) => !snapshot.providers.some((old) => old.id === item.id))
            ?.id ||
          '',
      );
      setStatus('已保存配置。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '保存未完成。');
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!snapshot || !provider || busy || !window.confirm('删除此配置及其保存的 Key？')) return;
    setBusy(true);
    try {
      apply(
        await settingsRequest({
          type: 'settings.delete',
          payload: { id: provider.id, expectedRevision: snapshot.revision },
        }),
      );
      setSelected('');
      setStatus('已删除配置及其 Key。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '删除未完成。');
    } finally {
      setBusy(false);
    }
  }
  async function preferences(value: ConfigSnapshot['preferences']) {
    if (!snapshot || busy) return;
    setBusy(true);
    try {
      apply(
        await settingsRequest({
          type: 'settings.preferences',
          payload: { expectedRevision: snapshot.revision, preferences: value },
        }),
      );
      setStatus('已保存偏好。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '保存未完成。');
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    if (
      !snapshot ||
      busy ||
      !window.confirm(
        '将永久删除所有模型配置、API Key、偏好和会话草稿，取消进行中的任务。之后需要重新配置。确定清除？',
      )
    )
      return;
    setBusy(true);
    try {
      const cleared = await settingsRequest({
        type: 'settings.clear',
        payload: { expectedRevision: snapshot.revision },
      });
      ownClearRevision.current = cleared.revision;
      apply(cleared);
      setSelected('');
      setStatus('已清除本地配置、Key 和会话数据。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '清除未完成，请重新载入后检查。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-shell">
      <main className="settings-main">
        <header className="settings-heading">
          <div>
            <div className="wordmark brand">
              <span className="brand-mark">S</span>Sayvia
            </div>
            <h1>{advanced ? '更多设置' : '模型设置'}</h1>
          </div>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void reload()}
          >
            重新载入
          </button>
        </header>
        {snapshot && !advanced && (
          <>
            <section className="settings-card">
              {!snapshot.providers.length && (
                <p className="muted">选择服务商，填写已有的 API Key 和模型名称，即可开始翻译。</p>
              )}
              <label className="provider-picker">
                选择配置
                <select
                  value={selected}
                  disabled={busy}
                  onChange={(event) => {
                    if (discard()) {
                      setSelected(event.target.value);
                      setDirty(false);
                      setStatus('');
                    }
                  }}
                >
                  <option value="">新增配置</option>
                  {snapshot.providers.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <ProviderForm
                key={`${formEpoch}:${snapshot.revision}:${selected}`}
                provider={provider}
                busy={busy}
                dirty={dirty}
                onDirty={() => setDirty(true)}
                onSubmit={(event) => void save(event)}
              />
              {provider && (
                <div className="delete-row">
                  <button
                    type="button"
                    className="text-button danger-text"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    删除配置
                  </button>
                  <span className="field-help">同时删除这份配置保存的 Key。</span>
                </div>
              )}
            </section>
          </>
        )}
        {snapshot && (
          <div className="advanced-settings">
            <button
              type="button"
              className="text-button"
              aria-expanded={advanced}
              disabled={busy}
              onClick={() => {
                if (discard()) {
                  if (dirty) apply(snapshot);
                  setAdvanced(!advanced);
                  setDirty(false);
                  setStatus('');
                }
              }}
            >
              {advanced ? '返回模型设置' : '更多设置'}
            </button>
            {advanced && (
              <section className="settings-card">
                <h2>翻译偏好</h2>
                <PreferencesForm
                  key={`${formEpoch}:${snapshot.revision}`}
                  snapshot={snapshot}
                  busy={busy}
                  onDirty={() => setDirty(true)}
                  onSave={(value) => void preferences(value)}
                />
                <CaptionsSettings revision={snapshot.revision} />
                <div className="delete-row">
                  <button
                    type="button"
                    className="text-button danger-text"
                    disabled={busy}
                    onClick={(event) => {
                      if (event.nativeEvent.isTrusted) void clear();
                    }}
                  >
                    清除全部本地数据
                  </button>
                </div>
              </section>
            )}
          </div>
        )}
        {!snapshot && !status && (
          <section className="settings-card" aria-busy="true">
            正在读取本机设置…
          </section>
        )}
        <p className={`settings-status${status ? ' visible' : ''}`} role="status">
          {status}
        </p>
      </main>
    </div>
  );
}
