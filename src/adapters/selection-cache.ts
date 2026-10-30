import { captureDomRange, captureDomSelection } from './dom-selection';
import { SourceError, type SourceErrorCode, type DomSource } from '../core/source-input';

interface CapturedSelection {
  range: Range;
  source: DomSource;
  signature: string;
  url: string;
}

export class ReadingSelectionCache {
  private captured: CapturedSelection | undefined;
  private error: SourceErrorCode | undefined;

  capture(selection: Selection | null, document: Document) {
    this.clear();
    let source: DomSource;
    try {
      source = captureDomSelection(selection, document);
    } catch (error) {
      this.error = error instanceof SourceError ? error.code : 'SELECTION_LOST';
      throw new SourceError(this.error);
    }
    const range = selection!.getRangeAt(0).cloneRange();
    this.captured = { range, source, signature: JSON.stringify(source), url: document.URL };
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
      if (JSON.stringify(captureDomRange(captured.range, document)) !== captured.signature) {
        throw new SourceError('SELECTION_LOST');
      }
      return structuredClone(captured.source);
    } catch {
      this.clear();
      throw new SourceError('SELECTION_LOST');
    }
  }

  clear() {
    this.captured = undefined;
    this.error = undefined;
  }
}
