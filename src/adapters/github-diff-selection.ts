import { captureDomRange } from './dom-selection';
import { readingMarkdown } from './reading-markdown';
import { markdownTextIntervals } from '../core/markdown';
import { createTranslationPlan, needsTranslation, protectedTokens } from '../core/translation-plan';
import { parseSourceInput, SourceError, type DomSource } from '../core/source-input';

const INNER = 'td > code.diff-text > .diff-text-inner';

// PR and commit diffs expose different metadata. Both identify a source side
// and line; never infer it from the visual column or DOM order.
function cellInfo(inner: Element, table: Element) {
  const cell = inner.parentElement!.parentElement!;
  if (cell.closest('table') !== table) return;
  const side = cell.getAttribute('data-diff-side');
  const line = cell.getAttribute('data-line-number');
  const anchor = cell.getAttribute('data-line-anchor');
  const prefix = table.getAttribute('data-diff-anchor')!;
  const match = anchor?.startsWith(prefix)
    ? /^([LR])([1-9]\d*)$/.exec(anchor.slice(prefix.length))
    : undefined;
  const anchored = match
    ? { side: match[1] === 'L' ? 'left' : 'right', line: Number(match[2]) }
    : undefined;
  if (side !== null || line !== null) {
    if (!side || !/^(left|right)$/.test(side) || !line || !/^[1-9]\d*$/.test(line)) return;
    const result = { side, line: Number(line) };
    if (anchor && (!anchored || anchored.side !== side || anchored.line !== result.line)) return;
    return Number.isSafeInteger(result.line) ? result : undefined;
  }
  return anchored && Number.isSafeInteger(anchored.line) ? anchored : undefined;
}
const MAX_CONTEXT = 64_000;
const MAX_ROWS = 4096;

function parent(node: Node) {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

// The Markdown highlighter emits paired delimiter/body/delimiter spans for
// inline code. A bare code fence followed by these visible prose tokens is a
// closing fence; an unlabelled opening fence would highlight its body as raw code.
function hasMarkdownProse(inner: Element, document: Document) {
  for (const open of inner.querySelectorAll('.pl-s')) {
    const delimiter = open.textContent ?? '';
    if (!/^`+$/.test(delimiter) || open.closest('.pl-c1, .pl-c')) continue;
    const body = open.nextElementSibling;
    const close = body?.nextElementSibling;
    if (
      !body?.classList.contains('pl-c1') ||
      !close?.classList.contains('pl-s') ||
      close.textContent !== delimiter
    )
      continue;
    const range = document.createRange();
    range.setStartBefore(open);
    range.setEndAfter(close);
    try {
      if (captureDomRange(range, document).text === delimiter + body.textContent + delimiter)
        return true;
    } catch {
      /* Hidden or unsupported markup cannot establish prose context. */
    }
  }
  return false;
}

// The baseline is selected visible text, not a filename/language allowlist.
// Only selected rows of the selected side are read; controls and opposite cells
// never become source. Markdown context is an optional enhancement below.
export function captureGithubDiff(
  range: Range,
  document: Document,
): { source: DomSource; plainText: string } | undefined {
  if (new URL(document.URL).hostname !== 'github.com') return;
  const start = parent(range.startContainer)?.closest(INNER);
  const end = parent(range.endContainer)?.closest(INNER);
  if (!start || !end) return;
  const table = start.closest('table[role="grid"][data-diff-anchor]');
  if (!table || end.closest('table') !== table) throw new SourceError('UNSUPPORTED_SELECTION');
  const first = cellInfo(start, table),
    last = cellInfo(end, table);
  if (!first || !last || first.side !== last.side) throw new SourceError('UNSUPPORTED_SELECTION');
  const startRow = start.closest('tr')!,
    endRow = end.closest('tr')!;
  if (startRow.parentElement !== endRow.parentElement)
    throw new SourceError('UNSUPPORTED_SELECTION');
  const lines: string[] = [];
  let visited = 0,
    found = false;
  for (let row: Element | null = startRow; row; row = row.nextElementSibling) {
    if (++visited > MAX_ROWS) throw new SourceError('SELECTION_TOO_COMPLEX');
    const candidates = [...row.querySelectorAll(INNER)].filter(
      (node) => node.closest('table') === table,
    );
    if (candidates.some((node) => !cellInfo(node, table)))
      throw new SourceError('UNSUPPORTED_SELECTION');
    const inner = candidates.find((node) => cellInfo(node, table)?.side === first.side);
    if (inner) {
      const clipped = document.createRange();
      clipped.selectNodeContents(inner);
      if (inner === start) clipped.setStart(range.startContainer, range.startOffset);
      if (inner === end) clipped.setEnd(range.endContainer, range.endOffset);
      try {
        lines.push(captureDomRange(clipped, document).text);
      } catch (error) {
        if (error instanceof SourceError && error.code === 'EMPTY_SOURCE') lines.push('');
        else throw error;
      }
    }
    if (row === endRow) {
      found = true;
      break;
    }
  }
  if (!found) throw new SourceError('UNSUPPORTED_SELECTION');
  const plainText = lines.join('\n');
  const source = readingMarkdown(
    { kind: 'dom-selection', text: plainText, protectedRanges: [], marks: [] },
    [],
  );
  const baseline = { source, plainText };
  // A recognized format may preserve inline markup and destinations. Failure
  // or excessive surrounding context must not remove the baseline capability.
  if (!/^Diff for: .+\.(?:md|markdown|mdown)$/i.test(table.getAttribute('aria-label') ?? ''))
    return baseline;
  try {
    const enhanced = captureGithubMarkdownDiff(range, document);
    if (!enhanced || enhanced.plainText !== baseline.plainText) return baseline;
    if (enhanced.codeContainer && !needsTranslation(createTranslationPlan(enhanced.source)))
      return baseline;
    return enhanced;
  } catch {
    return baseline;
  }
}

// GitHub's source diff wraps Markdown prose in <code> as well as real code.
// Interpret that wrapper only inside a named Markdown diff on github.com.
function captureGithubMarkdownDiff(
  range: Range,
  document: Document,
): { source: DomSource; plainText: string; codeContainer?: boolean } | undefined {
  const url = new URL(document.URL);
  if (url.hostname !== 'github.com') return;
  const start = parent(range.startContainer)?.closest(INNER);
  const end = parent(range.endContainer)?.closest(INNER);
  if (!start || !end) return;
  const table = start.closest('table[role="grid"][data-diff-anchor]');
  if (!table || end.closest('table') !== table) return;
  const label = table.getAttribute('aria-label') ?? '';
  if (!/^Diff for: .+\.(?:md|markdown|mdown)$/i.test(label)) return;
  const first = cellInfo(start, table);
  const last = cellInfo(end, table);
  if (!first || !last || first.side !== last.side) throw new SourceError('UNSUPPORTED_SELECTION');
  const side = first.side;

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
  const proseHints: number[] = [];
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
      (node) => cellInfo(node, table)?.side === side,
    );
    if (!inner) continue;
    const line = cellInfo(inner, table)!.line;
    if (!Number.isSafeInteger(line) || line < 1) throw new SourceError('UNSUPPORTED_SELECTION');
    if (previous && line !== previous + 1) {
      if (started) {
        if (selectedEnd !== undefined) break;
        throw new SourceError('UNSUPPORTED_SELECTION');
      }
      context = '';
      contextLines = 0;
      proseHints.length = 0;
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
    if (hasMarkdownProse(inner, document)) proseHints.push(context.length);
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
  let markdownOffset = 0;
  if (contextStartLine > 1 && firstFence && !firstFence[2]!.trim()) {
    const fenceEnd = firstFence.index + firstFence[0].length;
    const followingFence = /^(?:[ \t]*>[ \t]?)* {0,3}(`{3,}|~{3,})([^\r\n]*)$/m.exec(
      context.slice(fenceEnd + 1),
    );
    const proofEnd = followingFence ? fenceEnd + 1 + followingFence.index : context.length;
    if (proseHints.some((offset) => offset > fenceEnd && offset < proofEnd))
      markdownOffset = fenceEnd;
    else {
      return {
        codeContainer: true,
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
  }
  const edits: { start: number; end: number; text: string }[] = [];
  const parsed = markdownTextIntervals(context.slice(markdownOffset));
  const shifted = (spans: { start: number; end: number }[]) =>
    spans.map((span) => ({ start: span.start + markdownOffset, end: span.end + markdownOffset }));
  const markdown = {
    eligible: shifted(parsed.eligible),
    html: shifted(parsed.html),
    linePrefixes: shifted(parsed.linePrefixes),
    opaque: shifted(parsed.opaque),
  };
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
    const clipped = [...markdown.opaque, ...markdown.html, { start: 0, end: markdownOffset }].some(
      (span) =>
        span.start < to &&
        span.end > from &&
        (span.start < selectedStart || span.end > selectedEnd),
    );
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
    edits.push({
      start: from,
      end: to,
      text: /[\r\n]/.test(piece) ? `\n\n${protectedPiece}\n\n` : protectedPiece,
    });
  }
  // Leading list-continuation indentation is prose in the full context, but
  // can create an indented code block when its list marker is outside the Range.
  for (const match of selectedText.matchAll(/^[ \t]+/gm)) {
    const start = selectedStart + match.index;
    const end = start + match[0].length;
    const lineEnd = context.indexOf('\n', end);
    const limit = Math.min(selectedEnd, lineEnd < 0 ? context.length : lineEnd);
    const lostProse = markdown.eligible.some((eligible) => {
      let cursor = Math.max(end, eligible.start);
      const stop = Math.min(limit, eligible.end);
      if (cursor >= stop) return false;
      for (const protectedSpan of merged) {
        if (protectedSpan.end <= cursor) continue;
        if (protectedSpan.start >= stop) break;
        if (
          protectedSpan.start > cursor &&
          context.slice(cursor, Math.min(stop, protectedSpan.start)).trim() &&
          !selectedParts.some(
            (part) =>
              part.kind === 'text' &&
              part.start + selectedStart < Math.min(stop, protectedSpan.start) &&
              part.end + selectedStart > cursor,
          )
        )
          return true;
        cursor = Math.min(stop, Math.max(cursor, protectedSpan.end));
      }
      return (
        cursor < stop &&
        Boolean(context.slice(cursor, stop).trim()) &&
        !selectedParts.some(
          (part) =>
            part.kind === 'text' &&
            part.start + selectedStart < stop &&
            part.end + selectedStart > cursor,
        )
      );
    });
    if (lostProse && !edits.some((edit) => edit.start < end && edit.end > start)) {
      edits.push({
        start,
        end,
        text: [...match[0]].map((c) => (c === '\t' ? '&#9;' : '&#32;')).join(''),
      });
    }
  }
  let cursor = selectedStart;
  let output = '';
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    output += context.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  output += context.slice(cursor, selectedEnd);
  return {
    codeContainer: parsed.codeBlocks.some(
      (span) =>
        span.start + markdownOffset < selectedEnd! && span.end + markdownOffset > selectedStart!,
    ),
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
