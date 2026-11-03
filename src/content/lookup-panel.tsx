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
  constructor(
    private readonly documentNonce: string,
    private appearance: Appearance,
  ) {}
  open(text: string, anchor: DOMRect | undefined) {
    this.close();
    this.focus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const host = document.createElement('div');
    this.host = host;
    host.dataset.sayviaLookup = '';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = panelStyle;
    const body = document.createElement('div');
    shadow.append(style, body);
    document.documentElement.append(host);
    applyAppearance(host, this.appearance);
    this.root = createRoot(body);
    this.anchor = new AnchoredPanel(host);
    this.anchor.attach(() => anchor ?? new DOMRect(innerWidth - 20, 20, 0, 0), true);
    this.root.render(
      <LookupPanel text={text} documentNonce={this.documentNonce} onClose={() => this.close()} />,
    );
  }
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
    this.anchor?.dispose();
    this.anchor = undefined;
    this.root?.unmount();
    this.root = undefined;
    this.host?.remove();
    this.host = undefined;
    if (this.focus?.isConnected) this.focus.focus({ preventScroll: true });
    this.focus = undefined;
  }
}
