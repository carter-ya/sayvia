import { normalizeBaseUrl } from '../providers/endpoint';

export const PRECONNECT_TTL_MS = 15_000;

// A hint only: never fetch a URL, send credentials or keep sockets alive with heartbeats.
export class Preconnection {
  private link: HTMLLinkElement | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly document: Document,
    private readonly expired: () => void,
  ) {}

  get active() {
    return this.link !== undefined;
  }

  warm(origin: string) {
    const normalized = normalizeBaseUrl(origin);
    if (normalized !== new URL(normalized).origin) throw new Error('INVALID_ORIGIN');
    if (this.link?.href === normalized + '/') return;
    this.dispose();
    const link = this.document.createElement('link');
    link.rel = 'preconnect';
    link.crossOrigin = 'anonymous';
    link.href = normalized;
    this.document.head.append(link);
    this.link = link;
    this.timer = setTimeout(() => {
      this.dispose();
      this.expired();
    }, PRECONNECT_TTL_MS);
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.link?.remove();
    this.link = undefined;
  }
}
