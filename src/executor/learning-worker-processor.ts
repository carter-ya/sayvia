import type { LearningInput, LearningValue } from '../core/learning-contract';
import type { LearningProcessor, PreparedLearning } from '../core/learning-processor';
import { ProviderError } from '../providers/completion-transport';
import { ProcessorWorker } from './processor-worker';

export class LearningWorkerProcessor extends ProcessorWorker implements LearningProcessor {
  async prepare(input: LearningInput, signal: AbortSignal): Promise<PreparedLearning> {
    return (await this.call('learning.prepare', input, signal)) as PreparedLearning;
  }
  async finish(content: string, signal: AbortSignal): Promise<LearningValue> {
    if (content.length > 256 * 1024) throw new ProviderError('FORMAT_INVALID');
    return (await this.call('learning.finish', content, signal)) as LearningValue;
  }
}
