import { ReadingPreview } from './ReadingPreview';
import { AutoTextarea } from './AutoTextarea';
import { LanguageField } from './LanguageField';
import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react';

export interface PanelState {
  mode: 'read' | 'write';
  openSequence: number;
  source: string;
  candidate: string;
  target: string;
  sourceLanguage: string;
  scope: 'selection' | 'full';
  replaceScope: 'selection' | 'full';
  model: string;
  busy: boolean;
  ready: boolean;
  quickReplace: boolean;
  canReplace: boolean;
  canRestore: boolean;
  hasOriginal: boolean;
  status: string;
}
export interface PanelActions {
  translate(): void;
  refresh(): void;
  cancel(): void;
  replace(): void;
  restore(): void;
  copy(original?: boolean): void;
  close(): void;
  edit(value: string): void;
  target(value: string): void;
  sourceLanguage(value: string): void;
  scope(value: 'selection' | 'full'): void;
}
const trusted = (action: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
  if (event.nativeEvent.isTrusted) action();
};
export function TranslationPanel({ state, actions }: { state: PanelState; actions: PanelActions }) {
  const panel = useRef<HTMLElement>(null);
  const [editSequence, setEditSequence] = useState<number | null>(null);
  const editing = state.mode === 'write' || editSequence === state.openSequence;
  useLayoutEffect(() => {
    if (state.busy) setEditSequence(null);
  }, [state.busy]);
  useLayoutEffect(() => {
    panel.current?.focus();
  }, [state.openSequence]);
  const quiet = [
    '确认原文和目标语言后，点击翻译。',
    '译文已就绪，请预览后操作。',
    '正在翻译…',
  ].includes(state.status);
  return (
    <section
      aria-busy={state.busy}
      data-mode={state.mode}
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-label="Sayvia 翻译"
      aria-modal="false"
    >
      <header>
        <strong>
          Sayvia{' '}
          <span className="mode-badge">
            {state.mode === 'write' ? (state.quickReplace ? '自动替换' : '写作') : '翻译'}
          </span>
        </strong>
        <button type="button" aria-label="关闭翻译面板" onClick={trusted(actions.close)}>
          ×
        </button>
      </header>
      <div className="language-pair">
        <LanguageField
          label="源语言"
          value={state.sourceLanguage}
          allowAuto
          disabled={!state.ready || state.busy}
          onChange={actions.sourceLanguage}
        />
        <span className="language-arrow" aria-hidden="true">
          →
        </span>
        <LanguageField
          label="目标语言"
          value={state.target}
          disabled={!state.ready || state.busy}
          onChange={actions.target}
        />
      </div>
      <details className="source-details">
        <summary>
          原文 <span>{[...state.source].length} 字符</span>
        </summary>
        <AutoTextarea aria-label="原文" readOnly value={state.source} rows={3} />
      </details>
      {state.mode === 'read' && !editing ? (
        <div className="result-region" role="region" aria-label="译文预览" tabIndex={0}>
          {state.candidate ? (
            <ReadingPreview text={state.candidate} />
          ) : (
            <p className="result-placeholder">{state.busy ? '正在翻译…' : '译文将在这里显示'}</p>
          )}
        </div>
      ) : (
        <label className="result-label">
          <span className="sr-only">译文</span>
          <AutoTextarea
            aria-label="译文"
            value={state.candidate}
            rows={3}
            maxLength={48_000}
            placeholder={state.busy ? '正在翻译…' : '译文'}
            disabled={!state.ready || state.busy}
            onChange={(event) => {
              if (event.nativeEvent.isTrusted) actions.edit(event.target.value);
            }}
          />
        </label>
      )}
      <div className="actions main-actions">
        {state.mode === 'read' && state.candidate && (
          <button
            type="button"
            disabled={state.busy}
            onClick={trusted(() => setEditSequence(editing ? null : state.openSequence))}
          >
            {editing ? '完成编辑' : '编辑译文'}
          </button>
        )}
        {state.busy ? (
          <button type="button" onClick={trusted(actions.cancel)}>
            取消翻译
          </button>
        ) : (
          <button
            type="button"
            disabled={
              !state.ready ||
              !state.source.trim() ||
              !state.sourceLanguage.trim() ||
              !state.target.trim()
            }
            onClick={trusted(actions.translate)}
          >
            翻译
          </button>
        )}
        <button
          type="button"
          className={state.mode === 'read' ? 'primary-action' : ''}
          disabled={!state.candidate || state.busy}
          onClick={trusted(() => actions.copy())}
        >
          复制译文
        </button>
        {state.mode === 'write' && (
          <button
            type="button"
            className="primary-action"
            disabled={!state.canReplace || state.busy}
            onClick={trusted(actions.replace)}
          >
            替换{state.replaceScope === 'full' ? '全文' : '选区'}
          </button>
        )}
        {state.hasOriginal && (
          <button
            type="button"
            disabled={!state.canRestore || state.busy}
            onClick={trusted(actions.restore)}
          >
            恢复原文
          </button>
        )}
      </div>
      {!quiet && state.status && (
        <p className="panel-status" role="status" aria-live="polite">
          {state.status}
        </p>
      )}
      <details className="panel-options">
        <summary>更多选项</summary>
        {state.model && <p className="model-note">模型：{state.model}</p>}
        {state.mode === 'write' && (
          <div className="actions" role="group" aria-label="翻译范围">
            <button
              type="button"
              disabled={!state.ready || state.busy}
              aria-pressed={state.scope === 'selection'}
              onClick={trusted(() => actions.scope('selection'))}
            >
              优先使用选区
            </button>
            <button
              type="button"
              disabled={!state.ready || state.busy}
              aria-pressed={state.scope === 'full'}
              onClick={trusted(() => actions.scope('full'))}
            >
              全文
            </button>
          </div>
        )}
        <div className="actions">
          <button
            type="button"
            disabled={!state.ready || state.busy}
            onClick={trusted(actions.refresh)}
          >
            重新读取原文
          </button>
          {state.hasOriginal && (
            <button type="button" onClick={trusted(() => actions.copy(true))}>
              复制替换前原文
            </button>
          )}
        </div>
      </details>
    </section>
  );
}
