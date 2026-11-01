import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { LanguageField, languageName } from './LanguageField';
import { useManualTranslation } from './use-manual-translation';

export function PopupScreen() {
  const manual = useManualTranslation();
  const [opening, setOpening] = useState(false);
  const [view, setView] = useState<'page' | 'manual'>('page');
  const initialized = useRef(false);
  const { fields, config, ready, busy, saving, status, hostname, model } = manual;
  useEffect(() => {
    if (ready && !initialized.current) {
      initialized.current = true;
      if (fields.input || fields.result || busy) setView('manual');
    }
  }, [ready, busy, fields.input, fields.result]);
  const provider = config?.providers.find(
    (item) => item.id === (fields.providerId || config.preferences.defaultProviderId),
  );
  async function openPage(mode: 'read' | 'write') {
    if (opening || manual.tabId === undefined) return;
    setOpening(true);
    try {
      const reply = (await browser.runtime.sendMessage({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        type: 'page.open',
        payload: { tabId: manual.tabId, mode },
      })) as { ok?: boolean };
      if (!reply?.ok) throw new Error();
      window.close();
    } catch {
      manual.setStatus('当前页面无法开启页面翻译，可以在下方粘贴文本翻译。');
    } finally {
      setOpening(false);
    }
  }
  function grantApi() {
    if (!provider) return;
    const url = new URL(provider.baseUrl);
    void browser.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] }).then(
      (granted) =>
        manual.setStatus(granted ? '已授权模型 API，请点击翻译。' : '未获得模型 API 授权。'),
      () => manual.setStatus('API 授权未完成，请在设置中检查。'),
    );
  }
  return (
    <main className="popup">
      <header className="popup-header">
        <div className="wordmark brand">
          <span className="brand-mark">S</span>Sayvia
        </div>
        <button
          className="text-button"
          type="button"
          onClick={() => void browser.runtime.openOptionsPage()}
        >
          打开设置
        </button>
      </header>
      <div
        className="popup-tabs"
        role="tablist"
        aria-label="翻译方式"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index =
            event.key === 'Home' ? 0 : event.key === 'End' ? 1 : view === 'page' ? 1 : 0;
          setView(index === 0 ? 'page' : 'manual');
          (
            event.currentTarget.querySelectorAll('[role="tab"]')[index] as HTMLButtonElement
          )?.focus();
        }}
      >
        <button
          role="tab"
          type="button"
          aria-selected={view === 'page'}
          tabIndex={view === 'page' ? 0 : -1}
          aria-controls="popup-page-panel"
          onClick={() => setView('page')}
        >
          当前页面
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={view === 'manual'}
          tabIndex={view === 'manual' ? 0 : -1}
          aria-controls="popup-manual-panel"
          onClick={() => setView('manual')}
        >
          手动翻译
        </button>
      </div>
      {view === 'page' && (
        <div role="tabpanel" id="popup-page-panel" aria-label="当前页面">
          <h1>用自己的语言，参与世界的讨论。</h1>
          <p className="popup-subtitle">自在阅读，从容表达。</p>
          <section className="popup-page" aria-label="当前页面">
            <span className="eyebrow">当前标签页</span>
            <strong>{hostname}</strong>
            <p className="field-help">
              {manual.siteEnabled ? '选区图标已启用' : '选区图标未启用，可在设置中按网站开启。'}
            </p>
            <div className="popup-actions">
              <button
                className="secondary"
                type="button"
                disabled={!ready || opening || busy}
                onClick={(event) => {
                  if (event.nativeEvent.isTrusted) void openPage('read');
                }}
              >
                翻译网页选区
              </button>
              <button
                className="secondary"
                type="button"
                disabled={!ready || opening || busy}
                onClick={(event) => {
                  if (event.nativeEvent.isTrusted) void openPage('write');
                }}
              >
                翻译当前输入
              </button>
            </div>
            <p className="field-help">已启用网站可直接选中文字，点击页面内图标翻译。</p>
          </section>
          <p className="popup-overview">
            阅读目标：{languageName(config?.preferences.readTarget ?? '—')} · 写作目标：
            {languageName(config?.preferences.writeTarget ?? '—')}
          </p>
          <p className="popup-overview">
            默认模型：
            {config?.providers.find((item) => item.id === config.preferences.defaultProviderId)
              ?.name ?? '尚未配置，请打开设置添加模型。'}
          </p>
        </div>
      )}
      {view === 'manual' && (
        <section
          className="popup-manual"
          role="tabpanel"
          id="popup-manual-panel"
          aria-label="手动翻译"
        >
          <div className="popup-selectors">
            <label className="popup-model-select">
              翻译模型
              <select
                aria-label="翻译模型"
                value={fields.providerId}
                disabled={!ready || busy}
                onChange={(event) => {
                  if (event.nativeEvent.isTrusted)
                    manual.update({ providerId: event.target.value });
                }}
              >
                <option value="">
                  {config?.providers.length ? '使用默认模型' : '请先添加模型'}
                </option>
                {config?.providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.model}
                  </option>
                ))}
              </select>
            </label>
            <LanguageField
              label="源语言"
              value={fields.sourceLanguage}
              allowAuto
              disabled={!ready || busy}
              onChange={(sourceLanguage) => manual.update({ sourceLanguage })}
            />
            <LanguageField
              label="目标语言"
              value={fields.targetLanguage}
              disabled={!ready || busy}
              onChange={(targetLanguage) => manual.update({ targetLanguage })}
            />
          </div>
          <label>
            待翻译文本
            <textarea
              aria-label="待翻译文本"
              rows={2}
              maxLength={24_000}
              value={fields.input}
              disabled={!ready || busy}
              placeholder="在这里输入或粘贴文本…"
              onChange={(event) => {
                if (event.nativeEvent.isTrusted) manual.update({ input: event.target.value });
              }}
            />
          </label>
          <div className="popup-meta">
            <span>{[...fields.input].length.toLocaleString()} / 12,000 字符</span>
            <span>{saving ? '保存草稿中…' : '仅保存在本次浏览器会话'}</span>
          </div>
          {status.includes('授权当前 API 主机') && (
            <button
              type="button"
              className="secondary"
              disabled={!provider || busy}
              onClick={(event) => {
                if (event.nativeEvent.isTrusted) grantApi();
              }}
            >
              授权模型 API
            </button>
          )}
          <label>
            手动译文
            <textarea
              aria-label="手动译文"
              rows={2}
              maxLength={48_000}
              value={fields.result}
              disabled={!ready || busy}
              placeholder="译文将显示在这里，可继续修改。"
              onChange={(event) => {
                if (event.nativeEvent.isTrusted) manual.update({ result: event.target.value });
              }}
            />
          </label>
          {model && (fields.result || busy) && <p className="field-help">本次模型：{model}</p>}
          <div className="popup-actions">
            <button
              type="button"
              disabled={
                !ready ||
                manual.blocked ||
                busy ||
                saving ||
                !fields.input.trim() ||
                !fields.targetLanguage.trim() ||
                !fields.sourceLanguage.trim() ||
                !config?.providers.length ||
                [...fields.input].length > 12_000
              }
              onClick={(event) => {
                if (event.nativeEvent.isTrusted) void manual.translate();
              }}
            >
              翻译文本
            </button>
            {busy && (
              <button
                className="secondary"
                type="button"
                onClick={(event) => {
                  if (event.nativeEvent.isTrusted) void manual.cancel();
                }}
              >
                取消翻译
              </button>
            )}
            <button
              className="secondary"
              type="button"
              disabled={!fields.result || busy}
              onClick={(event) => {
                if (!event.nativeEvent.isTrusted) return;
                void navigator.clipboard.writeText(fields.result).then(
                  () => manual.setStatus('已复制译文。'),
                  () => manual.setStatus('复制未完成，请手动选择文本复制。'),
                );
              }}
            >
              复制手动译文
            </button>
          </div>
        </section>
      )}
      <p className="popup-status" role="status">
        {status || (!ready ? '正在连接…' : `版本 ${browser.runtime.getManifest().version}`)}
      </p>
    </main>
  );
}
