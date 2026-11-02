import { detectAdapter } from '../adapters/detect';

const selector = 'textarea[name="comment[body]"], textarea#new_comment_field';
const toolbarSelector = 'markdown-toolbar, [role="toolbar"]';
const watchedSelector = `${selector}, ${toolbarSelector}, [data-sayvia-write-entry]`;
const visibleToolbar = (toolbar: HTMLElement) =>
  !toolbar.closest('[hidden], [inert], [aria-hidden="true"]') &&
  getComputedStyle(toolbar).visibility !== 'hidden' &&
  (toolbar.getClientRects().length > 0 ||
    [...toolbar.children].some((child) => child.getClientRects().length > 0));
// Prefer GitHub's explicit toolbar/textarea association. Never guess across editors.
function toolbarFor(element: HTMLTextAreaElement): HTMLElement | undefined {
  if (element.id) {
    if (document.getElementById(element.id) !== element) return;
    const linked = [...document.querySelectorAll<HTMLElement>(toolbarSelector)].filter(
      (toolbar) =>
        visibleToolbar(toolbar) &&
        (toolbar.getAttribute('for') === element.id ||
          toolbar.getAttribute('aria-controls')?.split(/\s+/).includes(element.id)),
    );
    if (linked.length === 1) return linked[0];
    if (linked.length > 1) return;
  }
  const boundary = element.closest(
    'form, [role="form"], tab-container, markdown-editor, .js-previewable-comment-form, [data-testid="markdown-editor"]',
  );
  if (!boundary) return;
  for (
    let root = element.parentElement;
    root && root !== document.body;
    root = root.parentElement
  ) {
    const fields = [...root.querySelectorAll(selector)];
    if (fields.length !== 1 || fields[0] !== element) return;
    const candidates = [...root.querySelectorAll<HTMLElement>(toolbarSelector)].filter(
      (toolbar) =>
        visibleToolbar(toolbar) &&
        !toolbar.hasAttribute('for') &&
        !toolbar.hasAttribute('aria-controls'),
    );
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1 || root === boundary) return;
  }
  return undefined;
}
// No editor text is read while discovering or mounting controls.
export class EditorEntries {
  private readonly entries = new Map<HTMLTextAreaElement, HTMLElement>();
  private observer: MutationObserver | undefined;
  private frame: number | undefined;
  private enabled = false;
  private readonly navigation = (window as unknown as { navigation?: EventTarget }).navigation;
  constructor(
    private readonly activate: (element: HTMLTextAreaElement) => void,
    private readonly layoutChanged: () => void = () => undefined,
  ) {}
  anchorFor(element: Element) {
    return this.entries.get(element as HTMLTextAreaElement)?.shadowRoot?.querySelector('button');
  }
  owns(event: Event) {
    return [...this.entries.values()].some((host) => event.composedPath().includes(host));
  }
  setEnabled(enabled: boolean) {
    this.stop();
    this.enabled = enabled && location.hostname === 'github.com';
    if (!this.enabled) return;
    this.observer = new MutationObserver((records) => {
      if (
        records.some((record) => {
          if (record.type === 'attributes') {
            const target = record.target as Element;
            return (
              this.entries.has(target as HTMLTextAreaElement) ||
              target.matches(watchedSelector) ||
              Boolean(target.querySelector(watchedSelector))
            );
          }
          return [...record.addedNodes, ...record.removedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.matches(watchedSelector) || Boolean(node.querySelector(watchedSelector))),
          );
        })
      )
        this.schedule();
    });
    this.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'disabled',
        'readonly',
        'hidden',
        'inert',
        'aria-hidden',
        'style',
        'class',
        'id',
        'name',
        'for',
        'role',
        'aria-controls',
      ],
    });
    window.addEventListener('popstate', this.schedule);
    this.navigation?.addEventListener('currententrychange', this.schedule);
    document.addEventListener('turbo:load', this.schedule);
    this.scan();
  }
  private schedule = () => {
    if (!this.enabled || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.scan();
    });
  };
  private scan() {
    if (!this.enabled) return;
    for (const [element, host] of this.entries) {
      const toolbar = toolbarFor(element);
      if (detectAdapter(element) !== 'github-markdown' || !toolbar) {
        host.remove();
        this.entries.delete(element);
      } else if (host.parentElement !== toolbar) toolbar.append(host);
    }
    for (const element of document.querySelectorAll<HTMLTextAreaElement>(selector)) {
      if (this.entries.has(element) || detectAdapter(element) !== 'github-markdown') continue;
      const toolbar = toolbarFor(element);
      if (!toolbar) continue;
      const host = document.createElement('span');
      host.dataset.sayviaWriteEntry = '';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `:host { all: initial; display: inline-flex; flex: 0 0 auto; align-self: center; vertical-align: middle; margin-inline-start: 2px; color-scheme: light dark; }
        button { display: grid; place-items: center; width: 28px; height: 28px; padding: 5px; box-sizing: border-box; color: var(--fgColor-muted, light-dark(#59636e,#9198a1)); background: transparent; border: 0; border-radius: 6px; cursor: pointer; }
        button:hover { color: var(--fgColor-default, light-dark(#1f2328,#f0f6fc)); background: var(--control-transparent-bgColor-hover, light-dark(#818b981f,#656c7633)); }
        button:focus-visible { outline: 2px solid var(--focus-outlineColor,#0969da); outline-offset: 1px; }
        svg { width: 18px; height: 18px; }`;
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', '使用 Sayvia 翻译这份评论');
      button.title = '翻译';
      button.setAttribute('aria-haspopup', 'dialog');
      button.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h12M9 2v3M12 5c-1 6-4 9-8 11M6 8c1 3 3 5 6 7M13 21l4-11 4 11M14.5 17h5"/></svg>';
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      });
      button.addEventListener('pointerdown', (event) => {
        if (event.isTrusted) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
      button.addEventListener('click', (event) => {
        if (!event.isTrusted || !this.enabled) return;
        event.stopPropagation();
        if (
          detectAdapter(element) !== 'github-markdown' ||
          toolbarFor(element) !== host.parentElement
        ) {
          this.scan();
          return;
        }
        this.activate(element);
      });
      shadow.append(style, button);
      this.entries.set(element, host);
      toolbar.append(host);
    }
    this.layoutChanged();
  }
  private stop() {
    this.enabled = false;
    this.observer?.disconnect();
    this.observer = undefined;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    window.removeEventListener('popstate', this.schedule);
    this.navigation?.removeEventListener('currententrychange', this.schedule);
    document.removeEventListener('turbo:load', this.schedule);
    for (const host of this.entries.values()) host.remove();
    this.entries.clear();
  }
  dispose() {
    this.stop();
  }
}
