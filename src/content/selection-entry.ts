import { appearanceStyle, applyAppearance, type Appearance } from '../ui/appearance';

// A small independent host keeps the entry available while the dialog is closed.
export class SelectionEntry {
  private readonly host = document.createElement('div');
  private readonly button = document.createElement('button');
  private lookupButton: HTMLButtonElement | undefined;
  private anchor?: { x: number; y: number };
  constructor(
    activate: () => void,
    label = '使用 Sayvia 翻译选中文字',
    kind: 'reading' | 'writing' | 'editor' = 'reading',
    lookup?: () => void,
  ) {
    if (kind === 'reading') this.host.dataset.sayviaEntry = '';
    else if (kind === 'writing') this.host.dataset.sayviaEditorSelectionEntry = '';
    else this.host.dataset.sayviaEditorFocusEntry = '';
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent =
      appearanceStyle +
      `:host { all: initial; position: fixed; z-index: 2147483647; display: none; color-scheme: light dark; }
      button { display: grid; place-items: center; width: 26px; height: 26px; padding: 4px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--accent); box-shadow: 0 2px 8px #142f3426; cursor: pointer; }
      svg { width: 17px; height: 17px; } button:hover { background: var(--tint); } button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`;
    this.button.type = 'button';
    this.button.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h12M9 2v3M12 5c-1 6-4 9-8 11M6 8c1 3 3 5 6 7M13 21l4-11 4 11M14.5 17h5"/></svg>';
    this.button.setAttribute('aria-label', label);
    this.button.title = '翻译';
    this.button.addEventListener('pointerdown', (event) => {
      if (event.isTrusted) event.preventDefault();
    });
    this.button.addEventListener('click', (event) => {
      if (event.isTrusted) activate();
    });
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:4px;width:max-content';
    actions.append(this.button);
    if (lookup) {
      this.lookupButton = document.createElement('button');
      this.lookupButton.type = 'button';
      this.lookupButton.setAttribute('aria-label', '使用 Sayvia 查词');
      this.lookupButton.title = '查词';
      this.lookupButton.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/></svg>';
      this.lookupButton.addEventListener('pointerdown', (event) => {
        if (event.isTrusted) event.preventDefault();
      });
      this.lookupButton.addEventListener('click', (event) => {
        if (event.isTrusted) lookup();
      });
      actions.append(this.lookupButton);
    }
    shadow.append(style, actions);
    document.documentElement.append(this.host);
    window.addEventListener('resize', this.position);
    window.addEventListener('scroll', this.hide, true);
  }
  owns(event: Event) {
    return event.composedPath().includes(this.host);
  }
  setAppearance(appearance: Appearance) {
    applyAppearance(this.host, appearance);
  }
  setLookupAvailable(available: boolean) {
    if (this.lookupButton) this.lookupButton.style.display = available ? '' : 'none';
  }
  show(range: Range, pointer?: { x: number; y: number }) {
    const rects = range.getClientRects();
    const rect = rects[rects.length - 1] ?? range.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      this.hide();
      return;
    }
    this.showRect(rect, pointer);
  }
  showRect(rect: DOMRect, pointer?: { x: number; y: number }) {
    // Pointer selection follows the release point; keyboard selection uses its final line.
    this.anchor = pointer
      ? { x: pointer.x + 8, y: pointer.y + 10 }
      : { x: rect.right + 6, y: rect.bottom + 6 };
    this.host.style.setProperty('display', 'block', 'important');
    this.position();
  }
  private position = () => {
    if (!this.anchor) return;
    const left = Math.max(
      6,
      Math.min(
        this.anchor.x,
        window.innerWidth - Math.max(32, this.host.getBoundingClientRect().width + 6),
      ),
    );
    const top = Math.max(6, Math.min(this.anchor.y, window.innerHeight - 32));
    this.host.style.setProperty('left', `${left}px`, 'important');
    this.host.style.setProperty('top', `${top}px`, 'important');
  };
  panelAnchor() {
    return this.anchor ? new DOMRect(this.anchor.x, this.anchor.y, 0, 0) : undefined;
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
