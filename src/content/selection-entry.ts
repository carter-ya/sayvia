// A separate tiny host stays visible while the translation dialog is closed.
export class SelectionEntry {
  private readonly host = document.createElement('div');
  private readonly button = document.createElement('button');
  private anchor?: { x: number; y: number };
  constructor(activate: () => void) {
    this.host.dataset.sayviaEntry = '';
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `:host { all: initial; position: fixed; z-index: 2147483647; display: none; }
      button { width: 36px; height: 36px; padding: 0; border: 1px solid #ffffff40; border-radius: 12px; background: #24634f; color: #fff; font: 600 20px/1 system-ui; box-shadow: 0 3px 14px #142f3433; cursor: pointer; }
      button:hover { background: #174d3c; transform: translateY(-1px); } button:focus-visible { outline: 3px solid #8fbda8; outline-offset: 3px; }
      @media (prefers-reduced-motion: no-preference) { button { transition: background .15s, transform .15s; } }`;
    this.button.type = 'button';
    this.button.textContent = 'S';
    this.button.setAttribute('aria-label', '使用 Sayvia 翻译选中文字');
    this.button.title = '翻译选中文字';
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
  show(range: Range) {
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      this.hide();
      return;
    }
    this.anchor = { x: rect.right, y: rect.bottom + 8 };
    this.host.style.setProperty('display', 'block', 'important');
    this.position();
  }
  private position = () => {
    if (!this.anchor) return;
    const left = Math.max(8, Math.min(this.anchor.x - 18, window.innerWidth - 44));
    const top = Math.max(8, Math.min(this.anchor.y, window.innerHeight - 44));
    this.host.style.setProperty('left', `${left}px`, 'important');
    this.host.style.setProperty('top', `${top}px`, 'important');
  };
  placePanel(host: HTMLElement) {
    if (!this.anchor) return;
    host.style.setProperty(
      'left',
      `max(12px, min(${this.anchor.x - 18}px, calc(100vw - 422px)))`,
      'important',
    );
    const top = `max(12px, min(${this.anchor.y + 42}px, calc(100dvh - 580px)))`;
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
