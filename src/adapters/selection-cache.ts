import { captureGithubMarkdownDiff } from './github-diff-selection';
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
    const diff = this.formatted ? captureGithubMarkdownDiff(range, document) : undefined;
    const links = this.formatted && !diff ? new Map<Element, ReadingLink>() : undefined;
    const flat = diff ? undefined : captureDomRange(range, document, links);
    const source = diff?.source ?? (links ? readingMarkdown(flat!, [...links.values()]) : flat!);
    return {
      source,
      plainText: diff?.plainText ?? flat!.text,
      signature: JSON.stringify({ source, links: links ? [...links.values()] : [] }),
    };
  }
  private captured: CapturedSelection | undefined;
  private error: SourceErrorCode | undefined;

  capture(selection: Selection | null, document: Document) {
    this.clear();
    let source: DomSource;
    let plainText: string;
    let signature: string;
    try {
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
        // Reuse the standard validation and its public error codes.
        captureDomSelection(selection, document);
      }
      const captured = this.rangeSource(selection!.getRangeAt(0), document);
      source = captured.source;
      plainText = captured.plainText;
      signature = captured.signature;
    } catch (error) {
      this.error = error instanceof SourceError ? error.code : 'SELECTION_LOST';
      throw new SourceError(this.error);
    }
    const range = selection!.getRangeAt(0).cloneRange();
    this.captured = {
      range,
      source,
      plainText,
      signature,
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
      if (this.rangeSource(captured.range, document).signature !== captured.signature) {
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
