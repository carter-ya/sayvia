// Keep toolbar popovers anchored; reading can use the full viewport for long text.
export class AnchoredPanel {
  private anchor: (() => HTMLElement | DOMRect | null | undefined) | undefined;
  private allowOverlap = false;
  private frame: number | undefined;
  private lastRect: DOMRect | undefined;
  private manual: { x: number; y: number } | undefined;
  private drag: { id: number; x: number; y: number; left: number; top: number } | undefined;
  private readonly observer = new ResizeObserver(() => this.update());
  constructor(private readonly host: HTMLElement) {
    host.addEventListener('pointerdown', this.startDrag);
    host.addEventListener('pointermove', this.moveDrag);
    host.addEventListener('pointerup', this.endDrag);
    host.addEventListener('pointercancel', this.endDrag);
    host.addEventListener('lostpointercapture', this.endDrag);
    host.addEventListener('keydown', this.moveByKeyboard);
  }
  private watch() {
    this.observer.observe(this.host);
    this.observer.observe(document.documentElement);
    if (document.body) this.observer.observe(document.body);
    window.addEventListener('resize', this.update);
    window.addEventListener('scroll', this.update, true);
  }
  private startDrag = (event: PointerEvent) => {
    if (!event.isTrusted || event.button !== 0) return;
    const path = event.composedPath();
    if (!path.some((node) => node instanceof HTMLElement && node.hasAttribute('data-panel-drag')))
      return;
    const control = path.find(
      (node) =>
        node instanceof HTMLElement && node.matches('button, input, select, textarea, summary, a'),
    ) as HTMLElement | undefined;
    if (control && !control.hasAttribute('data-panel-move')) return;
    const rect = this.host.getBoundingClientRect();
    this.drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    this.host.setPointerCapture(event.pointerId);
    this.watch();
    event.preventDefault();
    event.stopPropagation();
  };
  private moveDrag = (event: PointerEvent) => {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    this.manual = { x: drag.left + event.clientX - drag.x, y: drag.top + event.clientY - drag.y };
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches)
      this.host.style.setProperty(
        '--glass-light-x',
        `${Math.max(10, Math.min(90, 28 + (event.clientX - drag.x) * 0.16))}%`,
      );
    this.update();
  };
  private endDrag = () => {
    const drag = this.drag;
    this.drag = undefined;
    if (drag && this.host.hasPointerCapture(drag.id)) this.host.releasePointerCapture(drag.id);
  };
  private moveByKeyboard = (event: KeyboardEvent) => {
    if (
      !event.isTrusted ||
      !event
        .composedPath()
        .some((node) => node instanceof HTMLElement && node.hasAttribute('data-panel-move'))
    )
      return;
    const delta = {
      ArrowLeft: [-16, 0],
      ArrowRight: [16, 0],
      ArrowUp: [0, -16],
      ArrowDown: [0, 16],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = this.host.getBoundingClientRect();
    this.manual = { x: rect.left + delta[0]!, y: rect.top + delta[1]! };
    this.watch();
    this.update();
  };
  resetPosition = () => {
    this.manual = undefined;
    if (this.anchor) this.update();
    else this.detach();
  };
  attach(anchor: () => HTMLElement | DOMRect | null | undefined, allowOverlap = false) {
    this.detach();
    this.anchor = anchor;
    this.allowOverlap = allowOverlap;
    this.watch();
    this.update();
  }
  update = () => {
    if ((!this.anchor && !this.manual) || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      if (this.manual) {
        this.host.style.setProperty('--panel-max-height', `${Math.max(1, innerHeight - 16)}px`);
        const box = this.host.getBoundingClientRect();
        const left = Math.max(8, Math.min(this.manual.x, innerWidth - box.width - 8));
        const top = Math.max(8, Math.min(this.manual.y, innerHeight - box.height - 8));
        this.host.style.setProperty('left', `${left}px`, 'important');
        this.host.style.setProperty('right', 'auto', 'important');
        this.host.style.setProperty('top', `${top}px`, 'important');
        this.host.style.setProperty('--panel-top', `${top}px`);
        this.manual = { x: left, y: top };
        return;
      }
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
    this.endDrag();
    this.manual = undefined;
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
  dispose() {
    this.detach();
    this.host.removeEventListener('pointerdown', this.startDrag);
    this.host.removeEventListener('pointermove', this.moveDrag);
    this.host.removeEventListener('pointerup', this.endDrag);
    this.host.removeEventListener('pointercancel', this.endDrag);
    this.host.removeEventListener('lostpointercapture', this.endDrag);
    this.host.removeEventListener('keydown', this.moveByKeyboard);
  }
}
