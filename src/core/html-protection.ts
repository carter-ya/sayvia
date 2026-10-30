import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { PlanError, type Interval } from './plan-types';

export interface HtmlContext extends Interval {
  nodes: Interval[];
}
const VOID_TAG = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

// Parse only mdast-designated HTML. Other Markdown is blanked without changing
// UTF-16 offsets; HTML-looking code and image-alt subparses cannot close a tag.
export function htmlProtection(text: string, contexts: readonly HtmlContext[]) {
  const ranges: Interval[] = [];
  let visited = 0;
  for (const context of contexts) {
    if (!context.nodes.length) continue;
    const masked = text
      .slice(context.start, context.end)
      .replace(/[^\r\n]/g, ' ')
      .split('');
    for (const node of context.nodes) {
      ranges.push(node);
      for (let index = node.start; index < node.end; index += 1)
        masked[index - context.start] = text[index]!;
    }
    const fragment = parseFragment(masked.join(''), { sourceCodeLocationInfo: true });
    const recognized = new Set<number>();
    const pending: DefaultTreeAdapterMap['node'][] = [fragment];
    while (pending.length) {
      const node = pending.pop()!;
      if (++visited > 4096) throw new PlanError('PLAN_TOO_COMPLEX');
      if ('tagName' in node) {
        const location = node.sourceCodeLocation;
        if (location?.startTag) {
          const start = location.startTag.startOffset + context.start;
          recognized.add(start);
          const unclosed =
            node.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
            !VOID_TAG.test(node.tagName) &&
            !location.endTag;
          ranges.push({ start, end: unclosed ? context.end : location.endOffset + context.start });
        }
      }
      if ('childNodes' in node) pending.push(...node.childNodes);
    }
    // Invalid-context HTML may be dropped by the HTML parser. Keep the rest of
    // that input local rather than guessing where an unrecognized element ends.
    for (const node of context.nodes) {
      const value = text.slice(node.start, node.end);
      const opening = /^\s*<([a-z][\w:-]*)(?=[\s/>])/i.exec(value);
      if (
        opening &&
        !VOID_TAG.test(opening[1]!) &&
        !recognized.has(node.start + value.indexOf('<'))
      ) {
        ranges.push({ start: node.start, end: context.end });
      }
    }
  }
  return ranges;
}
