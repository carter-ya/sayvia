import { readingMarkdown, type ReadingLink } from './reading-markdown';
import { captureDomRange, captureDomSelection } from './dom-selection';
import { SourceError, type SourceErrorCode, type DomSource } from '../core/source-input';

interface CapturedSelection {
  range: Range;
  source: DomSource;
  plainText: string;
  signature: string;
  url: string;
}

export class ReadingSelectionCache {
  constructor(private readonly formatted = false) {}
  private rangeSource(range: Range, document: Document) {
    const links = this.formatted ? new Map<Element, ReadingLink>() : undefined;
    const source = captureDomRange(range, document, links);
    return links ? readingMarkdown(source, [...links.values()]) : source;
  }
  private captured: CapturedSelection | undefined;
  private error: SourceErrorCode | undefined;

  capture(selection: Selection | null, document: Document) {
    this.clear();
    let source: DomSource;
    let plainText: string;
    try {
      const links = this.formatted ? new Map<Element, ReadingLink>() : undefined;
      const flat = captureDomSelection(selection, document, links);
      source = links ? readingMarkdown(flat, [...links.values()]) : flat;
      plainText = flat.text;
    } catch (error) {
      this.error = error instanceof SourceError ? error.code : 'SELECTION_LOST';
      throw new SourceError(this.error);
    }
    const range = selection!.getRangeAt(0).cloneRange();
    this.captured = {
      range,
      source,
      plainText,
      signature: JSON.stringify(source),
      url: document.URL,
    };
    return structuredClone(source);
  }

  read(document: Document) {
    const captured = this.captured;
    if (!captured && this.error) throw new SourceError(this.error);
    if (!captured || captured.url !== document.URL) {
      this.clear();
      throw new SourceError('SELECTION_LOST');
    }
    try {
      if (JSON.stringify(this.rangeSource(captured.range, document)) !== captured.signature) {
        throw new SourceError('SELECTION_LOST');
      }
      return structuredClone(captured.source);
    } catch {
      this.clear();
      throw new SourceError('SELECTION_LOST');
    }
  }

  readText(document: Document) {
    this.read(document);
    return this.captured!.plainText;
  }

  clear() {
    this.captured = undefined;
    this.error = undefined;
  }
}
