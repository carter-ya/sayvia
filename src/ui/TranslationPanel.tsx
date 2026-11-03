import { TranslationMetrics } from './TranslationMetrics';
import type { TranslationProgress, ResultMetrics } from '../runtime/translation-progress';
import { TranslationLoading } from './TranslationLoading';
import { ReadingPreview } from './ReadingPreview';
import { AutoTextarea } from './AutoTextarea';
import { LanguageField } from './LanguageField';
import { useLayoutEffect, useRef, useState, type MouseEvent, type CSSProperties } from 'react';
import type { PanelAppearanceInput } from '../storage/schema';
import type { Appearance } from './appearance';
import { Icon } from './Icon';

export interface PanelState {
  appearance: Appearance;
  mode: 'read' | 'write';
  previewOnly?: boolean | undefined;
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
  startedAt?: number | undefined;
  progress?: TranslationProgress | undefined;
  metrics?: ResultMetrics | undefined;
}
export interface PanelActions {
  appearance(patch: PanelAppearanceInput): void;
  resetPosition(): void;
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
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [opacity, setOpacity] = useState(state.appearance.panelOpacity);
  useLayoutEffect(() => setOpacity(state.appearance.panelOpacity), [state.appearance.panelOpacity]);
  const editing = state.mode === 'write' || editSequence === state.openSequence;
  useLayoutEffect(() => {
    if (state.busy) setEditSequence(null);
  }, [state.busy]);
  useLayoutEffect(() => {
    setCollapsed(false);
    setAppearanceOpen(false);
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
      data-collapsed={collapsed}
      style={{ '--glass-opacity': `${opacity}%` } as CSSProperties}
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-label="Sayvia 翻译"
      aria-modal="false"
    >
      <header data-panel-drag>
        <button
          type="button"
          className="move-handle"
          data-panel-move
          aria-label="移动翻译面板，方向键微调"
        >
          <Icon name="grip" />
        </button>
        <strong>
          <span className="panel-brand-mark" aria-hidden="true">
            S
          </span>
          Sayvia{' '}
          <span className="mode-badge">
            {state.mode === 'write' ? (state.quickReplace ? '自动替换' : '写作') : '翻译'}
          </span>
        </strong>
        <button
          type="button"
          aria-label="浮窗外观"
          aria-expanded={appearanceOpen}
          onClick={trusted(() => {
            setCollapsed(false);
            setAppearanceOpen(!appearanceOpen);
          })}
        >
          <Icon name="appearance" />
        </button>
        <button
          type="button"
          aria-label={collapsed ? '展开翻译面板' : '收起翻译面板'}
          aria-expanded={!collapsed}
          onClick={trusted(() => setCollapsed(!collapsed))}
        >
          <Icon name={collapsed ? 'expand' : 'collapse'} />
        </button>
        <button type="button" aria-label="关闭翻译面板" onClick={trusted(actions.close)}>
          <Icon name="close" />
        </button>
      </header>
      {appearanceOpen && (
        <fieldset className="appearance-options" aria-label="浮窗外观设置" disabled={!state.ready}>
          <div className="material-choices" role="group" aria-label="浮窗材质">
            {(['liquid', 'glass', 'transparent', 'solid'] as const).map((material) => (
              <button
                key={material}
                type="button"
                aria-pressed={state.appearance.panelMaterial === material}
                onClick={trusted(() => actions.appearance({ panelMaterial: material }))}
              >
                {{ liquid: '液态', glass: '磨砂', transparent: '半透明', solid: '实色' }[material]}
              </button>
            ))}
          </div>
          <label>
            背景染色浓度 · {state.appearance.panelMaterial === 'solid' ? 100 : opacity}%
            <input
              aria-label="浮窗背景浓度"
              type="range"
              min="8"
              max="100"
              value={opacity}
              disabled={state.appearance.panelMaterial === 'solid'}
              onChange={(event) => setOpacity(Number(event.target.value))}
              onPointerUp={(event) => {
                if (event.nativeEvent.isTrusted)
                  actions.appearance({ panelOpacity: Number(event.currentTarget.value) });
              }}
              onKeyUp={(event) => {
                if (event.nativeEvent.isTrusted)
                  actions.appearance({ panelOpacity: Number(event.currentTarget.value) });
              }}
              onBlur={(event) => {
                if (event.nativeEvent.isTrusted)
                  actions.appearance({ panelOpacity: Number(event.currentTarget.value) });
              }}
            />
          </label>
          <label className="panel-check">
            <input
              type="checkbox"
              checked={state.appearance.readingProtection}
              onChange={(event) => {
                if (event.nativeEvent.isTrusted)
                  actions.appearance({ readingProtection: event.target.checked });
              }}
            />
            阅读保护
          </label>
          <button type="button" onClick={trusted(actions.resetPosition)}>
            恢复浮窗位置
          </button>
          <p className="appearance-note">外观自动保存；深色模式增强底色，保持文字清晰。</p>
        </fieldset>
      )}
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
      {state.busy ? (
        <div
          className="result-region streaming-preview"
          role="region"
          aria-label="流式译文"
          tabIndex={0}
        >
          {state.progress?.text || <TranslationLoading />}
        </div>
      ) : state.mode === 'read' && !editing ? (
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
      <TranslationMetrics
        busy={state.busy}
        startedAt={state.startedAt}
        progress={state.progress}
        result={state.metrics}
      />
      <div className="actions main-actions">
        {state.mode === 'read' && state.candidate && (
          <button
            type="button"
            disabled={state.busy}
            onClick={trusted(() => setEditSequence(editing ? null : state.openSequence))}
          >
            <Icon name="edit" />
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
            <Icon name="refresh" />
            翻译
          </button>
        )}
        <button
          type="button"
          className={state.mode === 'read' || state.previewOnly ? 'primary-action' : ''}
          disabled={!state.candidate || state.busy}
          onClick={trusted(() => actions.copy())}
        >
          <Icon name="copy" />
          复制译文
        </button>
        {state.mode === 'write' && !state.previewOnly && (
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
