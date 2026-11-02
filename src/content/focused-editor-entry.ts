import { detectAdapter } from '../adapters/detect';
import { previewEditor } from '../adapters/preview-editor';
import { SelectionEntry } from './selection-entry';

// One contextual action for the focused editor, regardless of website. Discovery
// does not read drafts. A site toolbar takes priority when one is available.
export class FocusedEditorEntry {
  private enabled = false;
  private target: Element | undefined;
  private frame: number | undefined;
  private observer: MutationObserver | undefined;
  private resize = new ResizeObserver(() => this.schedule());
  private readonly entry: SelectionEntry;
  constructor(
    private activate: (element: Element) => void,
    private hasToolbar: (element: Element) => boolean,
  ) {
    this.entry = new SelectionEntry(
      () => {
        const target = this.target;
        if (this.enabled && target && this.supported(target) && !this.hasToolbar(target))
          this.activate(target);
      },
      '使用 Sayvia 翻译输入内容',
      'editor',
    );
  }
  private supported(element: Element) {
    return Boolean(detectAdapter(element) || previewEditor(element));
  }
  owns(event: Event) {
    return this.entry.owns(event);
  }
  setEnabled(enabled: boolean) {
    this.stop();
    this.enabled = enabled;
    if (!enabled) return;
    document.addEventListener('focusin', this.focus);
    window.addEventListener('resize', this.schedule);
    window.addEventListener('scroll', this.schedule, true);
    this.observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            !(record.target instanceof Element) ||
            !record.target.closest('[data-sayvia-editor-focus-entry]'),
        )
      )
        this.schedule();
    });
    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'disabled',
        'readonly',
        'hidden',
        'inert',
        'aria-hidden',
        'aria-disabled',
        'aria-readonly',
        'type',
        'autocomplete',
        'style',
        'class',
        'contenteditable',
      ],
    });
    this.focus();
  }
  private focus = (event?: FocusEvent) => {
    if (event && this.owns(event)) return;
    this.resize.disconnect();
    const active = document.activeElement;
    this.target = active && this.supported(active) ? (previewEditor(active) ?? active) : undefined;
    if (this.target) this.resize.observe(this.target);
    this.schedule();
  };
  private schedule = () => {
    if (!this.enabled || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.update();
    });
  };
  update() {
    this.entry.hide();
    const element = this.target;
    if (!this.enabled || !element || !this.supported(element) || this.hasToolbar(element)) return;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      if ((element.selectionEnd ?? 0) > (element.selectionStart ?? 0)) return;
    } else {
      const selected = window.getSelection();
      if (selected && !selected.isCollapsed && element.contains(selected.anchorNode)) return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth)
      return;
    this.entry.showRect(rect, {
      x: rect.right - 34,
      y: rect.top >= 34 ? rect.top - 42 : rect.bottom - 6,
    });
  }
  private stop() {
    this.enabled = false;
    this.entry.hide();
    this.resize.disconnect();
    this.observer?.disconnect();
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    document.removeEventListener('focusin', this.focus);
    window.removeEventListener('resize', this.schedule);
    window.removeEventListener('scroll', this.schedule, true);
    this.target = undefined;
  }
  dispose() {
    this.stop();
    this.entry.dispose();
  }
}
