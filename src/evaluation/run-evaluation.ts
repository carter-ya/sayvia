import { SourceError } from '../core/source-input';
import {
  translate,
  ProviderError,
  ALGORITHM_VERSION,
  type CompletionConfig,
} from '../providers/chat-completions';
import { M1_SAMPLES } from './samples';

export interface EvaluationEntry {
  id: string;
  title: string;
  targetLanguage: string;
  sourceText: string;
  referenceMeaning: string;
  reviewFocus: string;
  protectedText: string[];
  status: 'ready' | 'failed';
  translatedText?: string;
  errorCode?: string;
  durationMs: number;
  automaticProtectionPassed: boolean;
  semanticReview: 'pending';
  usabilityReview: 'pending';
}

export async function runEvaluation(
  config: CompletionConfig,
  onEntry: (entry: EvaluationEntry) => void | Promise<void>,
  fetcher: typeof fetch = fetch,
) {
  const entries: EvaluationEntry[] = [];
  for (const sample of M1_SAMPLES) {
    const startedAt = Date.now();
    let entry: EvaluationEntry;
    const common = {
      id: sample.id,
      title: sample.title,
      targetLanguage: sample.targetLanguage,
      sourceText: sample.source.text,
      referenceMeaning: sample.referenceMeaning,
      reviewFocus: sample.reviewFocus,
      protectedText: [...sample.protectedText],
      semanticReview: 'pending' as const,
      usabilityReview: 'pending' as const,
    };
    try {
      const result = await translate(
        {
          config,
          source: sample.source,
          sourceLanguage: 'auto',
          targetLanguage: sample.targetLanguage,
        },
        fetcher,
      );
      entry = {
        ...common,
        status: 'ready',
        translatedText: result.text,
        durationMs: result.durationMs,
        automaticProtectionPassed: sample.protectedText.every((text) => result.text.includes(text)),
      };
    } catch (error) {
      entry = {
        ...common,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        automaticProtectionPassed: false,
        errorCode:
          error instanceof ProviderError || error instanceof SourceError
            ? error.code
            : 'NETWORK_ERROR',
      };
    }
    entries.push(entry);
    await onEntry(entry);
  }
  return {
    algorithmVersion: ALGORITHM_VERSION,
    sampleCount: entries.length,
    automatedPassed: entries.every(
      (entry) =>
        entry.status === 'ready' && entry.automaticProtectionPassed && entry.durationMs < 60_000,
    ),
    manualReviewPending: true,
    m1Passed: false,
    entries,
  };
}
