import { isEligible } from './detect';
import { trackDocument } from './document-lifetime';
import type { AdapterKind, ApplyResult, EditorSnapshot, RestoreRecord, TextControl } from './types';

export class TextEditorSession {
  readonly id = crypto.randomUUID();
  private revision = 0;
  private composing = false;
  private invalid = false;
  private writing = false;
  private record: RestoreRecord | undefined;
  private readonly captures = new WeakSet<EditorSnapshot>();
  private readonly ownEvents = new WeakSet<Event>();
  private readonly document: Document;
  private readonly navigation: EventTarget | undefined;
  private readonly url: string;
  private observedValue: string;
  private readonly lifetime: ReturnType<typeof trackDocument>;
  private readonly anchors = new Set<Node>();

  constructor(
    private readonly element: TextControl,
    private readonly kind: AdapterKind,
    private readonly documentNonce: string,
    private readonly onDispose: () => void = () => undefined,
  ) {
    this.document = element.ownerDocument;
    this.url = this.document.URL;
    this.observedValue = element.value;
    let ancestor: Node | null = element;
    while (ancestor) {
      this.anchors.add(ancestor);
      ancestor = ancestor.parentNode;
    }
    this.lifetime = trackDocument(element.ownerDocument, (records) => {
      if (
        records.some((record) => [...record.removedNodes].some((node) => this.anchors.has(node)))
      ) {
        this.dispose();
      }
    });
    element.addEventListener('input', this.changed);
    element.addEventListener('change', this.changed);
    element.addEventListener('compositionstart', this.compositionStart);
    element.addEventListener('compositionend', this.compositionEnd);
    const window = this.document.defaultView;
    this.navigation = (window as unknown as { navigation?: EventTarget } | null)?.navigation;
    this.navigation?.addEventListener('navigate', this.dispose);
    window?.addEventListener('pagehide', this.dispose);
    window?.addEventListener('popstate', this.dispose);
    window?.addEventListener('hashchange', this.dispose);
  }

  private changed = (event: Event) => {
    const value = this.element.value;
    // Input includes undo; change may only commit an already observed edit on blur.
    if (!this.ownEvents.has(event) && (event.type === 'input' || value !== this.observedValue)) {
      this.revision += 1;
    }
    this.observedValue = value;
  };
  private compositionStart = () => {
    this.composing = true;
    this.revision += 1;
  };
  private compositionEnd = () => {
    this.composing = false;
    this.revision += 1;
  };

  capture(): EditorSnapshot {
    const reason = this.contextError();
    if (reason) throw new Error(reason);
    if (this.composing) throw new Error('COMPOSING');
    const fullText = this.element.value;
    if (fullText !== this.observedValue) this.revision += 1;
    this.observedValue = fullText;
    const start = this.element.selectionStart ?? 0;
    const end = this.element.selectionEnd ?? start;
    const selection = end > start;
    const snapshot: EditorSnapshot = Object.freeze({
      editorSessionId: this.id,
      documentNonce: this.documentNonce,
      revision: this.revision,
      fullText,
      range: Object.freeze(selection ? { start, end } : { start: 0, end: fullText.length }),
      scope: selection ? 'selection' : 'full',
      format: this.kind === 'github-markdown' ? 'markdown' : 'plain-text',
    });
    this.captures.add(snapshot);
    return snapshot;
  }

  private contextError(): 'CONTEXT_LOST' | 'UNSUPPORTED' | undefined {
    this.lifetime.flush();
    if (
      this.invalid ||
      !this.element.isConnected ||
      this.element.ownerDocument !== this.document ||
      this.document.URL !== this.url
    ) {
      return 'CONTEXT_LOST';
    }
    if (!isEligible(this.element)) return 'UNSUPPORTED';
    return undefined;
  }

  validate(snapshot: EditorSnapshot): ApplyResult {
    const reason = this.contextError();
    if (reason) return { ok: false, reason };
    if (this.composing) return { ok: false, reason: 'COMPOSING' };
    if (
      !this.captures.has(snapshot) ||
      snapshot.revision !== this.revision ||
      snapshot.fullText !== this.element.value
    )
      return { ok: false, reason: 'SOURCE_CHANGED' };
    return { ok: true };
  }

  async apply(snapshot: EditorSnapshot, translation: string): Promise<ApplyResult> {
    if (this.writing) return { ok: false, reason: 'BUSY' };
    const valid = this.validate(snapshot);
    if (!valid.ok) return valid;
    const { start, end } = snapshot.range;
    const next = snapshot.fullText.slice(0, start) + translation + snapshot.fullText.slice(end);
    const written = await this.write(next, start + translation.length);
    if (written.ok)
      this.record = { before: snapshot.fullText, after: next, revision: this.revision };
    return written;
  }

  previousOriginal() {
    return this.record?.before;
  }

  async restore(): Promise<ApplyResult> {
    if (this.writing) return { ok: false, reason: 'BUSY' };
    const reason = this.contextError();
    if (reason) return { ok: false, reason };
    if (this.composing) return { ok: false, reason: 'COMPOSING' };
    if (
      !this.record ||
      this.record.revision !== this.revision ||
      this.record.after !== this.element.value
    ) {
      return { ok: false, reason: 'SOURCE_CHANGED' };
    }
    const result = await this.write(this.record.before, this.record.before.length);
    if (result.ok) this.record = undefined;
    return result;
  }

  private async write(value: string, caret: number): Promise<ApplyResult> {
    const element = this.element;
    if (element.maxLength >= 0 && value.length > element.maxLength) {
      return { ok: false, reason: 'WRITE_REJECTED' };
    }
    const window = this.document.defaultView;
    if (!window) return { ok: false, reason: 'CONTEXT_LOST' };
    const prototype =
      element instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) return { ok: false, reason: 'UNSUPPORTED' };
    // Probe native value sanitization without mutating the live draft or its revision.
    const probe = this.document.createElement(
      element instanceof HTMLTextAreaElement ? 'textarea' : 'input',
    );
    if (probe instanceof HTMLInputElement && element instanceof HTMLInputElement) {
      probe.type = element.type;
    }
    setter.call(probe, value);
    if (probe.value !== value) return { ok: false, reason: 'WRITE_REJECTED' };
    this.writing = true;
    const revision = ++this.revision;
    try {
      setter.call(element, value);
      element.setSelectionRange(caret, caret);
      const event = new window.InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertReplacementText',
        data: null,
      });
      this.ownEvents.add(event);
      element.dispatchEvent(event);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const reason = this.contextError();
      if (reason) return { ok: false, reason };
      if (this.revision !== revision || element.value !== value) {
        return { ok: false, reason: 'WRITE_REJECTED' };
      }
      return { ok: true };
    } finally {
      this.writing = false;
    }
  }

  dispose = () => {
    if (this.invalid) return;
    this.invalid = true;
    this.lifetime.unsubscribe();
    this.navigation?.removeEventListener('navigate', this.dispose);
    const element = this.element;
    element.removeEventListener('input', this.changed);
    element.removeEventListener('change', this.changed);
    element.removeEventListener('compositionstart', this.compositionStart);
    element.removeEventListener('compositionend', this.compositionEnd);
    const window = this.document.defaultView;
    window?.removeEventListener('pagehide', this.dispose);
    window?.removeEventListener('popstate', this.dispose);
    window?.removeEventListener('hashchange', this.dispose);
    this.onDispose();
  };
}
