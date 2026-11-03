import {
  OVERLAY_ATTRIBUTE,
  READY_ATTRIBUTE,
  compatibleDisplay,
  restoreNativeCaptions,
  visibleCaptionBounds,
} from './display-lease';
import { captionWords } from './words';
export type CaptionDisplayRow = {
  unitId: string;
  original: string;
  translation: string | undefined;
};
export type CaptionDisplayMode = 'bilingual' | 'translation';
// DOM-only presentation: no model calls, native player writes or automatic
// ownership. The caller renews a verified display lease after successful render.
export class CaptionOverlay {
  readonly owner = crypto.randomUUID();
  readonly host: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private signature = '';
  private readonly lines = new Map<
    string,
    { line: HTMLElement; original: string; translated: HTMLElement }
  >();
  private disposed = false;
  constructor(
    readonly player: HTMLElement,
    readonly video: HTMLVideoElement,
    private readonly lookup?: {
      language: string;
      open(text: string, anchor: DOMRect, focus: HTMLElement): void;
    },
  ) {
    this.host = document.createElement('div');
    this.host.setAttribute(OVERLAY_ATTRIBUTE, this.owner);
    this.host.hidden = true;
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent =
      ':host{all:initial;position:absolute;left:5%;right:5%;bottom:var(--sayvia-caption-bottom,64px);z-index:60;pointer-events:none;display:flex;justify-content:center;color:#fff;font:var(--sayvia-caption-size,22px)/1.45 system-ui;text-align:center}:host([hidden]){display:none}.lines{max-width:100%;display:flex;flex-direction:column;gap:4px}.row{border-radius:5px;background:#000c;padding:3px 10px;overflow-wrap:anywhere;white-space:pre-line;text-shadow:0 1px 2px #000}.original{font-size:.9em}.translation{font-weight:600}.pending{font-size:.7em;color:#ddd}';
    this.body = document.createElement('div');
    this.body.className = 'lines';
    style.textContent +=
      '.word{all:unset;cursor:pointer;pointer-events:auto;border-radius:2px}.word:hover{background:#ffffff30}.word:focus-visible{outline:2px solid #a8d6ff;outline-offset:2px}';
    this.body.setAttribute('aria-label', 'Sayvia 双语字幕');
    shadow.append(style, this.body);
    player.append(this.host);
  }
  appearance(size: number, bottom: number) {
    this.host.style.setProperty(
      '--sayvia-caption-size',
      `${Math.min(48, Math.max(14, Number.isFinite(size) ? size : 22))}px`,
    );
    this.host.style.setProperty(
      '--sayvia-caption-bottom',
      `${Math.min(200, Math.max(16, Number.isFinite(bottom) ? bottom : 64))}px`,
    );
  }
  render(rows: readonly CaptionDisplayRow[], mode: CaptionDisplayMode): boolean {
    if (this.disposed) return false;
    if (
      !this.host.isConnected ||
      !this.player.isConnected ||
      this.player.querySelector('video') !== this.video ||
      !compatibleDisplay(document, this.player, this.host, this.video) ||
      !rows.length ||
      rows.length > 8 ||
      rows.reduce((n, row) => n + row.original.length + (row.translation?.length ?? 0), 0) >
        16_000 ||
      (mode === 'translation' && rows.some((row) => !row.translation))
    ) {
      this.clear();
      return false;
    }
    const signature = JSON.stringify([mode, rows]);
    if (signature !== this.signature) {
      this.signature = signature;
      const keep = new Set(rows.map((row) => row.unitId));
      for (const [id, nodes] of this.lines)
        if (!keep.has(id)) {
          nodes.line.remove();
          this.lines.delete(id);
        }
      let index = 0;
      for (const row of rows) {
        let nodes = this.lines.get(row.unitId);
        const originalSignature = JSON.stringify([mode, row.original]);
        if (!nodes || nodes.original !== originalSignature) {
          nodes?.line.remove();
          const line = document.createElement('div');
          line.className = 'row';
          if (mode === 'bilingual') {
            const original = document.createElement('div');
            original.className = 'original';
            original.dir = 'auto';
            if (this.lookup) {
              original.lang = this.lookup.language;
              for (const part of captionWords(row.original, this.lookup.language)) {
                if (!part.lookup) {
                  original.append(document.createTextNode(part.text));
                  continue;
                }
                const word = document.createElement('button');
                word.type = 'button';
                word.className = 'word';
                word.textContent = part.text;
                word.setAttribute('aria-label', `查词：${part.text}`);
                word.addEventListener('keydown', (event) => event.stopPropagation());
                word.addEventListener('keyup', (event) => event.stopPropagation());
                word.addEventListener('click', (event) => {
                  event.stopPropagation();
                  if (event.isTrusted && word.isConnected && !this.host.hidden && !this.disposed)
                    this.lookup?.open(part.text, word.getBoundingClientRect(), word);
                });
                original.append(word);
              }
            } else original.textContent = row.original;
            line.append(original);
          }
          const translated = document.createElement('div');
          line.append(translated);
          nodes = { line, original: originalSignature, translated };
          this.lines.set(row.unitId, nodes);
        }
        const { line, translated } = nodes;
        translated.className = row.translation ? 'translation' : 'pending';
        translated.textContent = row.translation ?? '翻译中…';
        const position = this.body.children[index++] ?? null;
        if (line !== position) this.body.insertBefore(line, position);
      }
    }
    this.host.hidden = false;
    this.host.setAttribute(READY_ATTRIBUTE, 'true');
    if (!visibleCaptionBounds(window, this.player, this.video, this.host)) {
      this.clear();
      return false;
    }
    return true;
  }
  clear() {
    restoreNativeCaptions(this.player, this.owner);
    this.host.removeAttribute(READY_ATTRIBUTE);
    this.host.hidden = true;
    this.body.replaceChildren();
    this.lines.clear();
    this.signature = '';
  }
  dispose() {
    this.clear();
    this.disposed = true;
    this.host.remove();
  }
}
