import { captureDomRange } from './dom-selection';
import { readingMarkdown } from './reading-markdown';
import { markdownTextIntervals } from '../core/markdown';
import { createTranslationPlan, protectedTokens } from '../core/translation-plan';
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
  let contextStartLine = 0;
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
      if (started) {
        if (selectedEnd !== undefined) break;
        throw new SourceError('UNSUPPORTED_SELECTION');
      }
      context = '';
      contextLines = 0;
    }
    previous = line;
    const full = fullRange(inner);
    const raw = text(full);
    if (!contextLines) contextStartLine = line;
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
    }
  }
  if (selectedStart === undefined || selectedEnd === undefined || selectedEnd <= selectedStart) {
    throw new SourceError('EMPTY_SOURCE');
  }
  const selectedText = context.slice(selectedStart, selectedEnd);
  // A bare first fence in a partial hunk can be a closing fence whose opener
  // was omitted by GitHub. Do not guess its direction and expose code as prose.
  const firstFence = /^(?:[ \t]*>[ \t]?)* {0,3}(`{3,}|~{3,})([^\r\n]*)$/m.exec(context);
  if (contextStartLine > 1 && firstFence && !firstFence[2]!.trim()) {
    return {
      plainText: selectedText,
      source: readingMarkdown(
        {
          kind: 'dom-selection',
          text: selectedText,
          protectedRanges: [{ start: 0, end: selectedText.length, kind: 'inline-code' }],
          marks: [],
        },
        [],
      ),
    };
  }
  let cursor = selectedStart;
  let output = '';
  const markdown = markdownTextIntervals(context);
  const protectedContext: { start: number; end: number }[] = [];
  let eligibleEnd = 0;
  for (const eligible of markdown.eligible) {
    if (eligible.start > eligibleEnd)
      protectedContext.push({ start: eligibleEnd, end: eligible.start });
    eligibleEnd = Math.max(eligibleEnd, eligible.end);
  }
  if (eligibleEnd < context.length)
    protectedContext.push({ start: eligibleEnd, end: context.length });
  protectedContext.push(...markdown.html, ...markdown.linePrefixes);
  for (const eligible of markdown.eligible) {
    protectedContext.push(
      ...protectedTokens(context.slice(eligible.start, eligible.end), true).map((span) => ({
        start: span.start + eligible.start,
        end: span.end + eligible.start,
      })),
    );
  }
  const merged: { start: number; end: number }[] = [];
  for (const span of protectedContext.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  const selectedParts = createTranslationPlan({
    kind: 'markdown',
    text: context.slice(selectedStart, selectedEnd),
  }).parts;
  for (const opaque of merged) {
    const from = Math.max(selectedStart, opaque.start);
    const to = Math.min(selectedEnd, opaque.end);
    const clipped = opaque.start < selectedStart || opaque.end > selectedEnd;
    if (
      from >= to ||
      (!clipped &&
        !selectedParts.some(
          (part) =>
            part.kind === 'text' &&
            part.start + selectedStart < to &&
            part.end + selectedStart > from,
        ))
    )
      continue;
    // A clipped closing delimiter can otherwise look like a new opener and
    // swallow genuine prose below it, even when standalone parsing has no text.
    if (!context.slice(from, to).trim()) continue;
    output += context.slice(cursor, from);
    const piece = context.slice(from, to);
    // A selection may start inside code, HTML or a Markdown link destination.
    // Re-establish its code identity without copying any unselected characters.
    const protectedPiece = readingMarkdown(
      {
        kind: 'dom-selection',
        text: piece,
        protectedRanges: [{ start: 0, end: piece.length, kind: 'inline-code' }],
        marks: [],
      },
      [],
    ).text;
    output += /[\r\n]/.test(piece) ? `\n\n${protectedPiece}\n\n` : protectedPiece;
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
