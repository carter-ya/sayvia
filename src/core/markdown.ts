import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent } from 'mdast';
import type { Node } from 'unist';
import { PlanError, type Interval, type FormatBoundary } from './plan-types';

const parser = unified().use(remarkParse).use(remarkGfm);
const VOID_TAG = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;
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
  const html: Interval[] = [];
  const boundaries: FormatBoundary[] = [];
  const scopes: Interval[] = [];
  const opaque: Interval[] = [];
  let visited = 0;
  const walk = (node: TreeNode, base: number, depth: number) => {
    if (++visited > 4096 || depth > 128) throw new PlanError('PLAN_TOO_COMPLEX');
    const span = interval(node, base);
    if (node.type === 'text') eligible.push(span);
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
      walk(parseMarkdown(text.slice(start, end)), start, depth + 1);
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
    const opened: { tag: string; start: number }[] = [];
    for (const child of node.children) {
      if (child.type === 'html') {
        const childSpan = interval(child, base);
        const token = /^<\s*(\/?)\s*([a-z][\w:-]*)\b[^>]*>$/i.exec(child.value);
        html.push(childSpan);
        if (token && !VOID_TAG.test(token[2]!) && !/\/\s*>$/.test(child.value)) {
          const tag = token[2]!.toLowerCase();
          if (!token[1]) opened.push({ tag, start: childSpan.start });
          else {
            const index = opened.findLastIndex((entry) => entry.tag === tag);
            if (index >= 0) {
              html.push({ start: opened[index]!.start, end: childSpan.end });
              opened.splice(index);
            }
          }
        }
      }
      walk(child, base, depth + 1);
    }
    for (const entry of opened) html.push({ start: entry.start, end: span.end });
  };
  const tree = parseMarkdown(text);
  walk(tree, 0, 0);
  return {
    eligible,
    html,
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
