import type { SourceInput } from '../core/source-input';
import type { TranslationProcessor } from '../core/translation-processor';
import { ProviderError } from '../providers/completion-transport';
import { ProcessorWorker } from './processor-worker';
import { MAX_OUTPUT_CHARACTERS } from '../core/translation-plan';

type Prepared = Awaited<ReturnType<TranslationProcessor['prepare']>>;
export class WorkerProcessor extends ProcessorWorker implements TranslationProcessor {
  async prepare(source: SourceInput, signal: AbortSignal): Promise<Prepared> {
    return (await this.call('prepare', source, signal)) as Prepared;
  }

  async preview(content: string, signal: AbortSignal): Promise<string> {
    if (content.length > MAX_OUTPUT_CHARACTERS * 8) return '';
    return (await this.call('preview', content, signal)) as string;
  }

  async reconstruct(content: string, signal: AbortSignal): Promise<string> {
    if (content.length > MAX_OUTPUT_CHARACTERS * 8) throw new ProviderError('FORMAT_INVALID');
    return (await this.call('reconstruct', content, signal)) as string;
  }
}
