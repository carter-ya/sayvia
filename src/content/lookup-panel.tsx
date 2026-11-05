import { createRoot, type Root } from 'react-dom/client';
import { LookupPanel } from '../ui/LookupPanel';
import { applyAppearance, type Appearance } from '../ui/appearance';
import { panelStyle } from './panel-style';
import { AnchoredPanel } from './anchored-panel';

export class LookupPopover {
  private host: HTMLElement | undefined;
  private root: Root | undefined;
  private anchor: AnchoredPanel | undefined;
  private focus: HTMLElement | undefined;
  private fallbackFocus: (() => HTMLElement | undefined) | undefined;
  private fullscreenRoot: HTMLElement | undefined;
  constructor(
    private readonly documentNonce: string,
    private appearance: Appearance,
  ) {}
  open(
    text: string,
    anchor: DOMRect | undefined,
    options: {
      sourceLanguage?: string;
      fullscreenRoot?: HTMLElement;
      focus?: HTMLElement;
      fallbackFocus?: () => HTMLElement | undefined;
    } = {},
  ) {
    this.close();
    this.focus =
      options.focus ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    this.fallbackFocus = options.fallbackFocus;
    this.fullscreenRoot = options.fullscreenRoot;
    const host = document.createElement('div');
    this.host = host;
    host.dataset.sayviaLookup = '';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    // Video frames can be arbitrarily dark or bright; keep caption cards legible
    // regardless of the user's translucent material preference.
    style.textContent =
      panelStyle +
      (options.fullscreenRoot ? '\n:host section{background:var(--surface)!important}' : '');
    const body = document.createElement('div');
    shadow.append(style, body);
    document.documentElement.append(host);
    host.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.isTrusted && event.key === 'Escape') this.close();
    });
    host.addEventListener('keyup', (event) => event.stopPropagation());
    host.addEventListener('click', (event) => event.stopPropagation());
    applyAppearance(host, this.appearance);
    this.root = createRoot(body);
    this.anchor = new AnchoredPanel(host);
    this.anchor.attach(() => anchor ?? new DOMRect(innerWidth - 20, 20, 0, 0), true);
    this.root.render(
      <LookupPanel
        text={text}
        documentNonce={this.documentNonce}
        onClose={() => this.close()}
        initialSourceLanguage={options.sourceLanguage ?? 'auto'}
        caption={!!options.sourceLanguage}
      />,
    );
    if (this.fullscreenRoot) {
      document.addEventListener('fullscreenchange', this.mountForFullscreen);
      this.mountForFullscreen();
    }
  }
  private mountForFullscreen = () => {
    if (!this.host || !this.fullscreenRoot) return;
    const full = document.fullscreenElement;
    if (!this.fullscreenRoot.isConnected || (full && !full.contains(this.fullscreenRoot))) {
      this.close();
      return;
    }
    const parent = full ?? document.documentElement;
    if (this.host.parentElement !== parent) {
      const focused = this.host.shadowRoot?.activeElement;
      parent.append(this.host);
      if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    }
    this.anchor?.update();
  };
  owns(event: Event) {
    return !!this.host && event.composedPath().includes(this.host);
  }
  get visible() {
    return !!this.host;
  }
  setAppearance(value: Appearance) {
    this.appearance = value;
    if (this.host) applyAppearance(this.host, value);
  }
  close() {
    document.removeEventListener('fullscreenchange', this.mountForFullscreen);
    this.fullscreenRoot = undefined;
    this.anchor?.dispose();
    this.anchor = undefined;
    this.root?.unmount();
    this.root = undefined;
    this.host?.remove();
    this.host = undefined;
    const focus = this.focus?.isConnected ? this.focus : this.fallbackFocus?.();
    if (focus?.isConnected) focus.focus({ preventScroll: true });
    this.focus = undefined;
    this.fallbackFocus = undefined;
  }
}
