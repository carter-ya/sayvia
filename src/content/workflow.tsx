import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { EditorRegistry } from '../adapters/registry';
import { ReadingSelectionCache } from '../adapters/selection-cache';
import type { TextEditorSession } from '../adapters/text-session';
import type { EditorSnapshot } from '../adapters/types';
import { parseSourceInput, type SourceInput } from '../core/source-input';
import { validateEditedTranslation } from '../core/translation-plan';
import { TaskEventSchema } from '../runtime/public-events';
import { userError } from '../runtime/user-errors';
import { TranslationPanel, type PanelActions, type PanelState } from '../ui/TranslationPanel';
import { SelectionEntry } from './selection-entry';
import { panelStyle } from './panel-style';

type Draft = {
  source: SourceInput;
  editor?: TextEditorSession;
  snapshot?: EditorSnapshot;
  clientTaskId?: string;
  baseline: string;
  eligible: boolean;
  backendAllows: boolean;
  applied: boolean;
  quickReplace?: boolean;
};
export function mountWorkflow(onDisposed: () => void = () => undefined) {
  const registry = new EditorRegistry();
  const selection = new ReadingSelectionCache();
  let lastEditor: TextEditorSession | undefined;
  let focusTarget: HTMLElement | undefined;
  let current: Draft | undefined;
  let disposed = false;
  let writing = false;
  let automatic = false;
  let visible = false;
  let automaticEpoch = 0;
  let openSequence = 0;
  let entryMode: 'toolbar' | 'inline' = 'toolbar';
  const host = document.createElement('div');
  host.dataset.sayviaUi = '';
  host.style.setProperty('display', 'none', 'important');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = panelStyle;
  const container = document.createElement('div');
  shadow.append(style, container);
  document.documentElement.append(host);
  const root = createRoot(container);
  const state: PanelState = {
    mode: 'write',
    openSequence: 0,
    source: '',
    candidate: '',
    target: 'en',
    scope: 'selection',
    replaceScope: 'full',
    model: '',
    busy: false,
    ready: false,
    quickReplace: false,
    canReplace: false,
    canRestore: false,
    hasOriginal: false,
    status: '',
  };
  const entry = new SelectionEntry(() => {
    if (automatic) open('read', true);
  });
  const owns = (event: Event) => event.composedPath().includes(host) || entry.owns(event);
  const render = () => {
    if (!disposed) root.render(<TranslationPanel state={{ ...state }} actions={actions} />);
  };
  const dirty = () =>
    Boolean(current && state.candidate !== current.baseline && state.candidate && !current.applied);
  const discard = () => !dirty() || window.confirm('译文有尚未应用的修改，是否放弃这些修改？');
  const bind = (element: Element | null) => {
    if (!element) return;
    const editor = registry.bind(element);
    if (editor) {
      lastEditor = editor;
      focusTarget = element as HTMLElement;
    } else if (
      element.matches(
        'input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
      ) ||
      (element instanceof HTMLElement && element.isContentEditable)
    ) {
      // An unsupported editing target must never fall back to a previous draft.
      lastEditor = undefined;
      focusTarget = element as HTMLElement;
    }
  };
  const captureSelection = () => {
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || selected.rangeCount !== 1) return;
    try {
      selection.capture(window.getSelection(), document);
    } catch {
      /* read() supplies a public error. */
    }
  };
  const capture = () => {
    if (state.mode === 'read') {
      const source = selection.read(document);
      current = { source, baseline: '', eligible: false, backendAllows: false, applied: false };
    } else {
      if (!lastEditor) throw new Error('UNSUPPORTED');
      const snapshot = lastEditor.capture(state.scope === 'full' ? 'full' : undefined);
      const source = parseSourceInput({
        kind: snapshot.format,
        text: snapshot.fullText.slice(snapshot.range.start, snapshot.range.end),
      });
      current = {
        source,
        snapshot,
        editor: lastEditor,
        baseline: '',
        eligible: true,
        backendAllows: false,
        applied: false,
      };
      state.replaceScope = snapshot.scope;
    }
    state.source = current.source.text;
    state.hasOriginal = current.editor?.previousOriginal() !== undefined;
    state.canRestore = current.editor?.canRestore() ?? false;
  };
  const refreshEligibility = () => {
    const draft = current;
    if (!draft) return;
    if (draft.snapshot && draft.editor && !draft.editor.validate(draft.snapshot).ok)
      draft.eligible = false;
    state.canReplace = Boolean(
      draft.editor &&
      draft.snapshot &&
      draft.eligible &&
      draft.backendAllows &&
      !draft.applied &&
      state.candidate &&
      validateEditedTranslation(
        draft.source.kind === 'markdown' ? 'markdown' : 'plain-text',
        draft.baseline,
        state.candidate,
      ),
    );
    state.canRestore = draft.editor?.canRestore() ?? false;
  };
  const cancel = () => {
    const id = current?.clientTaskId;
    if (current) delete current.clientTaskId;
    state.busy = false;
    state.canReplace = false;
    if (current) current.backendAllows = false;
    if (id) {
      try {
        void browser.runtime
          .sendMessage({
            protocolVersion: 1,
            requestId: crypto.randomUUID(),
            type: 'translation.cancel',
            payload: { clientTaskId: id, documentNonce: registry.documentNonce },
          })
          .catch(() => undefined);
      } catch {
        /* An invalidated extension context must still release its DOM resources. */
      }
    }
  };
  const begin = async () => {
    if (!state.ready || writing || state.busy || !discard()) return;
    try {
      if (entryMode === 'inline' && !automatic) throw new Error('SITE_DISABLED');
      const draft = current;
      if (!draft) throw new Error('EMPTY_SOURCE');
      if (draft.editor && draft.snapshot && !draft.editor.validate(draft.snapshot).ok)
        throw new Error('SOURCE_CHANGED');
      if (
        draft.source.kind === 'dom-selection' &&
        JSON.stringify(selection.read(document)) !== JSON.stringify(draft.source)
      )
        throw new Error('SELECTION_LOST');
      const clientTaskId = crypto.randomUUID();
      draft.clientTaskId = clientTaskId;
      draft.quickReplace = state.mode === 'write' && state.quickReplace;
      state.candidate = '';
      state.busy = true;
      state.canReplace = false;
      state.status = '正在翻译…';
      render();
      const response = (await browser.runtime.sendMessage({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        type: 'translation.start',
        payload: {
          clientTaskId,
          documentNonce: registry.documentNonce,
          mode: state.mode,
          ...(entryMode === 'inline' ? { entry: 'inline' } : {}),
          scope: draft.snapshot?.scope ?? 'selection',
          source: draft.source,
          sourceLanguage: 'auto',
          targetLanguage: state.target,
          ...(draft.snapshot
            ? {
                editorSessionId: draft.snapshot.editorSessionId,
                sourceRevision: draft.snapshot.revision,
              }
            : {}),
        },
      })) as {
        ok?: boolean;
        error?: string;
        data?: { state?: string; error?: string; provider?: { model?: string } };
      };
      if (current !== draft || draft.clientTaskId !== clientTaskId || !state.busy) return;
      if (!response?.ok || (response.data?.state && response.data.state !== 'running'))
        throw new Error(response?.error ?? response?.data?.error ?? 'CONTEXT_LOST');
      if (response.data?.provider?.model) {
        state.model = response.data.provider.model;
        render();
      }
    } catch (error) {
      state.busy = false;
      state.canReplace = false;
      state.status =
        error instanceof Error && error.message === 'SOURCE_CHANGED' && !state.candidate
          ? '原稿已修改，请重新读取原文后再翻译。'
          : userError(error);
      render();
    }
  };
  const actions: PanelActions = {
    refresh() {
      if (writing || state.busy || !discard()) return;
      cancel();
      state.candidate = '';
      state.model = '';
      try {
        capture();
        state.status = '已重新读取原文，请确认后翻译。';
      } catch (error) {
        current = undefined;
        state.source = '';
        state.status = userError(error);
      }
      render();
    },
    translate: () => {
      void begin();
    },
    cancel() {
      cancel();
      state.status = userError('CANCELED');
      render();
    },
    edit(value) {
      if (writing || state.busy) return;
      state.candidate = value;
      if (current) current.applied = false;
      refreshEligibility();
      state.status =
        current?.editor && value && !state.canReplace
          ? '原稿或格式保护校验未通过，仅可复制译文。'
          : '可继续修改译文，确认后再操作。';
      render();
    },
    target(value) {
      if (writing || state.busy || !discard()) return;
      cancel();
      state.target = value;
      state.candidate = '';
      state.canReplace = false;
      state.status = '点击翻译以使用新的目标语言。';
      render();
    },
    scope(value) {
      if (writing || state.busy || !discard()) return;
      cancel();
      state.scope = value;
      state.candidate = '';
      state.canReplace = false;
      try {
        capture();
        state.status = '已更新翻译范围。';
      } catch (error) {
        state.status = userError(error);
      }
      render();
    },
    copy(original = false) {
      const text = original ? current?.editor?.previousOriginal() : state.candidate;
      if (!text) return;
      void navigator.clipboard.writeText(text).then(
        () => {
          state.status = '已复制。';
          render();
        },
        () => {
          state.status = '复制未完成，请手动选择文本复制。';
          render();
        },
      );
    },
    replace() {
      if (writing || state.busy) return;
      refreshEligibility();
      const draft = current;
      if (!state.canReplace || !draft?.editor || !draft.snapshot) {
        state.status = '原稿或格式已变化，请复制译文后手动修改。';
        render();
        return;
      }
      writing = true;
      state.canReplace = false;
      state.status = '正在替换…';
      render();
      void draft.editor
        .apply(draft.snapshot, state.candidate)
        .then((result) => {
          if (result.ok) {
            draft.applied = true;
            state.hasOriginal = true;
            state.status = '已替换，可恢复原文。';
          } else state.status = userError(result.reason);
          refreshEligibility();
        })
        .finally(() => {
          writing = false;
          render();
        });
    },
    restore() {
      const editor = current?.editor;
      if (writing || !editor) return;
      writing = true;
      void editor
        .restore()
        .then((result) => {
          state.status = result.ok ? '已恢复原文。' : userError(result.reason);
          state.hasOriginal = editor.previousOriginal() !== undefined;
          refreshEligibility();
        })
        .finally(() => {
          writing = false;
          render();
        });
    },
    close() {
      if (writing || !discard()) return;
      cancel();
      current = undefined;
      state.source = '';
      state.candidate = '';
      openSequence += 1;
      visible = false;
      host.style.setProperty('display', 'none', 'important');
      if (focusTarget?.isConnected) focusTarget.focus();
      render();
    },
  };
  const listener: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
    message,
    sender,
    sendResponse,
  ) => {
    if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('/background.js'))
      return;
    if (message?.protocolVersion === 1 && message.type === 'page.reset') {
      dispose();
      sendResponse({ ok: true });
      return;
    }
    if (
      message?.protocolVersion === 1 &&
      message.type === 'page.automatic' &&
      typeof message.enabled === 'boolean'
    ) {
      setAutomatic(message.enabled);
      sendResponse({ ok: true });
      return;
    }
    if (message?.protocolVersion === 1 && message.type === 'page.probe') {
      sendResponse({ ok: true, protocolVersion: 1, type: 'page.ready' });
      return;
    }
    if (
      message?.protocolVersion === 1 &&
      message.type === 'page.show' &&
      ['read', 'write'].includes(message.mode)
    ) {
      open(message.mode, false, message.autoTranslate === true);
      sendResponse({ ok: true });
      return;
    }
    const parsed = TaskEventSchema.safeParse(message);
    if (
      !parsed.success ||
      parsed.data.documentNonce !== registry.documentNonce ||
      parsed.data.clientTaskId !== current?.clientTaskId
    )
      return;
    const event = parsed.data;
    state.busy = false;
    if (event.type === 'translation.result') {
      current.baseline = event.result.text;
      current.backendAllows = event.canApply;
      state.candidate = event.result.text;
      state.model = event.provider.model;
      refreshEligibility();
      state.status =
        state.mode === 'write' && !state.canReplace
          ? '原稿已变化或翻译已恢复，仅可复制译文。'
          : '译文已就绪，请预览后操作。';
    } else {
      current.backendAllows = false;
      state.canReplace = false;
      state.status = userError(event.error ?? 'CONTEXT_LOST');
    }
    render();
    if (
      event.type === 'translation.result' &&
      current.quickReplace &&
      event.quickReplaceAllowed === true &&
      state.canReplace
    )
      actions.replace();
    sendResponse({ taskId: event.taskId, documentNonce: registry.documentNonce });
  };
  const focus = (event: FocusEvent) => {
    if (visible && state.mode === 'write' && !owns(event) && event.target instanceof Element)
      bind(event.target);
  };
  const selected = (event: Event) => {
    if (
      !(automatic || visible) ||
      !event.isTrusted ||
      owns(event) ||
      (event instanceof KeyboardEvent && event.key === 'Escape')
    )
      return;
    captureSelection();
    if (automatic && !state.busy && !writing) {
      const selected = window.getSelection();
      try {
        if (!selected || selected.isCollapsed || selected.rangeCount !== 1) {
          entry.hide();
          return;
        }
        selection.read(document);
        entry.show(selected.getRangeAt(0));
      } catch {
        entry.hide();
      }
    }
  };
  const changed = (event: Event) => {
    if (!owns(event)) {
      refreshEligibility();
      if (state.candidate && current?.editor && !state.canReplace && !current.applied)
        state.status = '原稿已修改，仅可复制译文。';
      render();
    }
  };
  const escape = (event: KeyboardEvent) => {
    if (event.isTrusted && event.key === 'Escape') {
      entry.hide();
      if (!visible) return;
      event.preventDefault();
      actions.close();
    }
  };
  document.addEventListener('keydown', escape);
  document.addEventListener('focusin', focus);
  document.addEventListener('pointerup', selected);
  document.addEventListener('keyup', selected);
  document.addEventListener('contextmenu', selected);
  document.addEventListener('input', changed);
  document.addEventListener('compositionstart', changed);
  browser.runtime.onMessage.addListener(listener);
  const observer = new MutationObserver(() => {
    if (!host.isConnected) dispose();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  function open(mode: 'read' | 'write', inline = false, autoTranslate = inline) {
    if (writing || state.busy) {
      state.status = userError('TASK_BUSY');
      render();
      return;
    }
    if (!discard()) return;
    cancel();
    entry.hide();
    entryMode = inline ? 'inline' : 'toolbar';
    const sequence = ++openSequence;
    state.openSequence = sequence;
    state.mode = mode;
    state.scope = 'selection';
    state.target = mode === 'read' ? 'zh-Hans' : 'en';
    state.source = '';
    state.candidate = '';
    state.model = '';
    state.ready = false;
    state.quickReplace = false;
    state.hasOriginal = false;
    state.canRestore = false;
    if (mode === 'read' && !inline) captureSelection();
    else if (mode === 'write') bind(document.activeElement);
    try {
      capture();
      state.status = '确认原文和目标语言后，点击翻译。';
    } catch (error) {
      current = undefined;
      state.status = userError(error);
    }
    visible = true;
    if (inline) entry.placePanel(host);
    else {
      host.style.removeProperty('left');
      host.style.removeProperty('right');
      host.style.removeProperty('top');
      host.style.removeProperty('--panel-top');
    }
    host.style.removeProperty('display');
    render();
    const target = state.target;
    void browser.runtime
      .sendMessage({ protocolVersion: 1, type: 'page.preferences', requestId: crypto.randomUUID() })
      .then(
        (response: {
          ok?: boolean;
          data?: {
            readTarget: string;
            writeTarget: string;
            theme: string;
            model?: string;
            quickReplace: boolean;
          };
        }) => {
          if (autoTranslate && sequence === openSequence && !response?.ok) {
            state.status = userError('CONTEXT_LOST');
            render();
            return;
          }
          if (
            response?.ok &&
            response.data &&
            openSequence === sequence &&
            state.mode === mode &&
            state.target === target &&
            !state.busy &&
            !state.candidate
          ) {
            state.target = mode === 'read' ? response.data.readTarget : response.data.writeTarget;
            state.ready = true;
            state.quickReplace = response.data.quickReplace;
            state.model = response.data.model ?? '';
            host.style.colorScheme =
              response.data.theme === 'system' ? 'light dark' : response.data.theme;
            render();
            if (autoTranslate && (!inline || automatic) && current) void begin();
          }
        },
      )
      .catch(() => {
        if (autoTranslate && sequence === openSequence) {
          state.status = userError('CONTEXT_LOST');
          render();
        }
      });
  }
  function setAutomatic(enabled: boolean) {
    automaticEpoch += 1;
    automatic = enabled;
    if (!enabled) {
      entry.hide();
      if (entryMode === 'inline' && state.busy) {
        cancel();
        state.status = userError('SITE_DISABLED');
        render();
      }
    }
    if (!enabled && !visible) selection.clear();
  }
  function dispose() {
    if (disposed) return;
    cancel();
    disposed = true;
    current = undefined;
    observer.disconnect();
    document.removeEventListener('keydown', escape);
    document.removeEventListener('focusin', focus);
    document.removeEventListener('pointerup', selected);
    document.removeEventListener('keyup', selected);
    document.removeEventListener('contextmenu', selected);
    document.removeEventListener('input', changed);
    document.removeEventListener('compositionstart', changed);
    try {
      browser.runtime.onMessage.removeListener(listener);
    } catch {
      /* Context already invalidated. */
    }
    window.removeEventListener('pagehide', dispose);
    entry.dispose();
    registry.dispose();
    selection.clear();
    root.unmount();
    host.remove();
    onDisposed();
  }
  window.addEventListener('pagehide', dispose, { once: true });
  const initializationEpoch = automaticEpoch;
  void browser.runtime
    .sendMessage({
      protocolVersion: 1,
      type: 'page.automatic-status',
      requestId: crypto.randomUUID(),
    })
    .then((reply: { ok?: boolean; enabled?: boolean }) => {
      if (!disposed && automaticEpoch === initializationEpoch && reply?.ok)
        setAutomatic(reply.enabled === true);
    })
    .catch(() => undefined);
  return { open, dispose, setAutomatic };
}
