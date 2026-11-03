import { createRoot, type Root } from 'react-dom/client';
import { Icon } from '../ui/Icon';
import { applyAppearance, appearanceStyle, type Appearance } from '../ui/appearance';
import { copyText } from './copy-text';
import type { ReadingSnapshot } from '../adapters/reading-snapshot';
import type { DomSource } from '../core/source-input';

export interface ReadingEntry {
  snapshot: ReadingSnapshot;
  source: DomSource;
  originalText: string;
  candidate: string;
  target: string;
  model: string;
}
type Mounted = ReadingEntry & {
  host: HTMLSpanElement;
  shadow: ShadowRoot;
  root: Root;
  unsubscribe: () => void;
};
const styleText =
  appearanceStyle +
  `
:host { all: initial; display: inline-block; position: relative; vertical-align: baseline; margin-left: 5px; font: 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif; color: var(--ink); color-scheme: light dark; }
* { box-sizing: border-box; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 5px; font: inherit; line-height: 18px; padding: 4px 8px; color: var(--ink); background: transparent; border: 1px solid transparent; border-radius: 13px; cursor: pointer; white-space: nowrap; }
button:hover { background: color-mix(in srgb,var(--tint) 55%,transparent); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button svg { width: 13px; height: 13px; color: var(--muted); flex-shrink: 0; }
.entry { padding: 1px 4px; gap: 4px; color: var(--muted); background: linear-gradient(var(--glass-legibility),var(--glass-legibility)),color-mix(in srgb,var(--surface) 20%,transparent); }
.entry:hover,.entry[aria-expanded='true'] { background: linear-gradient(var(--glass-legibility),var(--glass-legibility)),color-mix(in srgb,var(--tint) 28%,transparent); }
:host([data-popover]) { position: fixed; margin: 0; z-index: 2147483647; }
.bar { display: flex; gap: 1px; padding: 3px; width: max-content; border: 1px solid var(--line); border-radius: 17px; background: var(--surface); box-shadow: 0 4px 14px light-dark(#222a3214,#00000055),inset 0 1px 1px light-dark(#ffffffb3,#ffffff24); }
:host([data-material='liquid']) .bar { background: linear-gradient(var(--glass-legibility),var(--glass-legibility)),linear-gradient(130deg,light-dark(#ffffff36,#ffffff09),transparent 55%),color-mix(in srgb,var(--surface) var(--glass-opacity),transparent); backdrop-filter: blur(10px) saturate(145%); border-color: light-dark(#ffffff96,#d9e7e83d); }
:host([data-material='glass']) .bar { background: linear-gradient(var(--glass-legibility),var(--glass-legibility)),color-mix(in srgb,var(--surface) var(--glass-opacity),transparent); backdrop-filter: blur(18px) saturate(125%); }
:host([data-material='transparent']) .bar { background: linear-gradient(var(--glass-legibility),var(--glass-legibility)),color-mix(in srgb,var(--surface) var(--glass-opacity),transparent); }
.notice { position: absolute; top: calc(100% + 4px); right: 0; padding: 4px 8px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; color: var(--muted); white-space: nowrap; font-size: 11px; }
@supports not (backdrop-filter: blur(1px)) { :host .bar { background: var(--surface) !important; } }
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) { :host .bar { background: var(--surface) !important; backdrop-filter: none !important; } }
@media (pointer: coarse) { button { min-width: 44px; min-height: 44px; } }
`;

export class ReadingControls {
  private readonly entries: Mounted[] = [];
  private active: Mounted | undefined;
  private readonly popover = document.createElement('span');
  private readonly popoverShadow: ShadowRoot;
  private readonly root: Root;
  private readonly observer: MutationObserver;
  private notice = '';
  private frame = 0;
  private disposed = false;
  constructor(
    private appearance: Appearance,
    private readonly view: (entry: ReadingEntry) => void,
    private readonly changed: () => void,
  ) {
    this.popover.dataset.sayviaUi = '';
    this.popover.dataset.popover = '';
    this.popover.style.display = 'none';
    this.popoverShadow = this.popover.attachShadow({ mode: 'open' });
    this.root = this.mountRoot(this.popoverShadow);
    applyAppearance(this.popover, appearance);
    this.observer = new MutationObserver(() => {
      for (const entry of [...this.entries])
        if (!entry.host.isConnected || !entry.snapshot.isValid()) this.remove(entry, false);
      this.position();
    });
    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    document.addEventListener('pointerdown', this.outside, true);
    document.addEventListener('keydown', this.keydown, true);
    window.addEventListener('scroll', this.position, true);
    window.addEventListener('resize', this.position);
    window.addEventListener('popstate', this.navigation);
    window.addEventListener('hashchange', this.navigation);
  }
  private mountRoot(shadow: ShadowRoot) {
    const style = document.createElement('style'),
      container = document.createElement('span');
    style.textContent = styleText;
    shadow.append(style, container);
    return createRoot(container);
  }
  owns(event: Event) {
    return event
      .composedPath()
      .some((node) => node === this.popover || this.entries.some((entry) => node === entry.host));
  }
  overlapping(range: Range) {
    return this.entries.find(
      (entry) =>
        entry.snapshot.isValid() && entry.snapshot.nodes.some((node) => range.intersectsNode(node)),
    );
  }
  add(input: ReadingEntry) {
    const existing = this.entries.find((entry) => entry.snapshot === input.snapshot);
    if (existing) {
      Object.assign(existing, input);
      this.renderEntry(existing);
      return existing;
    }
    for (const entry of this.entries)
      if (entry.snapshot.nodes.some((node) => input.snapshot.nodes.includes(node))) return;
    while (this.entries.length >= 20) this.remove(this.entries[0]!, true);
    const host = document.createElement('span');
    host.dataset.sayviaUi = '';
    host.dataset.sayviaReading = '';
    const shadow = host.attachShadow({ mode: 'open' });
    const entry: Mounted = {
      ...input,
      host,
      shadow,
      root: this.mountRoot(shadow),
      unsubscribe: () => undefined,
    };
    const tail = input.snapshot.tail;
    const anchor = tail.parentElement?.closest('a,code') ?? tail;
    anchor.parentNode?.insertBefore(host, anchor.nextSibling);
    if (!host.isConnected) {
      entry.root.unmount();
      return;
    }
    this.entries.push(entry);
    entry.unsubscribe = input.snapshot.subscribe(() => {
      this.remove(entry, false);
      this.changed();
    });
    applyAppearance(host, this.appearance);
    this.renderEntry(entry);
    return entry;
  }
  setAppearance(appearance: Appearance) {
    this.appearance = appearance;
    applyAppearance(this.popover, appearance);
    for (const entry of this.entries) applyAppearance(entry.host, appearance);
  }
  private renderEntry(entry: Mounted) {
    entry.root.render(
      <button
        className="entry"
        type="button"
        aria-label="Sayvia 翻译操作"
        aria-expanded={this.active === entry}
        onClick={(event) => {
          if (!event.nativeEvent.isTrusted) return;
          if (!entry.snapshot.isValid()) return;
          if (this.active === entry) this.close();
          else {
            this.close();
            this.active = entry;
            this.notice = '';
            this.renderEntry(entry);
            this.renderBar();
          }
        }}
      >
        {entry.snapshot.showingTranslation ? '译文' : '原文'}
        <Icon name="more" />
      </button>,
    );
  }
  private renderBar() {
    const entry = this.active;
    if (!entry) return;
    if (!this.popover.isConnected) document.documentElement.append(this.popover);
    const trusted = (action: () => void) => (event: React.MouseEvent<HTMLButtonElement>) => {
      if (event.nativeEvent.isTrusted && entry.snapshot.isValid()) action();
    };
    this.root.render(
      <>
        <span className="bar" role="toolbar" aria-label="译文快捷操作">
          <button
            type="button"
            aria-label={entry.snapshot.showingTranslation ? '显示原文' : '显示译文'}
            onClick={trusted(() => {
              if (entry.snapshot.show(entry.snapshot.showingTranslation ? null : entry.candidate)) {
                this.renderEntry(entry);
                this.renderBar();
                this.changed();
              }
            })}
          >
            <Icon name="swap" />
            {entry.snapshot.showingTranslation ? '原文' : '译文'}
          </button>
          <button
            type="button"
            aria-label="复制译文"
            onClick={trusted(() => {
              void copyText(entry.candidate, this.popoverShadow).then(
                () => {
                  this.notice = '已复制';
                  this.renderBar();
                },
                () => {
                  this.notice = '请打开译文后手动复制';
                  this.renderBar();
                },
              );
            })}
          >
            <Icon name="copy" />
            复制
          </button>
          <button
            type="button"
            aria-label="查看译文"
            onClick={trusted(() => {
              this.close();
              this.view(entry);
            })}
          >
            <Icon name="preview" />
            查看
          </button>
        </span>
        {this.notice && (
          <span className="notice" role="status">
            {this.notice}
          </span>
        )}
      </>,
    );
    this.popover.style.removeProperty('display');
    this.position();
  }
  private position = () => {
    if (this.frame || this.disposed || !this.active) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const entry = this.active;
      if (!entry) return;
      const anchor = entry.host.getBoundingClientRect(),
        menu = this.popover.getBoundingClientRect();
      const x = Math.max(8, Math.min(anchor.right - menu.width, innerWidth - menu.width - 8));
      const below = anchor.bottom + 5;
      const y = Math.max(
        8,
        Math.min(
          below + menu.height <= innerHeight - 8 ? below : anchor.top - menu.height - 5,
          innerHeight - menu.height - 8,
        ),
      );
      this.popover.style.left = `${x}px`;
      this.popover.style.top = `${y}px`;
    });
  };
  private outside = (event: Event) => {
    if (!this.owns(event)) this.close();
  };
  private keydown = (event: KeyboardEvent) => {
    if (event.isTrusted && event.key === 'Escape' && this.active) {
      event.stopPropagation();
      const entry = this.active;
      this.close();
      entry.shadow.querySelector('button')?.focus();
    }
  };
  private navigation = () => {
    for (const entry of [...this.entries]) if (!entry.snapshot.isValid()) this.remove(entry, false);
  };
  private close() {
    const previous = this.active;
    this.active = undefined;
    this.popover.style.display = 'none';
    if (previous) this.renderEntry(previous);
  }
  private remove(entry: Mounted, restore: boolean) {
    const index = this.entries.indexOf(entry);
    if (index < 0) return;
    this.entries.splice(index, 1);
    if (this.active === entry) this.close();
    entry.unsubscribe();
    entry.snapshot.dispose(restore);
    entry.root.unmount();
    entry.host.remove();
  }
  clear() {
    for (const entry of [...this.entries]) this.remove(entry, true);
  }
  dispose() {
    this.disposed = true;
    this.observer.disconnect();
    cancelAnimationFrame(this.frame);
    document.removeEventListener('pointerdown', this.outside, true);
    document.removeEventListener('keydown', this.keydown, true);
    window.removeEventListener('scroll', this.position, true);
    window.removeEventListener('resize', this.position);
    window.removeEventListener('popstate', this.navigation);
    window.removeEventListener('hashchange', this.navigation);
    this.clear();
    this.root.unmount();
    this.popover.remove();
  }
}
