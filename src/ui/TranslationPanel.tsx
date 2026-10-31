import { useLayoutEffect, useRef, type MouseEvent } from 'react';

export interface PanelState {
  mode: 'read' | 'write';
  source: string;
  candidate: string;
  target: string;
  scope: 'selection' | 'full';
  replaceScope: 'selection' | 'full';
  model: string;
  busy: boolean;
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
  scope(value: 'selection' | 'full'): void;
}
const trusted = (action: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
  if (event.nativeEvent.isTrusted) action();
};
export function TranslationPanel({ state, actions }: { state: PanelState; actions: PanelActions }) {
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    panel.current?.focus();
  }, []);
  return (
    <section ref={panel} tabIndex={-1} role="dialog" aria-label="Sayvia 翻译" aria-modal="false">
      <header>
        <strong>Sayvia</strong>
        <button type="button" aria-label="关闭翻译面板" onClick={trusted(actions.close)}>
          关闭
        </button>
      </header>
      <h2>{state.mode === 'write' ? '写作翻译' : '阅读翻译'}</h2>
      {state.model && <p>模型：{state.model}</p>}
      <label>
        目标语言
        <input
          value={state.target}
          maxLength={40}
          disabled={state.busy}
          onChange={(event) => {
            if (event.nativeEvent.isTrusted) actions.target(event.target.value);
          }}
        />
      </label>
      {state.mode === 'write' && (
        <div className="actions" role="group" aria-label="翻译范围">
          <span>翻译范围</span>
          <button
            type="button"
            disabled={state.busy}
            aria-pressed={state.scope === 'selection'}
            onClick={trusted(() => actions.scope('selection'))}
          >
            优先使用选区
          </button>
          <button
            type="button"
            disabled={state.busy}
            aria-pressed={state.scope === 'full'}
            onClick={trusted(() => actions.scope('full'))}
          >
            全文
          </button>
        </div>
      )}
      <label>
        原文
        <textarea aria-label="原文" readOnly value={state.source} rows={4} />
      </label>
      <div className="actions">
        <button type="button" disabled={state.busy} onClick={trusted(actions.refresh)}>
          重新读取原文
        </button>
        <button
          type="button"
          disabled={state.busy || !state.source.trim() || !state.target.trim()}
          onClick={trusted(actions.translate)}
        >
          翻译
        </button>
        {state.busy && (
          <button type="button" onClick={trusted(actions.cancel)}>
            取消翻译
          </button>
        )}
      </div>
      <label>
        译文
        <textarea
          aria-label="译文"
          value={state.candidate}
          rows={6}
          maxLength={48_000}
          disabled={state.busy}
          onChange={(event) => {
            if (event.nativeEvent.isTrusted) actions.edit(event.target.value);
          }}
        />
      </label>
      <div className="actions">
        <button
          type="button"
          disabled={!state.candidate || state.busy}
          onClick={trusted(() => actions.copy())}
        >
          复制译文
        </button>
        {state.mode === 'write' && (
          <button
            type="button"
            disabled={!state.canReplace || state.busy}
            onClick={trusted(actions.replace)}
          >
            替换{state.replaceScope === 'full' ? '全文' : '选区'}
          </button>
        )}
        {state.hasOriginal && (
          <>
            <button
              type="button"
              disabled={!state.canRestore || state.busy}
              onClick={trusted(actions.restore)}
            >
              恢复原文
            </button>
            <button type="button" onClick={trusted(() => actions.copy(true))}>
              复制替换前原文
            </button>
          </>
        )}
      </div>
      <p role="status">{state.status}</p>
    </section>
  );
}
