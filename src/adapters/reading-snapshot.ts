import { captureDomRange } from './dom-selection';
import { markdownFingerprint, parseMarkdown } from '../core/markdown';
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
const unsafe =
  'button,[role="button"],input,textarea,select,label,summary,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[aria-live],[role="status"],[role="alert"],[data-diff-side],.diff-text';
const normalized = (text: string) => text.replace(/[\t\r\n\f ]+/g, ' ').trim();
function leaves(tree: Tree): Leaf[] {
  if (['text', 'inlineCode', 'code'].includes(tree.type))
    return [{ type: tree.type, value: tree.value ?? '' }];
  return (tree.children ?? []).flatMap(leaves);
}

// The wire format stays unchanged. A local, exact leaf-to-node match is required;
// ambiguous formatting falls back to preview instead of guessing text positions.
export function captureReadingSnapshot(range: Range, source: DomSource) {
  if (source.format !== 'markdown') return;
  try {
    const groups: Group[] = [];
    const guards: Slice[] = [];
    captureDomRange(range, range.startContainer.ownerDocument!, undefined, (node, start, end) => {
      if (node.parentElement?.closest(unsafe)) throw Error('UNSUPPORTED');
      const slice = { node, start, end, original: node.data, parent: node.parentNode! };
      guards.push(slice);
      const code = node.parentElement?.closest('code') ?? null;
      const previous = groups.at(-1);
      const last = previous?.slices.at(-1);
      if (
        previous &&
        last &&
        (code
          ? previous.code === code
          : !previous.code && last.node.nextSibling === node && last.parent === slice.parent)
      ) {
        previous.slices.push(slice);
        previous.text += node.data.slice(start, end);
      } else groups.push({ slices: [slice], text: node.data.slice(start, end), code });
    });
    const nonempty = groups.filter((group) => group.text.trim());
    const tree = parseMarkdown(source.text);
    const originalLeaves = leaves(tree);
    if (!nonempty.length || nonempty.length > 512 || nonempty.length !== originalLeaves.length)
      return;
    if (
      nonempty.some((group, index) => {
        const leaf = originalLeaves[index]!;
        return (
          Boolean(group.code) !== (leaf.type !== 'text') ||
          normalized(group.text) !== normalized(leaf.value)
        );
      })
    )
      return;
    return new ReadingSnapshot(
      nonempty,
      guards,
      originalLeaves,
      markdownFingerprint(tree),
      range.startContainer.ownerDocument!,
    );
  } catch {
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
    const owned = (node: Node) => node instanceof Element && node.hasAttribute('data-sayvia-ui');
    if (
      records.some((record) => {
        if (record.type === 'characterData') return this.expected.has(record.target as Text);
        if (record.type === 'attributes') return this.ancestors.has(record.target);
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
