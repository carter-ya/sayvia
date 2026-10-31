import { useEffect, useState, type FormEvent } from 'react';
import type { ConfigSnapshot } from '../storage/schema';
import { settingsRequest } from './settings-client';
import { PROVIDER_PRESETS } from '../providers/presets';
import { browser } from 'wxt/browser';
import { normalizeBaseUrl } from '../providers/endpoint';

type PublicProvider = ConfigSnapshot['providers'][number];

function ProviderForm({
  provider,
  busy,
  onSubmit,
}: {
  provider: PublicProvider | undefined;
  busy: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [kind, setKind] = useState(provider?.kind ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? PROVIDER_PRESETS.openai.baseUrl);
  const [permissionStatus, setPermissionStatus] = useState('');
  function authorize() {
    try {
      const url = new URL(normalizeBaseUrl(baseUrl));
      void browser.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] }).then(
        (granted) =>
          setPermissionStatus(
            granted ? `${url.hostname} 已获授权。` : '未获得授权，暂不能向此主机发起翻译。',
          ),
        () => setPermissionStatus('授权未完成，请重试。'),
      );
    } catch {
      setPermissionStatus('请先填写有效的 API Base URL。');
    }
  }
  return (
    <form onSubmit={onSubmit}>
      <label>
        配置名称
        <input name="name" required maxLength={80} defaultValue={provider?.name ?? ''} />
      </label>
      <label>
        服务商
        <select
          name="kind"
          value={kind}
          onChange={(event) => {
            const value = event.target.value as PublicProvider['kind'];
            setKind(value);
            setPermissionStatus('');
            setBaseUrl(PROVIDER_PRESETS[value].baseUrl);
          }}
        >
          <option value="openai">OpenAI</option>
          <option value="deepseek">DeepSeek</option>
          <option value="openai-compatible">自定义兼容服务</option>
        </select>
      </label>
      <label>
        API Base URL
        <input
          name="baseUrl"
          type="url"
          required
          value={baseUrl}
          onChange={(event) => {
            setBaseUrl(event.target.value);
            setPermissionStatus('');
          }}
        />
      </label>
      <button
        type="button"
        className="secondary"
        onClick={(event) => {
          if (event.nativeEvent.isTrusted) authorize();
        }}
      >
        授权此 API 主机
      </button>
      <p className="muted">API 授权用于请求翻译；页面翻译由你在当前网页点击插件开启。</p>
      {permissionStatus && <p role="note">{permissionStatus}</p>}
      <label>
        模型名称
        <input name="model" required maxLength={160} defaultValue={provider?.model ?? ''} />
      </label>
      <label>
        API Key
        <input
          name="apiKey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="key-help"
        />
      </label>
      <p id="key-help" className="muted">
        {provider?.hasApiKey ? '已保存 Key，留空保留原值。' : '输入后随配置永久保存在当前设备。'}
        本机存储不等同于加密保险箱，卸载插件或清除数据会删除配置。
      </p>
      {provider?.hasApiKey && (
        <label className="checkbox">
          <input name="clearKey" type="checkbox" />
          清除已保存 Key
        </label>
      )}
      <label className="checkbox">
        <input name="makeDefault" type="checkbox" />
        设为默认模型
      </label>
      <button type="submit" disabled={busy}>
        保存配置
      </button>
    </form>
  );
}

export function SettingsScreen() {
  const [snapshot, setSnapshot] = useState<ConfigSnapshot>();
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const provider = snapshot?.providers.find((item) => item.id === selected);

  useEffect(() => {
    let active = true;
    void settingsRequest({ type: 'settings.read' }).then(
      (data) => {
        if (active) setSnapshot(data);
      },
      () => {
        if (active) setStatus('本机配置暂不可用，原有数据已保留。');
      },
    );
    return () => {
      active = false;
    };
  }, []);

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
      setSnapshot(next);
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
      const next = await settingsRequest({
        type: 'settings.delete',
        payload: { id: provider.id, expectedRevision: snapshot.revision },
      });
      setSnapshot(next);
      setSelected('');
      setStatus('已删除配置及其 Key。');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '删除未完成。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="settings">
      <div className="wordmark">Sayvia</div>
      <h1>模型设置</h1>
      <p>配置你的翻译服务，开始跨语言阅读与表达。</p>
      {snapshot && (
        <>
          <label>
            选择配置
            <select
              value={selected}
              disabled={busy}
              onChange={(event) => {
                setSelected(event.target.value);
                setStatus('');
              }}
            >
              <option value="">新增配置</option>
              {snapshot.providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <ProviderForm
            key={snapshot.revision + ':' + selected}
            provider={provider}
            busy={busy}
            onSubmit={(event) => void save(event)}
          />
          {provider && (
            <button className="secondary" disabled={busy} onClick={() => void remove()}>
              删除配置
            </button>
          )}
          {snapshot.preferences.defaultProviderId && (
            <p className="muted">
              默认模型：
              {
                snapshot.providers.find(
                  (item) => item.id === snapshot.preferences.defaultProviderId,
                )?.name
              }
            </p>
          )}
        </>
      )}
      <p role="status">{status}</p>
    </main>
  );
}
