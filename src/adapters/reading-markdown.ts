import { parseSourceInput, type DomSource } from '../core/source-input';

export interface ReadingLink {
  start: number;
  end: number;
  href: string;
}

function literal(text: string) {
  return text
    .replace(/[\\`*[\]<>|~]/g, '\\$&')
    .replace(/(?<![\p{L}\p{N}])_/gu, '\\_')
    .replace(/(^|\n)([ \t]*)([#=+-])(?=\s)/g, '$1$2\\$3')
    .replace(/(^|\n)([ \t]*\d+)([.)])(?=\s)/g, '$1$2\\$3');
}
function code(text: string, block: boolean) {
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
  const linkAt = new Map(links.map((span) => [span.start, span]));
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
            : `[${render(cursor, link.end, true)}](<${link.href.replace(/</g, '%3C').replace(/>/g, '%3E')}>)`;
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
      // Preserve visible bare addresses without escaping them into model prose.
      const address =
        !inLink &&
        /^(?:https?:\/\/)[^\s<>，。；！？、（）【】《》「」]+/.exec(source.text.slice(cursor, end));
      if (address) {
        output += `<${address[0]}>`;
        cursor += address[0].length;
        continue;
      }
      let next = cursor + 1;
      while (
        next < end &&
        source.text[next] !== '\n' &&
        !codeAt.has(next) &&
        (inLink || !linkAt.has(next)) &&
        !source.text.startsWith('https://', next) &&
        !source.text.startsWith('http://', next)
      )
        next++;
      output += literal(source.text.slice(cursor, next));
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
