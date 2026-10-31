import { useRef, useState, type FormEvent } from 'react';
import { browser } from 'wxt/browser';
import { PROVIDER_PRESETS } from '../providers/presets';
import { chatCompletionsEndpoint, normalizeBaseUrl } from '../providers/endpoint';
import type { ConfigSnapshot } from '../storage/schema';
import { useConnectionTest } from './use-connection-test';

type Provider = ConfigSnapshot['providers'][number];
export function ProviderForm({
  provider,
  busy,
  dirty,
  onDirty,
  onSubmit,
}: {
  provider: Provider | undefined;
  busy: boolean;
  dirty: boolean;
  onDirty(): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
}) {
  const [kind, setKind] = useState(provider?.kind ?? 'openai');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? PROVIDER_PRESETS.openai.baseUrl);
  const [model, setModel] = useState(provider?.model ?? '');
  const [permissionStatus, setPermissionStatus] = useState('');
  const permissionTicket = useRef(0);
  const connection = useConnectionTest(provider);
  let endpoint = '';
  try {
    endpoint = chatCompletionsEndpoint(normalizeBaseUrl(baseUrl));
  } catch {
    /* Show a local hint until valid. */
  }
  function changed() {
    onDirty();
    connection.invalidate();
  }
  function address(value: string) {
    permissionTicket.current++;
    setPermissionStatus('');
    setBaseUrl(value);
  }
  function authorize() {
    const ticket = ++permissionTicket.current;
    try {
      const url = new URL(normalizeBaseUrl(baseUrl));
      void browser.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] }).then(
        (granted) => {
          if (ticket === permissionTicket.current)
            setPermissionStatus(
              granted ? `${url.hostname} 已获授权。` : '未获得授权，暂不能向此主机发起翻译。',
            );
        },
        () => {
          if (ticket === permissionTicket.current) setPermissionStatus('授权未完成，请重试。');
        },
      );
    } catch {
      setPermissionStatus('请先填写有效的 API Base URL。');
    }
  }
  return (
    <form className="provider-form" onSubmit={onSubmit} onChange={changed}>
      <fieldset className="provider-fields" disabled={busy} aria-label="模型配置">
        <div className="field-pair">
          <label>
            配置名称
            <input
              name="name"
              required
              maxLength={80}
              placeholder="例如：日常翻译"
              defaultValue={provider?.name ?? ''}
            />
          </label>
          <label>
            服务商
            <select
              name="kind"
              value={kind}
              onChange={(event) => {
                const next = event.target.value as Provider['kind'];
                setKind(next);
                address(PROVIDER_PRESETS[next].baseUrl);
                setModel(PROVIDER_PRESETS[next].verifiedModels[0] ?? '');
              }}
            >
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="openai-compatible">自定义兼容服务</option>
            </select>
          </label>
        </div>
        <label>
          API Base URL
          <input
            name="baseUrl"
            type="url"
            required
            value={baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) => address(event.target.value)}
          />
        </label>
        <p className="field-help">
          填写服务基础地址，不包含 /chat/completions。内容只会发送至你保存的服务。
        </p>
        <div className="endpoint-preview">
          <span>实际请求地址</span>
          <code>{endpoint || '填写有效地址后显示'}</code>
        </div>
        <div className="inline-actions">
          <button
            type="button"
            className="secondary"
            onClick={(event) => {
              if (event.nativeEvent.isTrusted) authorize();
            }}
          >
            授权此 API 主机
          </button>
          <span className="field-help">仅用于请求模型，不会自动开启网页翻译。</span>
        </div>
        {baseUrl.startsWith('http:') && (
          <p className="notice">本地 HTTP 连接仅限 localhost 或 127.0.0.1，需单独授权。</p>
        )}
        {permissionStatus && (
          <p role="note" className="notice">
            {permissionStatus}
          </p>
        )}
        <label>
          模型名称
          <input
            name="model"
            required
            maxLength={160}
            value={model}
            placeholder={PROVIDER_PRESETS[kind].verifiedModels[0] ?? '服务商提供的模型名称'}
            onChange={(event) => setModel(event.target.value)}
          />
        </label>
        <label>
          API Key
          <input
            name="apiKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="key-help"
            placeholder={provider?.hasApiKey ? '已保存，留空保留原值' : '粘贴你的 API Key'}
          />
        </label>
        <p id="key-help" className="field-help">
          {provider?.hasApiKey ? '已保存 Key，留空保留原值。' : '随配置永久保存在当前设备。'}
          不参与同步；卸载插件或清除数据会删除 Key。本机存储不等同于加密保险箱。
        </p>
        {provider?.hasApiKey && (
          <label className="checkbox">
            <input name="clearKey" type="checkbox" />
            清除已保存 Key
          </label>
        )}
        <label className="checkbox">
          <input name="makeDefault" type="checkbox" />
          保存时设为默认模型
        </label>
        <div className="form-footer">
          <button type="submit" disabled={busy}>
            保存配置
          </button>
          {provider && (
            <button
              type="button"
              className="secondary"
              disabled={busy || dirty || !provider.hasApiKey || connection.running}
              onClick={(event) => {
                if (event.nativeEvent.isTrusted) void connection.run();
              }}
            >
              {connection.running ? '正在测试…' : '测试连接'}
            </button>
          )}
          {connection.running && (
            <button
              type="button"
              className="text-button"
              onClick={(event) => {
                if (event.nativeEvent.isTrusted) connection.stop();
              }}
            >
              取消测试
            </button>
          )}
        </div>
        <p className="connection-status" data-testid="connection-status" aria-live="polite">
          {connection.status}
        </p>
        <p className="field-help">
          测试只发送一小段公开文本，可能产生少量费用；修改配置后需先保存再测试。
        </p>
      </fieldset>
    </form>
  );
}
