// A small independent host keeps the entry available while the dialog is closed.
export class SelectionEntry {
  private readonly host = document.createElement('div');
  private readonly button = document.createElement('button');
  private anchor?: { x: number; y: number };
  constructor(activate: () => void) {
    this.host.dataset.sayviaEntry = '';
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `:host { all: initial; position: fixed; z-index: 2147483647; display: none; }
      button { display: grid; place-items: center; width: 26px; height: 26px; padding: 4px; border: 1px solid #d9e2dc; border-radius: 7px; background: #fff; color: #286947; box-shadow: 0 2px 8px #142f3426; cursor: pointer; }
      svg { width: 17px; height: 17px; } button:hover { background: #edf4ef; } button:focus-visible { outline: 2px solid #8fbda8; outline-offset: 2px; }
      @media (prefers-color-scheme: dark) { button { background: #25342c; color: #b0d8bc; border-color: #48604f; } button:hover { background: #304438; } }`;
    this.button.type = 'button';
    this.button.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h12M9 2v3M12 5c-1 6-4 9-8 11M6 8c1 3 3 5 6 7M13 21l4-11 4 11M14.5 17h5"/></svg>';
    this.button.setAttribute('aria-label', '使用 Sayvia 翻译选中文字');
    this.button.title = '翻译';
    this.button.addEventListener('pointerdown', (event) => {
      if (event.isTrusted) event.preventDefault();
    });
    this.button.addEventListener('click', (event) => {
      if (event.isTrusted) activate();
    });
    shadow.append(style, this.button);
    document.documentElement.append(this.host);
    window.addEventListener('resize', this.position);
    window.addEventListener('scroll', this.hide, true);
  }
  owns(event: Event) {
    return event.composedPath().includes(this.host);
  }
  show(range: Range, pointer?: { x: number; y: number }) {
    const rects = range.getClientRects();
    const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      this.hide();
      return;
    }
    // Pointer selection follows the release point; keyboard selection uses its final line.
    this.anchor = pointer
      ? { x: pointer.x + 8, y: pointer.y + 10 }
      : { x: rect.right + 6, y: rect.bottom + 6 };
    this.host.style.setProperty('display', 'block', 'important');
    this.position();
  }
  private position = () => {
    if (!this.anchor) return;
    const left = Math.max(6, Math.min(this.anchor.x, window.innerWidth - 32));
    const top = Math.max(6, Math.min(this.anchor.y, window.innerHeight - 32));
    this.host.style.setProperty('left', `${left}px`, 'important');
    this.host.style.setProperty('top', `${top}px`, 'important');
  };
  placePanel(host: HTMLElement) {
    if (!this.anchor) return;
    host.style.setProperty(
      'left',
      `max(8px, min(${this.anchor.x}px, calc(100vw - 352px)))`,
      'important',
    );
    const top = `max(8px, min(${this.anchor.y + 32}px, calc(100dvh - 350px)))`;
    host.style.setProperty('--panel-top', top);
    host.style.setProperty('top', top, 'important');
    host.style.setProperty('right', 'auto', 'important');
  }
  hide = () => {
    this.host.style.setProperty('display', 'none', 'important');
  };
  dispose() {
    window.removeEventListener('resize', this.position);
    window.removeEventListener('scroll', this.hide, true);
    this.host.remove();
  }
}
