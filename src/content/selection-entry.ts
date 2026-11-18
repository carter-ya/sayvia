import { appearanceStyle, applyAppearance, type Appearance } from '../ui/appearance';

const size = 26;
const gap = 6;

// A small independent host keeps the entry available while the dialog is closed.
export class SelectionEntry {
  private readonly host = document.createElement('div');
  private readonly button = document.createElement('button');
  private lookupButton: HTMLButtonElement | undefined;
  private anchor: { left: number; top: number; bottom: number } | undefined;
  private buttonRect?: DOMRect;
  constructor(
    activate: () => void,
    label = '使用 Sayvia 翻译选中文字',
    kind: 'reading' | 'writing' = 'reading',
    lookup?: () => void,
  ) {
    if (kind === 'reading') this.host.dataset.sayviaEntry = '';
    else this.host.dataset.sayviaEditorSelectionEntry = '';
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent =
      appearanceStyle +
      `:host { all: initial; position: fixed; z-index: 2147483647; display: none; color-scheme: light dark; }
      button { display: grid; place-items: center; box-sizing: border-box; width: ${size}px; height: ${size}px; padding: 4px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--accent); box-shadow: 0 2px 8px #142f3426; cursor: pointer; }
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
  show(selection: Selection, pointer?: { x: number; y: number }) {
    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
    if (pointer) {
      const line = rects.find((rect) => rect.top <= pointer.y && pointer.y <= rect.bottom);
      this.place(pointer.x + 8, line?.top ?? pointer.y, line?.bottom ?? pointer.y);
      return;
    }
    // A backward keyboard selection ends at the start of the DOM range.
    const backward =
      selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset;
    const line = backward ? rects[0] : rects.at(-1);
    if (!line) return this.hide();
    this.place(backward ? line.left : line.right + gap, line.top, line.bottom);
  }
  showRect(rect: DOMRect, pointer?: { x: number; y: number }) {
    // Native controls have no range rectangles. Use the release point, or
    // keep the whole button outside the field when invoked from the keyboard.
    if (pointer) this.place(pointer.x + 8, pointer.y - gap, pointer.y + gap);
    else this.place(rect.right - size, rect.top, rect.bottom);
  }
  private place(left: number, top: number, bottom: number) {
    this.anchor = { left, top, bottom };
    this.position();
  }
  private position = () => {
    if (!this.anchor) return;
    const { left, top, bottom } = this.anchor;
    const actionWidth =
      this.lookupButton && this.lookupButton.style.display !== 'none' ? size * 2 + 4 : size;
    const x = Math.max(gap, Math.min(left, window.innerWidth - actionWidth - gap));
    const y = top - gap - size >= gap ? top - gap - size : Math.max(gap, bottom + gap);
    // Clamping onto a tall editor would put the action over the text/caret.
    if (y + size + gap > window.innerHeight) return this.hide();
    this.buttonRect = new DOMRect(x, y, size, size);
    this.host.style.setProperty('left', `${x}px`, 'important');
    this.host.style.setProperty('top', `${y}px`, 'important');
    this.host.style.setProperty('display', 'block', 'important');
  };
  panelAnchor() {
    return this.buttonRect;
  }

  hide = () => {
    this.anchor = undefined;
    this.host.style.setProperty('display', 'none', 'important');
  };
  dispose() {
    window.removeEventListener('resize', this.position);
    window.removeEventListener('scroll', this.hide, true);
    this.host.remove();
  }
}
