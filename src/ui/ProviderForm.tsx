import { useState, type FormEvent } from 'react';
import { PROVIDER_PRESETS } from '../providers/presets';
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
  const connection = useConnectionTest(provider);
  function changed() {
    onDirty();
    connection.invalidate();
  }
  function address(value: string) {
    setBaseUrl(value);
  }
  return (
    <form className="provider-form" onSubmit={onSubmit} onChange={changed}>
      <fieldset className="provider-fields" disabled={busy} aria-label="模型配置">
        <div className="field-pair">
          <label>
            配置名称
            <input
              name="name"
              maxLength={80}
              placeholder="可留空，使用模型名称"
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
        </p>
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
        <p
          className="connection-status"
          data-testid="connection-status"
          aria-live="polite"
          hidden={connection.status === '尚未测试连接'}
        >
          {connection.status}
        </p>
        <p className="field-help">
          测试只发送一小段公开文本，可能产生少量费用；修改配置后需先保存再测试。
        </p>
      </fieldset>
    </form>
  );
}
