import { captureDomRange } from './dom-selection';
import { readingMarkdown } from './reading-markdown';
import { markdownTextIntervals } from '../core/markdown';
import { parseSourceInput, SourceError, type DomSource } from '../core/source-input';

const INNER = 'td[data-diff-side][data-line-number] > code.diff-text > .diff-text-inner';
const MAX_CONTEXT = 64_000;
const MAX_ROWS = 4096;

function parent(node: Node) {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

// GitHub's source diff wraps Markdown prose in <code> as well as real code.
// Interpret that wrapper only inside a named Markdown diff on github.com.
export function captureGithubMarkdownDiff(
  range: Range,
  document: Document,
): { source: DomSource; plainText: string } | undefined {
  const url = new URL(document.URL);
  if (
    url.hostname !== 'github.com' ||
    !/^\/[^/]+\/[^/]+\/pull\/\d+\/(?:changes|files)(?:\/|$)/.test(url.pathname)
  )
    return;
  const start = parent(range.startContainer)?.closest(INNER);
  const end = parent(range.endContainer)?.closest(INNER);
  if (!start || !end) return;
  const table = start.closest('table[role="grid"][data-diff-anchor]');
  if (!table || end.closest('table') !== table) return;
  const label = table.getAttribute('aria-label') ?? '';
  if (!/^Diff for: .+\.(?:md|markdown|mdown)$/i.test(label)) return;
  const startCell = start.parentElement!.parentElement!;
  const side = startCell.getAttribute('data-diff-side');
  if (end.parentElement!.parentElement!.getAttribute('data-diff-side') !== side) {
    throw new SourceError('UNSUPPORTED_SELECTION');
  }

  const fullRange = (element: Element) => {
    const full = document.createRange();
    full.selectNodeContents(element);
    return full;
  };
  const text = (r: Range) => {
    if (r.collapsed) return '';
    // The sole <br> stands for an empty source line, not an extra newline.
    const root = parent(r.commonAncestorContainer);
    if (
      root?.matches('.diff-text-inner') &&
      root.childNodes.length === 1 &&
      root.firstElementChild?.tagName === 'BR'
    )
      return '';
    try {
      return captureDomRange(r, document).text;
    } catch (error) {
      if (error instanceof SourceError && error.code === 'EMPTY_SOURCE') return '';
      throw error;
    }
  };
  let context = '';
  let contextLines = 0;
  let selectedStart: number | undefined;
  let selectedEnd: number | undefined;
  let previous = 0;
  let visited = 0;
  let started = false;
  // Only the contiguous, already-rendered hunk provides local Markdown context.
  // It never becomes the request source; the native Range is clipped below.
  for (const row of table.querySelectorAll('tbody > tr')) {
    if (++visited > MAX_ROWS) throw new SourceError('SELECTION_TOO_COMPLEX');
    const inner = [...row.querySelectorAll(INNER)].find(
      (node) => node.parentElement!.parentElement!.getAttribute('data-diff-side') === side,
    );
    if (!inner) continue;
    const cell = inner.parentElement!.parentElement!;
    const line = Number(cell.getAttribute('data-line-number'));
    if (!Number.isSafeInteger(line) || line < 1) throw new SourceError('UNSUPPORTED_SELECTION');
    if (previous && line !== previous + 1) {
      if (started) throw new SourceError('UNSUPPORTED_SELECTION');
      context = '';
      contextLines = 0;
    }
    previous = line;
    const full = fullRange(inner);
    const raw = text(full);
    if (contextLines++) context += '\n';
    if (inner === start) {
      started = true;
      const prefix = full.cloneRange();
      prefix.setEnd(range.startContainer, range.startOffset);
      selectedStart = context.length + text(prefix).length;
    }
    context += raw;
    if (context.length > MAX_CONTEXT) throw new SourceError('SELECTION_TOO_COMPLEX');
    if (inner === end) {
      const prefix = full.cloneRange();
      prefix.setEnd(range.endContainer, range.endOffset);
      selectedEnd = context.length - raw.length + text(prefix).length;
      break;
    }
  }
  if (selectedStart === undefined || selectedEnd === undefined || selectedEnd <= selectedStart) {
    throw new SourceError('EMPTY_SOURCE');
  }
  let cursor = selectedStart;
  let output = '';
  for (const opaque of markdownTextIntervals(context).opaque) {
    const from = Math.max(selectedStart, opaque.start);
    const to = Math.min(selectedEnd, opaque.end);
    if (from >= to || (opaque.start >= selectedStart && opaque.end <= selectedEnd)) continue;
    output += context.slice(cursor, from);
    const piece = context.slice(from, to);
    // A selection may start inside a code span or a fence opened before it.
    // Re-establish its code identity without copying any unselected characters.
    output += readingMarkdown(
      {
        kind: 'dom-selection',
        text: piece,
        protectedRanges: [{ start: 0, end: piece.length, kind: 'inline-code' }],
        marks: [],
      },
      [],
    ).text;
    cursor = to;
  }
  output += context.slice(cursor, selectedEnd);
  return {
    plainText: context.slice(selectedStart, selectedEnd),
    source: parseSourceInput({
      kind: 'dom-selection',
      format: 'markdown',
      text: output,
      protectedRanges: [],
      marks: [],
    }) as DomSource,
  };
}
