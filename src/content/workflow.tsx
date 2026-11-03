import { AnchoredPanel } from './anchored-panel';
import { copyText } from './copy-text';
import { newId } from '../runtime/uuid';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { FocusedEditorEntry } from './focused-editor-entry';
import { previewEditor } from '../adapters/preview-editor';
import { isTextControl, detectAdapter } from '../adapters/detect';
import { EditorRegistry } from '../adapters/registry';
import { ReadingSelectionCache } from '../adapters/selection-cache';
import { captureReadingSnapshot, type ReadingSnapshot } from '../adapters/reading-snapshot';
import { ReadingControls, type ReadingEntry } from './reading-controls';
import type { TextEditorSession } from '../adapters/text-session';
import type { TextControl, EditorSnapshot } from '../adapters/types';
import { parseSourceInput, type SourceInput } from '../core/source-input';
import { validateEditedTranslation } from '../core/translation-plan';
import { TaskEventSchema } from '../runtime/public-events';
import { userError } from '../runtime/user-errors';
import { TranslationPanel, type PanelActions, type PanelState } from '../ui/TranslationPanel';
import { SelectionEntry } from './selection-entry';
import { EditorEntries } from './editor-entry';
import { panelStyle } from './panel-style';
import {
  AppearanceSchema,
  PanelAppearancePatch,
  type PanelAppearanceInput,
} from '../storage/schema';
import { applyAppearance, defaultAppearance } from '../ui/appearance';

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
  reading?: ReadingSnapshot;
  readingEntry?: ReadingEntry;
  readingReady?: boolean;
};
export function mountWorkflow(onDisposed: () => void = () => undefined) {
  const registry = new EditorRegistry();
  const selection = new ReadingSelectionCache(true);
  let lastEditor: TextEditorSession | undefined;
  let lastPreview: HTMLElement | undefined;
  let previewRange: Range | undefined;
  let selectedPreview: { element: HTMLElement; range: Range } | undefined;
  let selectedEditor:
    { element: TextControl; editor: TextEditorSession; snapshot: EditorSnapshot } | undefined;
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
    appearance: { ...defaultAppearance },
    mode: 'write',
    openSequence: 0,
    source: '',
    candidate: '',
    target: 'en',
    sourceLanguage: 'auto',
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
  applyAppearance(host, state.appearance);
  let appearanceRevision = -1;
  let savedAppearance = { ...defaultAppearance };
  let appearanceVersion = 0;
  let pendingAppearance: PanelAppearanceInput = {};
  let appearanceQueue: Promise<void> = Promise.resolve();
  function receiveAppearance(value: unknown, revision: number) {
    if (disposed || revision < appearanceRevision) return;
    const appearance = AppearanceSchema.safeParse(value);
    if (!appearance.success) return;
    appearanceRevision = revision;
    savedAppearance = appearance.data;
    state.appearance = { ...appearance.data, ...pendingAppearance };
    applyAppearance(host, state.appearance);
    entry.setAppearance(state.appearance);
    writeEntry.setAppearance(state.appearance);
    focusedEntry.setAppearance(state.appearance);
    readingControls.setAppearance(state.appearance);
    if (visible) render();
  }
  const entry = new SelectionEntry(() => {
    if (automatic) {
      const preview = selectedPreview;
      const anchor = entry.panelAnchor();
      if (preview) {
        try {
          selection.read(document);
        } catch {
          open('read', true);
          return;
        }
      }
      open(preview ? 'write' : 'read', true, true, preview?.element, preview?.range);
      if (preview && anchor) anchoredPanel.attach(() => anchor);
    }
  });
  const writeEntry = new SelectionEntry(
    () => {
      const selected = selectedEditor;
      if (
        !automatic ||
        !selected ||
        !selected.editor.validate(selected.snapshot).ok ||
        !detectAdapter(selected.element) ||
        selected.element.selectionStart !== selected.snapshot.range.start ||
        selected.element.selectionEnd !== selected.snapshot.range.end
      ) {
        writeEntry.hide();
        selectedEditor = undefined;
        return;
      }
      const anchor = writeEntry.panelAnchor();
      open('write', true, true, selected.element);
      if (anchor && visible && current?.editor === selected.editor)
        anchoredPanel.attach(() => anchor);
    },
    '使用 Sayvia 翻译输入选区',
    'writing',
  );
  const anchoredPanel = new AnchoredPanel(host);
  const editorEntries = new EditorEntries((element) => {
    if (automatic) open('write', true, true, element);
  }, anchoredPanel.update);
  const focusedEntry = new FocusedEditorEntry(
    (element) => {
      if (automatic) open('write', true, true, element);
    },
    (element) => Boolean(editorEntries.anchorFor(element)),
  );
  const readingControls = new ReadingControls(state.appearance, showReadingEntry, () => {
    refreshEligibility();
    render();
  });
  const owns = (event: Event) =>
    event.composedPath().includes(host) ||
    entry.owns(event) ||
    writeEntry.owns(event) ||
    editorEntries.owns(event) ||
    focusedEntry.owns(event) ||
    readingControls.owns(event);
  const render = () => {
    if (!disposed) {
      host.style.setProperty(
        '--panel-width',
        state.mode === 'read' && state.source.length > 280 ? '520px' : '420px',
      );
      root.render(<TranslationPanel state={{ ...state }} actions={actions} />);
    }
  };
  const dirty = () =>
    Boolean(current && state.candidate !== current.baseline && state.candidate && !current.applied);
  const discard = () => !dirty() || window.confirm('译文有尚未应用的修改，是否放弃这些修改？');
  const bind = (element: Element | null) => {
    if (!element) return;
    const editor = registry.bind(element);
    if (editor) {
      lastEditor = editor;
      lastPreview = undefined;
      previewRange = undefined;
      focusTarget = element as HTMLElement;
    } else if (
      element.matches(
        'input, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
      ) ||
      (element instanceof HTMLElement && element.isContentEditable)
    ) {
      // An unsupported editing target must never fall back to a previous draft.
      lastEditor = undefined;
      const preview = previewEditor(element);
      if (lastPreview !== preview) previewRange = undefined;
      lastPreview = preview;
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
    releaseReading();
    if (state.mode === 'read') {
      const source = selection.read(document);
      const range = selection.readRange(document);
      const existing = readingControls.overlapping(range);
      if (existing) throw new Error('READING_ALREADY_APPLIED');
      const reading = captureReadingSnapshot(range, source);
      current = {
        source,
        baseline: '',
        eligible: false,
        backendAllows: false,
        applied: false,
        ...(reading ? { reading } : {}),
      };
      reading?.subscribe(() => {
        if (current?.reading === reading && state.candidate)
          state.status = '网页内容已更新，请重新选择并翻译。';
        refreshEligibility();
        render();
      });
    } else if (lastPreview && previewEditor(lastPreview)) {
      let range = previewRange;
      if (
        range &&
        (!lastPreview.contains(range.startContainer) || !lastPreview.contains(range.endContainer))
      )
        throw new Error('SELECTION_LOST');
      if (state.scope === 'full' || !range) {
        range = document.createRange();
        range.selectNodeContents(lastPreview);
      }
      const source = selection.captureRange(range, document);
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
    state.previewOnly = state.mode === 'write' && !current.editor;
    state.source =
      current.source.kind === 'dom-selection' ? selection.readText(document) : current.source.text;
    state.hasOriginal = current.editor?.previousOriginal() !== undefined;
    state.canRestore = current.editor?.canRestore() ?? false;
    state.canShowInPage = false;
  };
  function releaseReading() {
    if (current?.reading && !current.readingEntry) current.reading.dispose();
  }
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
    state.canShowInPage = Boolean(
      state.mode === 'read' &&
      draft.readingReady &&
      state.candidate &&
      validateEditedTranslation('markdown', draft.baseline, state.candidate) &&
      draft.reading?.canApply(state.candidate),
    );
  };
  const cancel = () => {
    const id = current?.clientTaskId;
    if (current) delete current.clientTaskId;
    state.busy = false;
    state.progress = undefined;
    state.metrics = undefined;
    state.canReplace = false;
    state.canShowInPage = false;
    if (current) current.readingReady = false;
    if (current) current.backendAllows = false;
    if (id) {
      try {
        void browser.runtime
          .sendMessage({
            protocolVersion: 1,
            requestId: newId(),
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
    const draft = current;
    let clientTaskId: string | undefined;
    try {
      if (entryMode === 'inline' && !automatic) throw new Error('SITE_DISABLED');
      if (!draft) throw new Error('EMPTY_SOURCE');
      if (draft.editor && draft.snapshot && !draft.editor.validate(draft.snapshot).ok)
        throw new Error('SOURCE_CHANGED');
      if (
        draft.source.kind === 'dom-selection' &&
        !draft.readingEntry &&
        JSON.stringify(selection.read(document)) !== JSON.stringify(draft.source)
      )
        throw new Error('SELECTION_LOST');
      if (draft.reading && !draft.reading.isValid()) throw new Error('SELECTION_LOST');
      clientTaskId = newId();
      draft.clientTaskId = clientTaskId;
      draft.readingReady = false;
      draft.quickReplace = false;
      state.candidate = '';
      state.busy = true;
      state.startedAt = Date.now();
      state.progress = undefined;
      state.metrics = undefined;
      state.canReplace = false;
      state.canShowInPage = false;
      state.status = '正在翻译…';
      render();
      if (state.mode === 'write') {
        const preferences = (await browser.runtime.sendMessage({
          protocolVersion: 1,
          type: 'page.preferences',
          requestId: newId(),
        })) as { ok?: boolean; data?: { quickReplace?: boolean } };
        if (disposed || current !== draft || draft.clientTaskId !== clientTaskId || !state.busy)
          return;
        if (!preferences?.ok || typeof preferences.data?.quickReplace !== 'boolean')
          throw new Error('CONTEXT_LOST');
        state.quickReplace = preferences.data.quickReplace && !state.previewOnly;
        draft.quickReplace = state.quickReplace;
        if (draft.editor && draft.snapshot && !draft.editor.validate(draft.snapshot).ok)
          throw new Error('SOURCE_CHANGED');
        render();
      }
      const response = (await browser.runtime.sendMessage({
        protocolVersion: 1,
        requestId: newId(),
        type: 'translation.start',
        payload: {
          clientTaskId,
          documentNonce: registry.documentNonce,
          mode: draft.source.kind === 'dom-selection' ? 'read' : state.mode,
          ...(entryMode === 'inline' ? { entry: 'inline' } : {}),
          scope: draft.snapshot?.scope ?? 'selection',
          source: draft.source,
          sourceLanguage: state.sourceLanguage,
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
      if (clientTaskId && (disposed || current !== draft || draft?.clientTaskId !== clientTaskId))
        return;
      state.busy = false;
      state.progress = undefined;
      state.canReplace = false;
      state.status =
        error instanceof Error && error.message === 'SOURCE_CHANGED' && !state.candidate
          ? '原稿已修改，请重新读取原文后再翻译。'
          : userError(error);
      render();
    }
  };
  const actions: PanelActions = {
    resetPosition: anchoredPanel.resetPosition,
    appearance(input) {
      const patch = PanelAppearancePatch.parse(input);
      if (
        Object.entries(patch).every(
          ([key, value]) => state.appearance[key as keyof typeof patch] === value,
        )
      )
        return;
      const version = ++appearanceVersion;
      pendingAppearance = { ...pendingAppearance, ...patch };
      state.appearance = { ...state.appearance, ...patch };
      applyAppearance(host, state.appearance);
      readingControls.setAppearance(state.appearance);
      render();
      appearanceQueue = appearanceQueue
        .then(async () => {
          const reply = (await browser.runtime.sendMessage({
            protocolVersion: 1,
            requestId: newId(),
            type: 'page.appearance',
            payload: patch,
          })) as { ok?: boolean; data?: { appearance: unknown; revision: number } };
          if (!reply.ok || !reply.data) throw new Error();
          if (version === appearanceVersion) {
            pendingAppearance = {};
            if (state.status === '外观尚未保存，请稍后重试。') state.status = '';
          }
          receiveAppearance(reply.data.appearance, reply.data.revision);
        })
        .catch(() => {
          if (version === appearanceVersion) {
            pendingAppearance = {};
            receiveAppearance(savedAppearance, appearanceRevision);
          }
          if (!disposed) {
            state.status = '外观尚未保存，请稍后重试。';
            render();
          }
        });
    },
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
    sourceLanguage(value) {
      if (writing || state.busy || !discard()) return;
      cancel();
      state.sourceLanguage = value;
      state.candidate = '';
      state.canReplace = false;
      state.status = '点击翻译以使用新的源语言。';
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
      void copyText(text, shadow).then(
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
    showInPage() {
      if (writing || state.busy) return;
      refreshEligibility();
      const draft = current;
      if (!state.canShowInPage || !draft?.reading || draft.source.kind !== 'dom-selection') {
        state.status = '原文或译文结构已变化，仅可预览与复制。';
        render();
        return;
      }
      const readingEntry: ReadingEntry = {
        snapshot: draft.reading,
        source: draft.source,
        originalText: state.source,
        candidate: state.candidate,
        target: state.target,
        model: state.model,
      };
      if (!draft.reading.show(state.candidate)) {
        refreshEligibility();
        render();
        return;
      }
      const mounted = readingControls.add(readingEntry);
      if (!mounted) {
        draft.reading.show(null);
        state.status = '无法在此位置显示，请复制译文。';
        render();
        return;
      }
      draft.readingEntry = mounted;
      draft.applied = true;
      draft.baseline = state.candidate;
      actions.close();
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
      const draft = current;
      const editor = draft?.editor;
      if (writing || !editor) return;
      writing = true;
      void editor
        .restore(draft.snapshot)
        .then((result) => {
          if (result.ok && result.snapshot && current === draft) {
            draft.snapshot = result.snapshot;
            draft.eligible = true;
            draft.applied = false;
          }
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
      releaseReading();
      current = undefined;
      state.source = '';
      state.candidate = '';
      openSequence += 1;
      visible = false;
      anchoredPanel.detach();
      if (shadow.activeElement instanceof HTMLElement) shadow.activeElement.blur();
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
    if (message?.type === 'app.appearance-changed' && Number.isInteger(message.revision)) {
      receiveAppearance(message.appearance, message.revision);
      return;
    }
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
    if (event.type === 'translation.progress') {
      if (state.busy && (!state.progress || event.progress.elapsedMs >= state.progress.elapsedMs)) {
        state.progress = event.progress;
        render();
      }
      return;
    }
    state.busy = false;
    state.progress = undefined;
    if (event.type === 'translation.result') {
      state.metrics = event.result;
      current.baseline = event.result.text;
      current.readingReady = event.result.requested;
      current.backendAllows = event.canApply;
      state.candidate = event.result.requested ? event.result.text : '';
      if (!event.result.requested) current.backendAllows = false;
      state.model = event.provider.model;
      refreshEligibility();
      state.status = !event.result.requested
        ? '未执行翻译：所选内容仅含需原样保留的链接或格式片段，未发送给模型。'
        : event.result.text === current.source.text
          ? '结果与原文相同，已原样保留。'
          : state.previewOnly
            ? '此编辑器提供预览与复制，请复制译文后粘贴。'
            : state.mode === 'write' && !state.canReplace
              ? '原稿已变化或翻译已恢复，仅可复制译文。'
              : state.mode === 'read' && !state.canShowInPage
                ? '此选区结构暂不支持原位显示，可预览与复制。'
                : '译文已就绪，请预览后操作。';
    } else {
      current.backendAllows = false;
      current.readingReady = false;
      state.canReplace = false;
      state.canShowInPage = false;
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
    if (!owns(event) && event.target !== selectedEditor?.element) {
      writeEntry.hide();
      selectedEditor = undefined;
    }
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
    writeEntry.hide();
    selectedEditor = undefined;
    selectedPreview = undefined;
    focusedEntry.update();
    if (
      event.target instanceof Element &&
      isTextControl(event.target) &&
      detectAdapter(event.target)
    ) {
      entry.hide();
      const element = event.target;
      if (
        automatic &&
        !state.busy &&
        !writing &&
        (element.selectionEnd ?? 0) > (element.selectionStart ?? 0)
      ) {
        const editor = registry.bind(element);
        if (editor) {
          try {
            selectedEditor = { element, editor, snapshot: editor.capture() };
            writeEntry.showRect(
              element.getBoundingClientRect(),
              event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : undefined,
            );
          } catch {
            selectedEditor = undefined;
          }
        }
      }
      return;
    }
    captureSelection();
    if (automatic && !state.busy && !writing) {
      const selected = window.getSelection();
      try {
        if (!selected || selected.isCollapsed || selected.rangeCount !== 1) {
          entry.hide();
          return;
        }
        selection.read(document);
        const preview = event.target instanceof Element ? previewEditor(event.target) : undefined;
        if (
          preview &&
          preview.contains(selected.anchorNode) &&
          preview.contains(selected.focusNode)
        ) {
          selectedPreview = { element: preview, range: selected.getRangeAt(0).cloneRange() };
          if (preview === lastPreview) previewRange = selected.getRangeAt(0).cloneRange();
        }
        entry.show(
          selected.getRangeAt(0),
          event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : undefined,
        );
      } catch {
        entry.hide();
      }
    }
  };
  const changed = (event: Event) => {
    if (!owns(event)) {
      writeEntry.hide();
      selectedEditor = undefined;
      refreshEligibility();
      if (state.candidate && current?.editor && !state.canReplace && !current.applied)
        state.status = '原稿已修改，仅可复制译文。';
      render();
    }
  };
  const escape = (event: KeyboardEvent) => {
    if (event.isTrusted && event.key === 'Escape') {
      entry.hide();
      writeEntry.hide();
      selectedEditor = undefined;
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
    if (
      selectedEditor &&
      (!selectedEditor.editor.validate(selectedEditor.snapshot).ok ||
        !detectAdapter(selectedEditor.element))
    ) {
      writeEntry.hide();
      selectedEditor = undefined;
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  function open(
    mode: 'read' | 'write',
    inline = false,
    autoTranslate = inline,
    editorTarget?: Element,
    capturedPreviewRange?: Range,
  ) {
    if (writing || state.busy) {
      state.status = userError('TASK_BUSY');
      render();
      return;
    }
    if (!discard()) return;
    if (mode === 'read') {
      const live = window.getSelection();
      if (live?.rangeCount === 1 && !live.isCollapsed) {
        const existing = readingControls.overlapping(live.getRangeAt(0));
        if (existing) {
          showReadingEntry(existing);
          return;
        }
      }
    }
    cancel();
    entry.hide();
    writeEntry.hide();
    selectedEditor = undefined;
    selectedPreview = undefined;
    previewRange = undefined;
    anchoredPanel.detach();
    entryMode = inline ? 'inline' : 'toolbar';
    const sequence = ++openSequence;
    state.openSequence = sequence;
    state.mode = mode;
    if (
      mode === 'read' &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== host
    )
      focusTarget = document.activeElement;
    state.scope = 'selection';
    state.target = mode === 'read' ? 'zh-Hans' : 'en';
    state.sourceLanguage = 'auto';
    state.source = '';
    state.candidate = '';
    state.model = '';
    state.ready = false;
    state.quickReplace = false;
    state.hasOriginal = false;
    state.canRestore = false;
    state.canShowInPage = false;
    if (mode === 'read' && !inline) {
      const live = window.getSelection();
      if (autoTranslate && (!live || live.isCollapsed || live.rangeCount !== 1)) selection.clear();
      captureSelection();
    } else if (mode === 'write') {
      bind(editorTarget ?? document.activeElement);
      const live = window.getSelection();
      if (capturedPreviewRange) previewRange = capturedPreviewRange.cloneRange();
      else if (
        lastPreview &&
        live &&
        !live.isCollapsed &&
        live.rangeCount === 1 &&
        lastPreview.contains(live.anchorNode) &&
        lastPreview.contains(live.focusNode)
      )
        previewRange = live.getRangeAt(0).cloneRange();
    }
    try {
      capture();
      state.status = state.previewOnly
        ? '此编辑器提供预览与复制，请复制译文后粘贴。'
        : '确认原文和目标语言后，点击翻译。';
    } catch (error) {
      current = undefined;
      state.status = userError(error);
    }
    visible = true;
    {
      host.style.removeProperty('left');
      host.style.removeProperty('right');
      host.style.removeProperty('top');
      host.style.removeProperty('--panel-top');
    }
    host.style.removeProperty('display');
    render();
    if (inline && mode === 'read') anchoredPanel.attach(() => entry.panelAnchor(), true);
    if (inline && mode === 'write' && editorTarget)
      anchoredPanel.attach(editorEntries.panelAnchorFor(editorTarget));
    const target = state.target;
    void browser.runtime
      .sendMessage({ protocolVersion: 1, type: 'page.preferences', requestId: newId() })
      .then(
        (response: {
          ok?: boolean;
          data?: {
            readTarget: string;
            writeTarget: string;
            theme: string;
            appearance: unknown;
            revision: number;
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
            state.quickReplace = response.data.quickReplace && !state.previewOnly;
            state.model = response.data.model ?? '';
            receiveAppearance(response.data.appearance, response.data.revision);
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
      readingControls.clear();
      releaseReading();
      refreshEligibility();
    }
    if (!enabled) {
      writeEntry.hide();
      selectedEditor = undefined;
    }
    editorEntries.setEnabled(enabled);
    focusedEntry.setEnabled(enabled);
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
  function showReadingEntry(readingEntry: ReadingEntry) {
    if (writing || state.busy || !discard() || !readingEntry.snapshot.isValid()) return;
    cancel();
    releaseReading();
    current = {
      source: readingEntry.source,
      baseline: readingEntry.candidate,
      eligible: false,
      backendAllows: false,
      applied: true,
      reading: readingEntry.snapshot,
      readingEntry,
      readingReady: true,
    };
    state.mode = 'read';
    state.previewOnly = false;
    state.source = readingEntry.originalText;
    state.candidate = readingEntry.candidate;
    state.target = readingEntry.target;
    state.model = readingEntry.model;
    state.sourceLanguage = 'auto';
    state.ready = true;
    state.busy = false;
    state.hasOriginal = false;
    state.canRestore = false;
    state.canReplace = false;
    state.metrics = undefined;
    state.progress = undefined;
    state.startedAt = undefined;
    state.openSequence = ++openSequence;
    state.status = '译文已就绪，请预览后操作。';
    visible = true;
    host.style.removeProperty('display');
    anchoredPanel.attach(
      () => readingEntry.snapshot.tail.parentElement?.getBoundingClientRect(),
      true,
    );
    refreshEligibility();
    render();
  }
  function dispose() {
    if (disposed) return;
    cancel();
    releaseReading();
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
    writeEntry.dispose();
    selectedEditor = undefined;
    editorEntries.dispose();
    focusedEntry.dispose();
    readingControls.dispose();
    anchoredPanel.dispose();
    registry.dispose();
    selection.clear();
    root.unmount();
    host.remove();
    onDisposed();
  }
  window.addEventListener('pagehide', dispose, { once: true });
  void browser.runtime
    .sendMessage({ protocolVersion: 1, type: 'page.preferences', requestId: newId() })
    .then((reply: { ok?: boolean; data?: { appearance: unknown; revision: number } }) => {
      if (reply.ok && reply.data) receiveAppearance(reply.data.appearance, reply.data.revision);
    })
    .catch(() => undefined);
  const initializationEpoch = automaticEpoch;
  void browser.runtime
    .sendMessage({
      protocolVersion: 1,
      type: 'page.automatic-status',
      requestId: newId(),
    })
    .then((reply: { ok?: boolean; enabled?: boolean }) => {
      if (!disposed && automaticEpoch === initializationEpoch && reply?.ok)
        setAutomatic(reply.enabled === true);
    })
    .catch(() => undefined);
  return { open, dispose, setAutomatic };
}
