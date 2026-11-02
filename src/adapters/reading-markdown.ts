import { parseMarkdown } from '../core/markdown';
import { safeWebLink } from '../core/safe-link';
import { parseSourceInput, type DomSource } from '../core/source-input';

export interface ReadingLink {
  start: number;
  end: number;
  href: string;
}

function literal(text: string, lineStart: boolean) {
  const escaped = text
    .replace(/[\\`*[\]<>|~&]/g, '\\$&')
    .replace(/(?<![\p{L}\p{N}])_/gu, '\\_')
    .replace(/(^|\n)([ \t]*)([#=+-])(?=\s)/g, '$1$2\\$3')
    .replace(/(^|\n)([ \t]*\d+)([.)])(?=\s)/g, '$1$2\\$3');
  return lineStart
    ? escaped.replace(/^[ \t]+/, (indentation) =>
        [...indentation].map((character) => (character === '\t' ? '&#9;' : '&#32;')).join(''),
      )
    : escaped;
}
function prose(text: string, lineStart: boolean, allowUrls: boolean) {
  if (!allowUrls) return literal(text, lineStart);
  let output = '';
  let cursor = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>，。；！？、（）【】《》「」]+/gi)) {
    const candidate = match[0];
    const paragraph = parseMarkdown(candidate).children[0];
    const first = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined;
    // GFM already distinguishes terminal punctuation and balanced parentheses.
    let length =
      first?.type === 'link' && first.position?.start.offset === 0
        ? (first.position.end.offset ?? candidate.length)
        : candidate.length;
    // A visible URL is literal DOM text, so entity-looking query values are not HTML.
    for (;;) {
      const entity = /^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]*);/.exec(
        candidate.slice(length),
      );
      if (!entity) break;
      length += entity[0].length;
    }
    const url = candidate.slice(0, length);
    if (!safeWebLink(url)) continue;
    output += literal(text.slice(cursor, match.index), lineStart && cursor === 0);
    output += `<${url}>`;
    cursor = match.index + length;
  }
  return output + literal(text.slice(cursor), lineStart && cursor === 0);
}

function code(text: string, block: boolean) {
  block ||= /[\r\n]/.test(text);
  const fence = '`'.repeat(
    Math.max(block ? 3 : 1, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)),
  );
  if (block) return `\n\n${fence}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
  const pad = /^[ `]|[ `]$/.test(text) && !/^ +$/.test(text) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

// Serialize selected, visibility-filtered text and local semantic intervals only.
// Neither page HTML nor unselected link labels are copied into the source.
export function readingMarkdown(source: DomSource, links: readonly ReadingLink[]): DomSource {
  const paragraphEnds = new Set(
    source.marks.filter((mark) => mark.kind === 'paragraph').map((mark) => mark.end),
  );
  const codes = source.protectedRanges.filter(
    (span) => span.kind === 'inline-code' || span.kind === 'code-block',
  );
  const codeAt = new Map(codes.map((span) => [span.start, span]));
  // Markdown links cannot contain block code or cross paragraph boundaries.
  // Keep code opaque and preserve the target on the remaining inline pieces.
  const inlineLinks: ReadingLink[] = [];
  const addLines = (start: number, end: number, href: string) => {
    while (start < end) {
      const newline = source.text.indexOf('\n', start);
      const stop = newline < 0 ? end : Math.min(newline, end);
      if (source.text.slice(start, stop).trim()) inlineLinks.push({ start, end: stop, href });
      start = stop + 1;
    }
  };
  for (const link of links) {
    let cursor = link.start;
    for (const span of codes) {
      if (
        span.end <= cursor ||
        span.start >= link.end ||
        (span.kind !== 'code-block' && !/[\r\n]/.test(source.text.slice(span.start, span.end)))
      )
        continue;
      addLines(cursor, Math.min(span.start, link.end), link.href);
      cursor = Math.max(cursor, span.end);
    }
    addLines(cursor, link.end, link.href);
  }
  const linkAt = new Map(inlineLinks.map((span) => [span.start, span]));
  const render = (start: number, end: number, inLink = false): string => {
    let output = '';
    let cursor = start;
    while (cursor < end) {
      const protectedCode = codeAt.get(cursor);
      const link = !inLink && linkAt.get(cursor);
      if (link && (!protectedCode || link.end >= protectedCode.end)) {
        const label = source.text.slice(cursor, link.end);
        // A visible URL stays opaque, rather than becoming translatable label text.
        output +=
          label === link.href && !protectedCode
            ? `<${link.href}>`
            : `[${render(cursor, link.end, true)}](<${link.href.replace(/\\/g, '\\\\').replace(/&/g, '&amp;').replace(/</g, '%3C').replace(/>/g, '%3E')}>)`;
        cursor = link.end;
        continue;
      }
      if (protectedCode) {
        output += code(
          source.text.slice(cursor, protectedCode.end),
          protectedCode.kind === 'code-block',
        );
        cursor = protectedCode.end;
        continue;
      }
      if (source.text[cursor] === '\n') {
        let next = cursor + 1;
        while (next < end && source.text[next] === '\n') next++;
        output +=
          next - cursor > 1
            ? '\n'.repeat(next - cursor)
            : paragraphEnds.has(cursor)
              ? '\n\n'
              : '  \n';
        cursor = next;
        continue;
      }
      let next = cursor + 1;
      while (
        next < end &&
        source.text[next] !== '\n' &&
        !codeAt.has(next) &&
        (inLink || !linkAt.has(next))
      )
        next++;
      output += prose(
        source.text.slice(cursor, next),
        output === '' ? cursor === 0 || source.text[cursor - 1] === '\n' : output.endsWith('\n'),
        !inLink,
      );
      cursor = next;
    }
    return output;
  };
  const text = render(0, source.text.length).replace(/^\n+|\n+$/g, '');
  const result = parseSourceInput({
    kind: 'dom-selection',
    format: 'markdown',
    text,
    protectedRanges: [],
    marks: [],
  });
  if (result.kind !== 'dom-selection') throw Error('INVALID_SOURCE');
  return result;
}
