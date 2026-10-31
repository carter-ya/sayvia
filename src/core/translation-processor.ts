import type { SourceInput } from './source-input';
import {
  createTranslationPlan,
  needsTranslation,
  reconstructTranslation,
  translationPayload,
  type TranslationPlan,
} from './translation-plan';

export interface TranslationProcessor {
  prepare(
    source: SourceInput,
    signal: AbortSignal,
  ): Promise<{
    sourceText: string;
    payload: ReturnType<typeof translationPayload>;
    required: boolean;
  }>;
  reconstruct(content: string, signal: AbortSignal): Promise<string>;
  dispose(): void;
}

export function localProcessor(): TranslationProcessor {
  let plan: TranslationPlan | undefined;
  return {
    async prepare(source) {
      plan = createTranslationPlan(source);
      return {
        sourceText: plan.sourceText,
        payload: translationPayload(plan),
        required: needsTranslation(plan),
      };
    },
    async reconstruct(content) {
      if (!plan) throw new Error('INVALID_PLAN');
      return reconstructTranslation(plan, content);
    },
    dispose() {
      plan = undefined;
    },
  };
}
