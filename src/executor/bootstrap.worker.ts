import { z } from 'zod';
import { SourceInputSchema } from '../core/source-input';
import { MAX_OUTPUT_CHARACTERS } from '../core/translation-plan';
import { localProcessor } from '../core/translation-processor';
import { LearningInputSchema } from '../core/learning-contract';
import { localLearningProcessor } from '../core/learning-processor';

const processor = localProcessor();
const learning = localLearningProcessor();
const RpcEnvelope = z.object({
  type: z.enum(['prepare', 'preview', 'reconstruct', 'learning.prepare', 'learning.finish']),
  id: z.uuid(),
});
const Request = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('learning.prepare'), id: z.uuid(), value: LearningInputSchema })
    .strict(),
  z
    .object({ type: z.literal('learning.finish'), id: z.uuid(), value: z.string().max(256 * 1024) })
    .strict(),
  z.object({ type: z.literal('prepare'), id: z.uuid(), value: SourceInputSchema }).strict(),
  z
    .object({
      type: z.enum(['preview', 'reconstruct']),
      id: z.uuid(),
      value: z.string().max(MAX_OUTPUT_CHARACTERS * 8),
    })
    .strict(),
]);
self.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (
    typeof event.data === 'object' &&
    event.data !== null &&
    'type' in event.data &&
    event.data.type === 'runtime.check'
  ) {
    self.postMessage({ type: 'runtime.ready' });
    return;
  }
  const parsed = Request.safeParse(event.data);
  if (!parsed.success) {
    const envelope = RpcEnvelope.safeParse(event.data);
    // A known RPC must terminate promptly, without leaking parser errors or source text.
    if (envelope.success) self.postMessage({ id: envelope.data.id, ok: false });
    return;
  }
  const request = parsed.data;
  const signal = new AbortController().signal;
  void (
    request.type === 'learning.prepare'
      ? learning.prepare(request.value, signal)
      : request.type === 'learning.finish'
        ? learning.finish(request.value, signal)
        : request.type === 'prepare'
          ? processor.prepare(request.value, signal)
          : request.type === 'preview'
            ? processor.preview!(request.value, signal)
            : processor.reconstruct(request.value, signal)
  ).then(
    (data) => self.postMessage({ id: request.id, ok: true, data }),
    () => self.postMessage({ id: request.id, ok: false }),
  );
});
