import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent } from 'mdast';
import type { Node } from 'unist';
import { PlanError, type Interval, type FormatBoundary } from './plan-types';
import { htmlProtection, type HtmlContext } from './html-protection';

const parser = unified().use(remarkParse).use(remarkGfm);
type TreeNode = Root | RootContent;

function interval(node: Node, base = 0): Interval {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) throw new PlanError('INVALID_PLAN');
  return { start: start + base, end: end + base };
}

export function parseMarkdown(text: string) {
  return parser.parse(text);
}

// Offset-bearing raw leaves are used instead of decoded mdast text values.
export function markdownTextIntervals(text: string) {
  const eligible: Interval[] = [];
  const linePrefixes = [...text.matchAll(/^[ \t]*(?:>[ \t]*)*/gm)]
    .filter((match) => match[0].length > 0)
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const htmlContexts: HtmlContext[] = [{ start: 0, end: text.length, nodes: [] }];
  const boundaries: FormatBoundary[] = [];
  const scopes: Interval[] = [];
  const opaque: Interval[] = [];
  let visited = 0;
  const walk = (node: TreeNode, base: number, depth: number, context = htmlContexts[0]!) => {
    if (++visited > 4096 || depth > 128) throw new PlanError('PLAN_TOO_COMPLEX');
    const span = interval(node, base);
    if (node.type === 'text') eligible.push(span);
    if (node.type === 'html') context.nodes.push(span);
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html')
      opaque.push(span);
    if (node.type === 'linkReference' || node.type === 'imageReference') {
      // In shorthand references the visible label is also the destination key.
      if (node.referenceType !== 'full') return;
    }
    if (node.type === 'image' || node.type === 'imageReference') {
      const start = span.start + 2;
      let end = start;
      let nesting = 1;
      for (; end < span.end; end += 1) {
        if (text[end] === '\\') end += 1;
        else if (text[end] === '[') nesting += 1;
        else if (text[end] === ']' && --nesting === 0) break;
      }
      if (end >= span.end) throw new PlanError('INVALID_PLAN');
      boundaries.push(
        { start: span.start, end: start, role: 'format-open' },
        { start: end, end: span.end, role: 'format-close' },
      );
      const altContext: HtmlContext = { start, end, nodes: [] };
      htmlContexts.push(altContext);
      walk(parseMarkdown(text.slice(start, end)), start, depth + 1, altContext);
      return;
    }
    if (!('children' in node)) return;
    if (['paragraph', 'heading', 'tableCell'].includes(node.type) && node.children.length) {
      scopes.push({
        start: interval(node.children[0]!, base).start,
        end: interval(node.children.at(-1)!, base).end,
      });
    }
    if (
      ['strong', 'emphasis', 'delete', 'link', 'linkReference'].includes(node.type) &&
      node.children.length
    ) {
      const first = interval(node.children[0]!, base);
      const last = interval(node.children.at(-1)!, base);
      if (first.start > span.start)
        boundaries.push({ start: span.start, end: first.start, role: 'format-open' });
      if (last.end < span.end)
        boundaries.push({ start: last.end, end: span.end, role: 'format-close' });
    }
    for (const child of node.children) walk(child, base, depth + 1, context);
  };
  const tree = parseMarkdown(text);
  walk(tree, 0, 0);
  return {
    eligible,
    linePrefixes,
    html: htmlProtection(text, htmlContexts),
    tree,
    scopes,
    opaque,
    boundaries: boundaries.sort((a, b) => a.start - b.start || a.end - b.end),
  };
}

// Text and image alt may change; every structural/property field must survive.
export function markdownFingerprint(tree: TreeNode): string {
  const shape = (node: TreeNode): unknown => {
    if (node.type === 'text') return undefined;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'position' || key === 'children' || key === 'alt' || key === 'data') continue;
      result[key] = value;
    }
    if ('children' in node) result.children = node.children.map(shape).filter(Boolean);
    return result;
  };
  return JSON.stringify(shape(tree));
}
