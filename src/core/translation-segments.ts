import { MAX_SOURCE_SPANS } from './source-input';
import {
  PlanError,
  type FormatBoundary,
  type Interval,
  type PlanPart,
  type TranslationSegment,
  type ProtectedToken,
} from './plan-types';

// Keep whole lines together so the model controls word order and spacing around
// inline formats. Newlines and block boundaries remain exact local source slices.
export function buildTranslationSegments(
  text: string,
  parts: readonly PlanPart[],
  boundaries: readonly FormatBoundary[],
  scopes: readonly Interval[],
  opaqueRanges: readonly Interval[],
  linePrefixes: readonly Interval[],
) {
  let nonce = 0;
  while (text.includes(`⟦SV${nonce}:`)) nonce += 1;
  const prefix = `⟦SV${nonce}:`;
  const segments: TranslationSegment[] = [];
  const pending: PlanPart[] = [];
  let tokenCount = 0;
  const flush = () => {
    if (!pending.length) return;
    const first = pending[0]!;
    const last = pending.at(-1)!;
    const tokens: ProtectedToken[] = [];
    let template = '';
    const scopeFor = (part: PlanPart) =>
      scopes
        .filter((scope) => scope.start <= part.start && scope.end >= part.end)
        .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    const lineStart =
      Math.max(
        text.lastIndexOf('\n', first.start - 1),
        text.lastIndexOf('\r', first.start - 1),
        text.lastIndexOf('\t', first.start - 1),
      ) + 1;
    const nextBreak = text.slice(last.end).search(/[\r\n\t]/);
    const lineEnd = nextBreak < 0 ? text.length : last.end + nextBreak;
    let start = Math.max(lineStart, scopeFor(first)?.start ?? first.start);
    let end = Math.min(lineEnd, scopeFor(last)?.end ?? last.end);
    for (const prefix of linePrefixes) {
      if (prefix.start <= start && start < prefix.end) start = prefix.end;
    }
    // Never extend a line group into the middle of multiline protected content.
    for (const opaque of opaqueRanges) {
      if (opaque.start < start && start < opaque.end) start = opaque.end;
      if (opaque.start < end && end < opaque.end) end = opaque.start;
    }
    while (start < first.start && text[start] === ' ') start += 1;
    while (end > last.end && text[end - 1] === ' ') end -= 1;
    let cursor = start;
    const protect = (start: number, end: number, role: ProtectedToken['role'] = 'content') => {
      if (end <= start) return;
      if (++tokenCount > MAX_SOURCE_SPANS) throw new PlanError('PLAN_TOO_COMPLEX');
      let value = text.slice(start, end);
      if (role === 'content') {
        const leading = value.match(/^ */)![0];
        const trailing = value.match(/ *$/)![0];
        if (leading.length === value.length) {
          template += value;
          return;
        }
        template += leading;
        start += leading.length;
        end -= trailing.length;
        value = text.slice(start, end);
        const marker = `${prefix}${tokenCount}⟧`;
        tokens.push(
          Object.freeze({
            start,
            end,
            text: value,
            marker,
            role,
            leadingWhitespace: /^\s/.test(value),
            trailingWhitespace: /\s$/.test(value),
          }),
        );
        template += marker + trailing;
        return;
      }
      const marker = `${prefix}${tokenCount}⟧`;
      tokens.push(
        Object.freeze({
          start,
          end,
          text: value,
          marker,
          role: /^\s+$/.test(value) ? 'whitespace' : role,
          leadingWhitespace: /^\s/.test(value),
          trailingWhitespace: /\s$/.test(value),
        }),
      );
      template += marker;
    };
    const gap = (end: number) => {
      let gapCursor = cursor;
      for (const boundary of boundaries) {
        if (boundary.start < cursor || boundary.end > end || boundary.start < gapCursor) continue;
        protect(gapCursor, boundary.start);
        protect(boundary.start, boundary.end, boundary.role);
        gapCursor = boundary.end;
      }
      protect(gapCursor, end);
    };
    for (const part of pending) {
      gap(part.start);
      template += part.text;
      cursor = part.end;
    }
    gap(end);
    segments.push(
      Object.freeze({
        id: `s${segments.length}`,
        start,
        end,
        text: template,
        tokenPrefix: prefix,
        tokens: Object.freeze(tokens),
      }),
    );
    pending.length = 0;
  };
  for (const part of parts) {
    if (part.kind !== 'text') continue;
    const previous = pending.at(-1);
    if (previous && /[\r\n\t]/.test(text.slice(previous.end, part.start))) flush();
    pending.push(part);
  }
  flush();
  return Object.freeze(segments);
}

export function decodeSegment(segment: TranslationSegment, translation: string) {
  const pieces: { text: string; original: string; protected: boolean }[] = [];
  let cursor = 0;
  let templateCursor = 0;
  let remainder = translation;
  for (const token of segment.tokens) {
    const start = translation.indexOf(token.marker, cursor);
    if (start < 0 || translation.indexOf(token.marker, start + token.marker.length) !== -1) {
      throw new PlanError('INVALID_TRANSLATION');
    }
    const originalEnd = segment.text.indexOf(token.marker, templateCursor);
    const original = segment.text.slice(templateCursor, originalEnd);
    pieces.push({ text: translation.slice(cursor, start), original, protected: false });
    pieces.push({ text: token.text, original: token.text, protected: true });
    templateCursor = originalEnd + token.marker.length;
    cursor = start + token.marker.length;
    remainder = remainder.replace(token.marker, '');
  }
  pieces.push({
    text: translation.slice(cursor),
    original: segment.text.slice(templateCursor),
    protected: false,
  });
  if (
    remainder.includes(segment.tokenPrefix) ||
    !pieces.some((piece) => !piece.protected && piece.text.trim())
  ) {
    throw new PlanError('INVALID_TRANSLATION');
  }
  return pieces;
}
