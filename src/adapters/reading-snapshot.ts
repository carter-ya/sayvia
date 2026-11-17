import { CODE_EDITOR } from './detect';
import { captureDomRange } from './dom-selection';
import { markdownFingerprint, parseMarkdown } from '../core/markdown';
import type { ReadingLink } from './reading-markdown';
import type { DomSource } from '../core/source-input';

interface Slice {
  node: Text;
  start: number;
  end: number;
  original: string;
  parent: Node;
}
interface Group {
  slices: Slice[];
  text: string;
  code: Element | null;
}
interface Leaf {
  type: string;
  value: string;
}
interface Tree {
  type: string;
  value?: string;
  children?: Tree[];
}
const unsafe = `button,[role="button"],input,textarea,select,label,summary,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[aria-live],[role="status"],[role="alert"],[data-diff-side],.diff-text,${CODE_EDITOR}`;
const normalized = (text: string) => text.replace(/[\t\r\n\f ]+/g, ' ').trim();
// Plain spans often divide one sentence into several DOM text nodes. Only
// traverse wrappers that do not introduce layout, formatting or interaction.
function neutralSpan(node: Node): node is HTMLSpanElement {
  if (!(node instanceof Element) || node.tagName !== 'SPAN') return false;
  if (
    node.hasAttribute('role') ||
    node.hasAttribute('tabindex') ||
    [...node.attributes].some((a) => a.name.startsWith('aria-') || a.name.startsWith('on'))
  )
    return false;
  const view = node.ownerDocument.defaultView;
  const style = view?.getComputedStyle(node);
  if (style?.display && !['inline', 'contents'].includes(style.display)) return false;
  const parent = node.parentElement && view?.getComputedStyle(node.parentElement);
  return (
    !style ||
    !parent ||
    ![
      'font-weight',
      'font-style',
      'font-size',
      'font-family',
      'text-decoration-line',
      'color',
      'white-space',
      'text-transform',
    ].some((property) => {
      const own = style.getPropertyValue(property),
        inherited = parent.getPropertyValue(property);
      return own && own !== inherited;
    })
  );
}
function adjacentProse(left: Text, right: Text) {
  let node: Node = left;
  for (let steps = 0; steps < 256; steps++) {
    while (!node.nextSibling) {
      const parent = node.parentNode;
      if (!parent || !neutralSpan(parent)) return false;
      node = parent;
      if (++steps >= 256) return false;
    }
    node = node.nextSibling;
    while (neutralSpan(node) && node.firstChild) {
      node = node.firstChild;
      if (++steps >= 256) return false;
    }
    if (node === right) return true;
    // Empty spans and comments have no selected text to map.
    if (node.nodeType !== Node.COMMENT_NODE && !(neutralSpan(node) && !node.firstChild))
      return false;
  }
  return false;
}
function adjacentGroups(groups: Group[]) {
  return groups.every(
    (group) =>
      group.code ||
      group.slices.every(
        (slice, index) => index === 0 || adjacentProse(group.slices[index - 1]!.node, slice.node),
      ),
  );
}
function leaves(tree: Tree): Leaf[] {
  if (['text', 'inlineCode', 'code'].includes(tree.type))
    return tree.type === 'text' && !tree.value?.trim()
      ? []
      : [{ type: tree.type, value: tree.value ?? '' }];
  return (tree.children ?? []).flatMap(leaves);
}

// The wire format stays unchanged. A local, exact leaf-to-node match is required;
// ambiguous formatting falls back to preview instead of guessing text positions.
export type ReadingIssue =
  'unsupported-source' | 'unsafe-content' | 'node-mapping' | 'capture-failed';
export function captureReadingSnapshot(
  range: Range,
  source: DomSource,
  report?: (reason: ReadingIssue) => void,
) {
  if (source.format !== 'markdown') {
    report?.('unsupported-source');
    return;
  }
  try {
    const groups: Group[] = [];
    const guards: Slice[] = [];
    const links = new Map<Element, ReadingLink>();
    const flat = captureDomRange(
      range,
      range.startContainer.ownerDocument!,
      links,
      (node, start, end) => {
        if (node.parentElement?.closest(unsafe)) {
          report?.('unsafe-content');
          throw Error('UNSUPPORTED');
        }
        const slice = { node, start, end, original: node.data, parent: node.parentNode! };
        guards.push(slice);
        const code = node.parentElement?.closest('code') ?? null;
        const previous = groups.at(-1);
        const last = previous?.slices.at(-1);
        if (
          previous &&
          last &&
          (code ? previous.code === code : !previous.code && adjacentProse(last.node, node))
        ) {
          previous.slices.push(slice);
          previous.text += node.data.slice(start, end);
        } else groups.push({ slices: [slice], text: node.data.slice(start, end), code });
      },
    );
    const nonempty = groups.filter((group) => group.text.trim());
    const tree = parseMarkdown(source.text);
    const originalLeaves = leaves(tree);
    if (!nonempty.length || nonempty.length > 512 || nonempty.length !== originalLeaves.length) {
      report?.('node-mapping');
      return;
    }
    if (
      nonempty.some((group, index) => {
        const leaf = originalLeaves[index]!;
        return (
          Boolean(group.code) !== (leaf.type !== 'text') ||
          normalized(group.text) !== normalized(leaf.value)
        );
      })
    ) {
      report?.('node-mapping');
      return;
    }
    const capturedRange = range.cloneRange();
    const signature = JSON.stringify({ flat, links: [...links.values()] });
    return new ReadingSnapshot(
      nonempty,
      guards,
      originalLeaves,
      markdownFingerprint(tree),
      range.startContainer.ownerDocument!,
      () => {
        if (guards.some((slice) => slice.node.parentElement?.closest(unsafe))) return false;
        if (!adjacentGroups(nonempty)) return false;
        const currentLinks = new Map<Element, ReadingLink>();
        const currentFlat = captureDomRange(
          capturedRange,
          capturedRange.startContainer.ownerDocument!,
          currentLinks,
        );
        return (
          JSON.stringify({ flat: currentFlat, links: [...currentLinks.values()] }) === signature
        );
      },
    );
  } catch {
    report?.('capture-failed');
    return;
  }
}

export class ReadingSnapshot {
  private readonly observer: MutationObserver;
  private readonly expected = new Map<Text, string>();
  private readonly ancestors = new Set<Node>();
  private readonly parents = new Set<Node>();
  private readonly listeners = new Set<() => void>();
  private valid = true;
  private readonly url: string;
  private translated = false;
  constructor(
    private readonly groups: Group[],
    private readonly guards: Slice[],
    private readonly originalLeaves: Leaf[],
    private readonly shape: string,
    private readonly document: Document,
    private readonly verifyAppearance: () => boolean,
  ) {
    this.url = document.URL;
    for (const slice of guards) {
      this.expected.set(slice.node, slice.original);
      this.parents.add(slice.parent);
      for (let node: Node | null = slice.node.parentNode; node; node = node.parentNode)
        this.ancestors.add(node);
    }
    this.observer = new MutationObserver((records) => this.inspect(records));
    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  }
  get nodes() {
    return [...this.expected.keys()];
  }
  get showingTranslation() {
    return this.translated;
  }
  get tail() {
    return this.groups.at(-1)!.slices.at(-1)!.node;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private inspect(records: MutationRecord[]) {
    if (!this.valid) return;
    let appearanceValid: boolean | undefined;
    const owned = (node: Node) => node instanceof Element && node.hasAttribute('data-sayvia-ui');
    if (
      records.some((record) => {
        if (record.type === 'characterData') return this.expected.has(record.target as Text);
        if (record.type === 'attributes') {
          if (!this.ancestors.has(record.target)) return false;
          // A ticker's data attribute or a theme class alone does not change the
          // selected prose. Recheck the exact selection before invalidating it.
          if (
            this.translated ||
            ['href', 'contenteditable', 'role', 'aria-live'].includes(record.attributeName ?? '')
          )
            return true;
          try {
            appearanceValid ??= this.verifyAppearance();
            return !appearanceValid;
          } catch {
            return true;
          }
        }
        const changes = [...record.addedNodes, ...record.removedNodes];
        if (changes.length && changes.every(owned)) return false;
        return (
          this.parents.has(record.target) ||
          [...record.removedNodes].some(
            (node) => this.expected.has(node as Text) || this.ancestors.has(node),
          )
        );
      })
    )
      this.invalidate();
  }
  private invalidate() {
    if (!this.valid) return;
    this.valid = false;
    this.observer.disconnect();
    for (const listener of this.listeners) listener();
  }
  isValid() {
    this.inspect(this.observer.takeRecords());
    if (
      this.valid &&
      (this.document.URL !== this.url ||
        !adjacentGroups(this.groups) ||
        this.guards.some(
          (slice) =>
            !slice.node.isConnected ||
            slice.node.parentNode !== slice.parent ||
            slice.node.data !== this.expected.get(slice.node),
        ))
    )
      this.invalidate();
    return this.valid;
  }
  private replacements(candidate: string) {
    const tree = parseMarkdown(candidate),
      values = leaves(tree);
    if (markdownFingerprint(tree) !== this.shape || values.length !== this.groups.length) return;
    const result = new Map<Text, string>();
    for (const [index, group] of this.groups.entries()) {
      const leaf = values[index]!,
        original = this.originalLeaves[index]!;
      if (leaf.type !== original.type || (group.code && leaf.value !== original.value)) return;
      if (group.code) continue;
      if (!leaf.value.trim()) return;
      const leading = !/^\s/.test(original.value) ? group.text.match(/^\s*/u)![0] : '';
      const trailing = !/\s$/.test(original.value) ? group.text.match(/\s*$/u)![0] : '';
      group.slices.forEach((slice, position) => {
        const text = position === 0 ? leading + leaf.value + trailing : '';
        result.set(
          slice.node,
          slice.original.slice(0, slice.start) + text + slice.original.slice(slice.end),
        );
      });
    }
    return result;
  }
  canApply(candidate: string) {
    if (!this.isValid()) return false;
    try {
      return Boolean(this.replacements(candidate));
    } catch {
      return false;
    }
  }
  show(candidate: string | null) {
    if (!this.isValid()) return false;
    let replacements: Map<Text, string> | undefined;
    try {
      replacements =
        candidate === null
          ? new Map(
              this.groups.flatMap((group) =>
                group.slices.map((slice) => [slice.node, slice.original] as const),
              ),
            )
          : this.replacements(candidate);
    } catch {
      return false;
    }
    if (!replacements) return false;
    for (const [node, text] of replacements) {
      node.data = text;
      this.expected.set(node, text);
    }
    // Text.data writes are synchronous and dispatch no site input/change events.
    this.observer.takeRecords();
    this.translated = candidate !== null;
    return true;
  }
  dispose(restore = false) {
    if (restore) this.show(null);
    this.observer.disconnect();
    this.valid = false;
    this.listeners.clear();
  }
}
