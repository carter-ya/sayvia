import { useEffect, useState, type FormEvent } from 'react';
import type { ConfigSnapshot } from '../storage/schema';
import { settingsRequest } from './settings-client';
import { ProviderForm } from './ProviderForm';

export function SettingsScreen() {
  const [snapshot, setSnapshot] = useState<ConfigSnapshot>();
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');
  const provider = snapshot?.providers.find((item) => item.id === selected);
  const discard = () => !dirty || window.confirm('还有尚未保存的设置，是否放弃这些修改？');
  function apply(next: ConfigSnapshot) {
    setSnapshot(next);
    setDirty(false);
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
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    document.documentElement.style.colorScheme =
      snapshot?.preferences.theme === 'system'
        ? 'light dark'
        : (snapshot?.preferences.theme ?? 'light dark');
  }, [snapshot?.preferences.theme]);
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
    if (key && data.get('clearKey')) {
      setStatus('请分别选择更新或清除 Key。');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const next = await settingsRequest({
        type: 'settings.save',
        payload: {
          ...(selected ? { id: selected } : {}),
          expectedRevision: snapshot.revision,
          name: String(data.get('name')),
          kind: String(data.get('kind')),
          baseUrl: String(data.get('baseUrl')),
          model: String(data.get('model')),
          makeDefault: Boolean(data.get('makeDefault')),
          key: key
            ? { action: 'set', value: key }
            : data.get('clearKey')
              ? { action: 'clear' }
              : { action: 'keep' },
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
  return (
    <div className="settings-shell">
      <aside className="settings-sidebar">
        <div className="wordmark brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          Sayvia
        </div>
        <p className="sidebar-tagline">自在阅读，从容表达。</p>
        <nav aria-label="设置导航">
          <button type="button" aria-current="page">
            <span className="nav-symbol" aria-hidden="true">
              ◈
            </span>
            模型服务
          </button>
        </nav>
        <div className="sidebar-note">
          <span className="local-dot" />
          你的 Key，保存在你的设备。
        </div>
      </aside>
      <main className="settings-main">
        <header className="settings-heading">
          <div>
            <span className="eyebrow">Sayvia / 设置</span>
            <h1>模型设置</h1>
            <p className="muted">连接你信任的模型，让不同语言之间的表达更自然。</p>
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
        {snapshot && (
          <>
            <section className="settings-card">
              <div className="card-heading">
                <div>
                  <span className="eyebrow">
                    {snapshot.providers.length ? '你的模型' : '开始使用'}
                  </span>
                  <h2>{provider ? provider.name : '添加一个模型服务'}</h2>
                </div>
                {provider?.id === snapshot.preferences.defaultProviderId && (
                  <span className="badge">默认模型</span>
                )}
              </div>
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
                key={`${snapshot.revision}:${selected}`}
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
            <p className="footer-note">
              默认模型：
              {snapshot.providers.find((item) => item.id === snapshot.preferences.defaultProviderId)
                ?.name ?? '尚未配置'}{' '}
              · 仅在你主动翻译时调用
            </p>
          </>
        )}
        {!snapshot && !status && (
          <section className="settings-card" aria-busy="true">
            正在读取本机设置…
          </section>
        )}
        <p className={`settings-status${status ? ' visible' : ''}`} role="status">
          {status}
        </p>
        <footer className="settings-footer">
          Sayvia <span>为每一种表达，留一座桥。</span>
        </footer>
      </main>
    </div>
  );
}
