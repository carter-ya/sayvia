// Keep toolbar popovers anchored; reading can use the full viewport for long text.
export class AnchoredPanel {
  private anchor: (() => HTMLElement | DOMRect | null | undefined) | undefined;
  private allowOverlap = false;
  private frame: number | undefined;
  private lastRect: DOMRect | undefined;
  private readonly observer = new ResizeObserver(() => this.update());
  constructor(private readonly host: HTMLElement) {}
  attach(anchor: () => HTMLElement | DOMRect | null | undefined, allowOverlap = false) {
    this.detach();
    this.anchor = anchor;
    this.allowOverlap = allowOverlap;
    this.observer.observe(this.host);
    this.observer.observe(document.documentElement);
    if (document.body) this.observer.observe(document.body);
    window.addEventListener('resize', this.update);
    window.addEventListener('scroll', this.update, true);
    this.update();
  }
  update = () => {
    if (!this.anchor || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      const anchor = this.anchor?.();
      if (anchor instanceof DOMRect) this.lastRect = anchor;
      else if (anchor?.isConnected) this.lastRect = anchor.getBoundingClientRect();
      const rect = this.lastRect;
      if (!rect) return;
      const width = this.host.getBoundingClientRect().width;
      const section = this.host.shadowRoot?.querySelector('section');
      const result = this.allowOverlap
        ? section?.querySelector<HTMLElement>('.result-region')
        : undefined;
      const overflow = result ? Math.max(0, result.scrollHeight - result.clientHeight) : 0;
      const height = Math.min(
        680,
        (section?.scrollHeight ?? this.host.getBoundingClientRect().height) + overflow + 2,
      );
      const gap = 8;
      const below = Math.max(0, innerHeight - rect.bottom - gap * 2);
      const above = Math.max(0, rect.top - gap * 2);
      const down = below >= height || below >= above;
      const overlap = this.allowOverlap && height > Math.max(below, above);
      const available = Math.max(
        1,
        overlap ? innerHeight - gap * 2 : Math.min(down ? below : above, innerHeight - gap * 2),
      );
      const left = Math.max(gap, Math.min(rect.right - width, innerWidth - width - gap));
      const top = Math.max(
        gap,
        Math.min(
          overlap || down ? rect.bottom + gap : rect.top - gap - Math.min(height, available),
          innerHeight - Math.min(height, available) - gap,
        ),
      );
      this.host.style.setProperty('left', `${left}px`, 'important');
      this.host.style.setProperty('right', 'auto', 'important');
      this.host.style.setProperty('top', `${top}px`, 'important');
      this.host.style.setProperty('--panel-top', `${top}px`);
      this.host.style.setProperty('--panel-max-height', `${available}px`);
    });
  };
  detach() {
    this.observer.disconnect();
    window.removeEventListener('resize', this.update);
    window.removeEventListener('scroll', this.update, true);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.anchor = undefined;
    this.lastRect = undefined;
    for (const property of ['left', 'right', 'top', '--panel-top', '--panel-max-height'])
      this.host.style.removeProperty(property);
  }
}
