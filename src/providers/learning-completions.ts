import { ZodError } from 'zod';
import { LearningFormatError, type LearningInput } from '../core/learning-contract';
import {
  learningDisplayText,
  localLearningProcessor,
  type LearningProcessor,
} from '../core/learning-processor';
import type { LearningResult } from '../runtime/learning-protocol';
import type { TokenUsage, TranslationProgress } from '../runtime/translation-progress';
import { EndpointError } from './endpoint';
import { StreamError } from './completion-stream';
import {
  EXECUTION_BUDGET_MS,
  prepareCompletion,
  ProviderError,
  sendCompletion,
  type CompletionConfig,
} from './completion-transport';

export interface LearningRequest {
  config: CompletionConfig;
  task: LearningInput;
  signal?: AbortSignal;
  deadlineAt?: number;
  onProgress?(progress: TranslationProgress): void;
}

export async function executeLearning(
  request: LearningRequest,
  fetcher: typeof fetch = fetch,
  processor: LearningProcessor = localLearningProcessor(),
): Promise<LearningResult> {
  const startedAt = Date.now();
  const remaining = Math.min(
    EXECUTION_BUDGET_MS,
    (request.deadlineAt ?? startedAt + EXECUTION_BUDGET_MS) - startedAt,
  );
  if (!Number.isFinite(remaining) || remaining <= 0) {
    processor.dispose();
    throw new ProviderError('TIMEOUT');
  }
  const controller = new AbortController();
  let abortCode: 'CANCELED' | 'TIMEOUT' | undefined;
  const cancel = () => {
    abortCode ??= 'CANCELED';
    controller.abort();
  };
  const timer = setTimeout(() => {
    abortCode ??= 'TIMEOUT';
    controller.abort();
  }, remaining);
  request.signal?.addEventListener('abort', cancel, { once: true });
  if (request.signal?.aborted) cancel();
  const check = () => {
    if (abortCode || Date.now() - startedAt >= remaining)
      throw new ProviderError(abortCode ?? 'TIMEOUT');
  };
  try {
    check();
    const prepared = await processor.prepare(request.task, controller.signal);
    check();
    const transport = prepareCompletion(
      request.config,
      prepared.instruction,
      prepared.payload,
      false,
    );
    const estimates = { inputTokens: transport.inputTokens, outputTokens: 0 };
    let usage: TokenUsage | undefined;
    let lastProgress = 0;
    const progress = (phase: TranslationProgress['phase'], force = false) => {
      check();
      const now = Date.now();
      if (!force && now - lastProgress < 80) return;
      lastProgress = now;
      request.onProgress?.({
        text: '',
        elapsedMs: now - startedAt,
        phase,
        estimates: { ...estimates },
        ...(usage ? { usage } : {}),
      });
    };
    progress('connecting', true);
    const response = await sendCompletion(
      transport,
      controller.signal,
      fetcher,
      async (content, reasoning, actual) => {
        usage = actual ?? usage;
        estimates.outputTokens = Math.ceil(
          (new TextEncoder().encode(content).length + reasoning * 2) / 4,
        );
        progress(content ? 'translating' : reasoning ? 'thinking' : 'connecting');
      },
    );
    check();
    usage = response.usage ?? usage;
    estimates.outputTokens = Math.max(
      estimates.outputTokens,
      Math.ceil(new TextEncoder().encode(response.content).length / 4),
    );
    progress('validating', true);
    const data = await processor.finish(response.content, controller.signal);
    if (learningDisplayText(data).some((text) => text.includes(transport.config.apiKey)))
      throw new ProviderError('UNSUPPORTED_RESPONSE');
    check();
    return {
      requested: true,
      data,
      algorithmVersion: prepared.algorithmVersion,
      durationMs: Date.now() - startedAt,
      streamed: response.streamed,
      estimates,
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    if (abortCode) throw new ProviderError(abortCode);
    if (error instanceof ProviderError) throw error;
    if (error instanceof LearningFormatError || error instanceof ZodError)
      throw new ProviderError('FORMAT_INVALID');
    if (error instanceof StreamError) throw new ProviderError('UNSUPPORTED_RESPONSE');
    if (error instanceof EndpointError) throw new ProviderError('CONFIG_REQUIRED');
    throw new ProviderError('NETWORK_ERROR');
  } finally {
    processor.dispose();
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', cancel);
  }
}
