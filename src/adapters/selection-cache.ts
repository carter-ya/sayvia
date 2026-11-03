import { captureGithubDiff } from './github-diff-selection';
import { readingMarkdown, type ReadingLink } from './reading-markdown';
import { captureDomRange, captureDomSelection } from './dom-selection';
import { createTranslationPlan, needsTranslation } from '../core/translation-plan';
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
    const diff = this.formatted ? captureGithubDiff(range, document) : undefined;
    const links = this.formatted && !diff ? new Map<Element, ReadingLink>() : undefined;
    const flat = diff ? undefined : captureDomRange(range, document, links);
    let source = diff?.source ?? (links ? readingMarkdown(flat!, [...links.values()]) : flat!);
    // Inline code can remain a protected piece inside prose. If code markup
    // swallows the entire explicit selection, translate that selection literally
    // rather than treating its container as a reason to skip the user's action.
    if (
      links &&
      flat!.protectedRanges.some(
        (span) => span.kind === 'inline-code' || span.kind === 'code-block',
      ) &&
      !needsTranslation(createTranslationPlan(source))
    ) {
      source = readingMarkdown(
        {
          ...flat!,
          protectedRanges: flat!.protectedRanges.filter(
            (span) => span.kind !== 'inline-code' && span.kind !== 'code-block',
          ),
        },
        [...links.values()],
      );
    }
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
    return this.remember(selection!.getRangeAt(0), document, source, plainText, signature);
  }

  captureRange(range: Range, document: Document) {
    this.clear();
    const { source, plainText, signature } = this.rangeSource(range, document);
    return this.remember(range, document, source, plainText, signature);
  }

  private remember(
    nativeRange: Range,
    document: Document,
    source: DomSource,
    plainText: string,
    signature: string,
  ) {
    const range = nativeRange.cloneRange();
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
