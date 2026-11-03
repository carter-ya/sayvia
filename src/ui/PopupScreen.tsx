import { TranslationLoading } from './TranslationLoading';
import { TranslationMetrics } from './TranslationMetrics';
import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { LanguageField } from './LanguageField';
import { useManualTranslation } from './use-manual-translation';
import { LookupDetails } from './LookupDetails';

export function PopupScreen() {
  const manual = useManualTranslation();
  const [opening, setOpening] = useState(false);
  const [view, setView] = useState<'page' | 'manual' | 'lookup'>('page');
  const initialized = useRef(false);
  const { fields, config, ready, busy, saving, status, hostname } = manual;
  useEffect(() => {
    if (ready && !initialized.current) {
      initialized.current = true;
      if (fields.purpose === 'lookup') setView('lookup');
      else if (fields.input || fields.result || busy) setView('manual');
    }
  }, [ready, busy, fields.input, fields.result, fields.purpose]);
  function selectView(next: typeof view) {
    if (next !== 'page') {
      const purpose = next === 'lookup' ? 'lookup' : 'translate';
      if (purpose !== fields.purpose) {
        if (!ready || busy) return;
        manual.update({
          purpose,
          targetLanguage:
            purpose === 'lookup'
              ? (config?.preferences.readTarget ?? 'zh-Hans')
              : (config?.preferences.writeTarget ?? 'en'),
        });
      }
    }
    setView(next);
  }
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
          const tabs = ['page', 'manual', 'lookup'] as const;
          const index =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? 2
                : (tabs.indexOf(view) + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
          selectView(tabs[index]!);
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
          onClick={() => selectView('page')}
        >
          当前页面
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={view === 'manual'}
          tabIndex={view === 'manual' ? 0 : -1}
          aria-controls="popup-manual-panel"
          disabled={!ready || (busy && fields.purpose !== 'translate')}
          onClick={() => selectView('manual')}
        >
          手动翻译
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={view === 'lookup'}
          tabIndex={view === 'lookup' ? 0 : -1}
          aria-controls="popup-lookup-panel"
          disabled={!ready || (busy && fields.purpose !== 'lookup')}
          onClick={() => selectView('lookup')}
        >
          查词
        </button>
      </div>
      {view === 'page' && (
        <div role="tabpanel" id="popup-page-panel" aria-label="当前页面">
          <section className="popup-page" aria-label="当前页面">
            <span className="eyebrow">当前标签页</span>
            <strong>{hostname}</strong>
            <p className="field-help">
              {manual.siteEnabled ? '选中文字，点击图标即可翻译。' : '此页面请使用手动翻译。'}
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
          </section>
          <p className="popup-overview">
            默认模型：
            {config?.providers.find((item) => item.id === config.preferences.defaultProviderId)
              ?.name ?? '尚未配置，请打开设置添加模型。'}
          </p>
        </div>
      )}
      {(view === 'manual' || view === 'lookup') && (
        <section
          className="popup-manual"
          role="tabpanel"
          id={view === 'lookup' ? 'popup-lookup-panel' : 'popup-manual-panel'}
          aria-label={view === 'lookup' ? '查词' : '手动翻译'}
        >
          <div className="popup-selectors">
            <label className="popup-model-select">
              {fields.purpose === 'lookup' ? '释义模型' : '翻译模型'}
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
              label={fields.purpose === 'lookup' ? '释义语言' : '目标语言'}
              value={fields.targetLanguage}
              disabled={!ready || busy}
              onChange={(targetLanguage) => manual.update({ targetLanguage })}
            />
          </div>
          <label>
            {fields.purpose === 'lookup' ? '单词或短语' : '待翻译文本'}
            <textarea
              aria-label={fields.purpose === 'lookup' ? '单词或短语' : '待翻译文本'}
              rows={2}
              maxLength={fields.purpose === 'lookup' ? 160 : 24_000}
              value={fields.input}
              disabled={!ready || busy}
              placeholder="在这里输入或粘贴文本…"
              onChange={(event) => {
                if (event.nativeEvent.isTrusted) manual.update({ input: event.target.value });
              }}
            />
          </label>
          <div className="popup-meta">
            <span>
              {[...fields.input].length.toLocaleString()} /{' '}
              {fields.purpose === 'lookup' ? '80' : '12,000'} 字符
            </span>
            <span>{saving ? '保存中…' : ''}</span>
          </div>
          {fields.purpose === 'translate' && (
            <label>
              手动译文
              <div className="manual-result-shell">
                <textarea
                  aria-label="手动译文"
                  rows={2}
                  maxLength={48_000}
                  value={busy ? (manual.progress?.text ?? '') : fields.result}
                  disabled={!ready || busy}
                  placeholder={busy ? '' : '译文将显示在这里，可继续修改。'}
                  onChange={(event) => {
                    if (event.nativeEvent.isTrusted) manual.update({ result: event.target.value });
                  }}
                />
                {busy && !manual.progress?.text && <TranslationLoading />}
              </div>
            </label>
          )}
          {fields.purpose === 'lookup' && (
            <>
              {busy && <TranslationLoading label="正在查词" />}
              {manual.tabId !== undefined && (
                <LookupDetails
                  text={fields.input}
                  sourceLanguage={fields.sourceLanguage}
                  result={busy ? undefined : fields.lookupResult}
                  owner={{ origin: 'manual', tabId: manual.tabId }}
                  identity={`${fields.providerId}:${fields.targetLanguage}:${manual.startedAt ?? ''}`}
                />
              )}
            </>
          )}
          <TranslationMetrics
            busy={busy}
            startedAt={manual.startedAt}
            progress={manual.progress}
            result={manual.metrics}
          />
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
                [...fields.input].length > (fields.purpose === 'lookup' ? 80 : 12_000)
              }
              onClick={(event) => {
                if (event.nativeEvent.isTrusted) void manual.translate();
              }}
            >
              {fields.purpose === 'lookup' ? '查词' : '翻译文本'}
            </button>
            {busy && (
              <button
                className="secondary"
                type="button"
                onClick={(event) => {
                  if (event.nativeEvent.isTrusted) void manual.cancel();
                }}
              >
                {fields.purpose === 'lookup' ? '取消查词' : '取消翻译'}
              </button>
            )}
            {fields.purpose === 'translate' && (
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
            )}
          </div>
        </section>
      )}
      <p className="popup-status" role="status">
        {status || (!ready ? '正在连接…' : '')}
      </p>
    </main>
  );
}
