import { z } from 'zod';
import { SourceInputSchema } from '../core/source-input';
import { localProcessor } from '../core/translation-processor';

const processor = localProcessor();
const Request = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prepare'), id: z.uuid(), value: SourceInputSchema }).strict(),
  z
    .object({ type: z.literal('reconstruct'), id: z.uuid(), value: z.string().max(192_000) })
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
  if (!parsed.success) return;
  const request = parsed.data;
  const signal = new AbortController().signal;
  void (
    request.type === 'prepare'
      ? processor.prepare(request.value, signal)
      : processor.reconstruct(request.value, signal)
  ).then(
    (data) => self.postMessage({ id: request.id, ok: true, data }),
    () => self.postMessage({ id: request.id, ok: false }),
  );
});
