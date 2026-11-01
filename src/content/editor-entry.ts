import { detectAdapter } from '../adapters/detect';

const selector = 'textarea[name="comment[body]"], textarea#new_comment_field';
// Only explicitly enabled GitHub pages receive these controls. No editor text is read here.
export class EditorEntries {
  private readonly entries = new Map<HTMLTextAreaElement, HTMLElement>();
  private observer: MutationObserver | undefined;
  private frame: number | undefined;
  private enabled = false;
  private readonly navigation = (window as unknown as { navigation?: EventTarget }).navigation;
  constructor(private readonly activate: (element: HTMLTextAreaElement) => void) {}
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
              target.matches(selector) ||
              Boolean(target.querySelector(selector))
            );
          }
          return [...record.addedNodes, ...record.removedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.matches(selector + ', [data-sayvia-write-entry]') ||
                Boolean(node.querySelector(selector))),
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
      if (!host.isConnected || detectAdapter(element) !== 'github-markdown') {
        host.remove();
        this.entries.delete(element);
      } else if (element.nextSibling !== host) element.after(host);
    }
    for (const element of document.querySelectorAll<HTMLTextAreaElement>(selector)) {
      if (this.entries.has(element) || detectAdapter(element) !== 'github-markdown') continue;
      const host = document.createElement('span');
      host.dataset.sayviaWriteEntry = '';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `:host { all: initial; display: flex; justify-content: flex-end; margin: 6px 0; color-scheme: light dark; }
        button { display: inline-flex; align-items: center; gap: 6px; color: light-dark(#24634f,#c1e6d0); background: light-dark(#f3f8f3,#23372e); border: 1px solid light-dark(#c7d8cc,#4a6856); border-radius: 8px; padding: 6px 10px; font: 500 12px/1.4 system-ui; cursor: pointer; }
        button:hover { filter: brightness(.94); } button:focus-visible { outline: 2px solid #739f87; outline-offset: 3px; }
        b { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 5px; background: #24634f; color: #fff; font-size: 12px; }`;
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', '使用 Sayvia 翻译这份评论');
      button.title = '翻译选区或全文，预览后由你发布';
      const mark = document.createElement('b');
      mark.textContent = 'S';
      mark.setAttribute('aria-hidden', 'true');
      button.append(mark, document.createTextNode('翻译'));
      button.addEventListener('pointerdown', (event) => {
        if (event.isTrusted) event.preventDefault();
      });
      button.addEventListener('click', (event) => {
        if (!event.isTrusted || !this.enabled) return;
        if (detectAdapter(element) !== 'github-markdown') {
          this.scan();
          return;
        }
        this.activate(element);
      });
      shadow.append(style, button);
      this.entries.set(element, host);
      element.after(host);
    }
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
