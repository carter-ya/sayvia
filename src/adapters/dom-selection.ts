import {
  MAX_SOURCE_CHARACTERS,
  MAX_SOURCE_SPANS,
  parseSourceInput,
  SourceError,
  type DomSource,
} from '../core/source-input';

const EXCLUDED =
  'script,style,template,noscript,head,iframe,object,embed,textarea,input,select,option,canvas,svg,[hidden],[inert],[aria-hidden="true"],[data-sayvia-ui]';
const BLOCK_DISPLAY =
  /^(?:block|flow-root|list-item|flex|grid|table|table-row|table-cell|table-caption|table-row-group|table-header-group|table-footer-group)(?:\s|$)/;
const MAX_NODES = 20_000;
const MAX_DEPTH = 256;

class SourceBuilder {
  text = '';
  protectedRanges: DomSource['protectedRanges'] = [];
  marks: DomSource['marks'] = [];
  pendingBreak = false;
  private pendingSpace = false;
  private characters = 0;

  private raw(value: string, kind?: 'inline-code' | 'code-block') {
    if (!value) return;
    this.characters += [...value].length;
    if (this.characters > MAX_SOURCE_CHARACTERS) throw new SourceError('SOURCE_TOO_LONG');
    const start = this.text.length;
    this.text += value;
    if (kind) {
      const previous = this.protectedRanges.at(-1);
      if (previous?.kind === kind && previous.end === start) previous.end = this.text.length;
      else this.protectedRanges.push({ start, end: this.text.length, kind });
    }
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === '\n')
        this.marks.push({ kind: 'line-break', start: start + index, end: start + index + 1 });
    }
    if (this.protectedRanges.length + this.marks.length > MAX_SOURCE_SPANS) {
      throw new SourceError('SELECTION_TOO_COMPLEX');
    }
  }

  append(
    value: string,
    kind?: 'inline-code' | 'code-block',
    whitespace: 'normal' | 'preserve' | 'pre-line' = 'normal',
  ) {
    if (!value) return;
    if (!kind && whitespace === 'pre-line') {
      const lines = value.replace(/\r\n?/g, '\n').split('\n');
      let start: number | undefined;
      for (const [index, line] of lines.entries()) {
        if (index) {
          start ??= this.text.length;
          this.lineBreak();
        }
        const span = this.append(line, undefined, 'normal');
        if (span) start ??= span.start;
      }
      return start === undefined ? undefined : { start, end: this.text.length };
    }
    const normalized =
      kind || whitespace === 'preserve' ? value : value.replace(/[\t\r\n\f ]+/g, ' ');
    if (!kind && whitespace === 'normal' && normalized === ' ') {
      if (this.text && !this.pendingBreak) this.pendingSpace = true;
      return;
    }
    if (this.pendingBreak) {
      this.pendingSpace = false;
      if (this.text && !this.text.endsWith('\n')) this.raw('\n');
    }
    this.pendingBreak = false;

    let content = normalized;
    if (!kind && whitespace === 'normal') {
      if (content.startsWith(' ') && this.text) this.pendingSpace = true;
      content = content.replace(/^ /, '');
    }
    if (this.pendingSpace && this.text && !/[ \n]$/.test(this.text)) this.raw(' ');
    this.pendingSpace = false;
    if (!kind && whitespace === 'normal' && content.endsWith(' ')) {
      content = content.slice(0, -1);
      this.pendingSpace = true;
    }
    const start = this.text.length;
    this.raw(content, kind);
    return this.text.length > start ? { start, end: this.text.length } : undefined;
  }

  lineBreak(kind?: 'inline-code' | 'code-block') {
    if (this.pendingBreak && this.text && !this.text.endsWith('\n')) this.raw('\n');
    this.pendingSpace = false;
    this.pendingBreak = false;
    this.raw('\n', kind);
  }
}

export function captureDomRange(range: Range, expectedDocument: Document = document): DomSource {
  if (range.collapsed) throw new SourceError('EMPTY_SOURCE');
  if (
    range.startContainer.getRootNode() !== expectedDocument ||
    range.endContainer.getRootNode() !== expectedDocument ||
    !range.startContainer.isConnected ||
    !range.endContainer.isConnected
  ) {
    throw new SourceError('UNSUPPORTED_SELECTION');
  }
  const extension = (
    globalThis as unknown as {
      chrome?: {
        runtime?: { id?: string };
        dom?: { openOrClosedShadowRoot?: (element: Element) => unknown };
      };
    }
  ).chrome;
  if (extension?.runtime?.id && !extension.dom?.openOrClosedShadowRoot)
    throw new SourceError('UNSUPPORTED_SELECTION');
  const builder = new SourceBuilder();
  const visible = new WeakMap<Element, boolean>();
  let visited = 0;
  const summaries = new WeakMap<Element, Element | null>();
  const collapsedChild = (node: Node) => {
    const parent = node.parentElement;
    if (parent?.tagName !== 'DETAILS' || parent.hasAttribute('open')) return false;
    if (!summaries.has(parent)) summaries.set(parent, parent.querySelector(':scope > summary'));
    return node !== summaries.get(parent);
  };
  const isVisible = (element: Element | null) => {
    const ancestors: Element[] = [];
    let current = element;
    while (current) {
      if (ancestors.length > MAX_DEPTH) throw new SourceError('SELECTION_TOO_COMPLEX');
      const cached = visible.get(current);
      if (cached !== undefined) {
        for (const ancestor of ancestors) visible.set(ancestor, cached);
        return cached;
      }
      ancestors.push(current);
      const style = expectedDocument.defaultView?.getComputedStyle(current);
      if (
        current.matches(EXCLUDED) ||
        collapsedChild(current) ||
        style?.display === 'none' ||
        style?.contentVisibility === 'hidden' ||
        style?.opacity === '0'
      ) {
        for (const ancestor of ancestors) visible.set(ancestor, false);
        return false;
      }
      if (current.shadowRoot) throw new SourceError('UNSUPPORTED_SELECTION');
      if (
        current.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
        extension?.dom?.openOrClosedShadowRoot
      ) {
        try {
          if (extension.dom.openOrClosedShadowRoot(current))
            throw new SourceError('UNSUPPORTED_SELECTION');
        } catch {
          throw new SourceError('UNSUPPORTED_SELECTION');
        }
      }
      current = current.parentElement;
    }
    for (const ancestor of ancestors) visible.set(ancestor, true);
    return true;
  };
  const codeKind = (element: Element | null) =>
    element?.closest('pre')
      ? ('code-block' as const)
      : element?.closest('code')
        ? ('inline-code' as const)
        : undefined;

  const walk = (node: Node, depth: number) => {
    if (++visited > MAX_NODES || depth > MAX_DEPTH) throw new SourceError('SELECTION_TOO_COMPLEX');
    if (!range.intersectsNode(node)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (collapsedChild(node) || !isVisible(node.parentElement)) return;
      const text = node as Text;
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : text.length;
      if (end <= start) return;
      const style =
        node.parentElement && expectedDocument.defaultView?.getComputedStyle(node.parentElement);
      if (style?.visibility === 'hidden' || style?.visibility === 'collapse') return;
      const whitespace =
        style && /^(pre|pre-wrap|break-spaces)$/.test(style.whiteSpace)
          ? 'preserve'
          : style?.whiteSpace === 'pre-line'
            ? 'pre-line'
            : 'normal';
      const span = builder.append(
        text.data.slice(start, end),
        codeKind(node.parentElement),
        whitespace,
      );
      if (span && node.parentElement?.closest('a')) {
        builder.marks.push({ kind: 'link-label', ...span });
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_NODE) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : undefined;
    if (element && !isVisible(element)) return;
    if (element?.tagName === 'BR') {
      const visibility = expectedDocument.defaultView?.getComputedStyle(element).visibility;
      if (visibility === 'hidden' || visibility === 'collapse') return;
      builder.lineBreak(codeKind(element));
      return;
    }
    const display = element && expectedDocument.defaultView?.getComputedStyle(element).display;
    const block = BLOCK_DISPLAY.test(display || '');
    if (block && builder.text) builder.pendingBreak = true;
    const start = builder.text.length;
    for (const child of node.childNodes) walk(child, depth + 1);
    if (block && builder.text.length > start) {
      builder.marks.push({ kind: 'paragraph', start, end: builder.text.length });
      builder.pendingBreak = true;
    }
    if (builder.marks.length + builder.protectedRanges.length > MAX_SOURCE_SPANS) {
      throw new SourceError('SELECTION_TOO_COMPLEX');
    }
  };
  walk(range.commonAncestorContainer, 0);
  const source = parseSourceInput({
    kind: 'dom-selection',
    text: builder.text,
    protectedRanges: builder.protectedRanges,
    marks: builder.marks.sort(
      (a, b) => a.start - b.start || a.end - b.end || a.kind.localeCompare(b.kind),
    ),
  });
  if (source.kind !== 'dom-selection') throw new SourceError('INVALID_SOURCE');
  return source;
}

export function captureDomSelection(
  selection: Selection | null,
  expectedDocument: Document = document,
) {
  if (!selection || selection.rangeCount === 0) throw new SourceError('EMPTY_SOURCE');
  if (selection.rangeCount !== 1) throw new SourceError('UNSUPPORTED_SELECTION');
  return captureDomRange(selection.getRangeAt(0), expectedDocument);
}
