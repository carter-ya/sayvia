import { CAPTION_LIMITS, CaptionError, bytes } from './contract';

// Observe a clone only. Canceling a tee branch may wait for the original consumer,
// so releasing our application slot must never await reader.cancel().
export class CaptionBodyReader {
  private readonly active = new Set<() => void>();
  constructor(private readonly deadlineMs = 10_000) {}
  get size() {
    return this.active.size;
  }
  cancel() {
    for (const stop of [...this.active]) stop();
  }
  read(response: Response, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(new CaptionError('CAPTION_BRIDGE_INVALID'));
    if (this.active.size >= 2) return Promise.reject(new CaptionError('CAPTION_LIMIT'));
    const declared = Number(response.headers.get('content-length'));
    if (declared > CAPTION_LIMITS.responseBytes)
      return Promise.reject(new CaptionError('CAPTION_LIMIT'));
    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      const body = response.clone().body;
      if (!body) throw new CaptionError('UNSUPPORTED_CAPTION_FORMAT');
      reader = body.getReader();
    } catch {
      return Promise.reject(new CaptionError('UNSUPPORTED_CAPTION_FORMAT'));
    }
    return new Promise<string>((resolve, reject) => {
      let ended = false;
      let size = 0;
      const parts: string[] = [];
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const finish = (error?: CaptionError, value?: string) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        this.active.delete(stop);
        parts.length = 0;
        if (error) {
          void reader.cancel().catch(() => undefined);
          reject(error);
        } else resolve(value!);
        try {
          reader.releaseLock();
        } catch {
          /* The pending read is already canceled. */
        }
      };
      const stop = () => finish(new CaptionError('CAPTION_BRIDGE_INVALID'));
      const timer = setTimeout(stop, this.deadlineMs);
      this.active.add(stop);
      signal.addEventListener('abort', stop, { once: true });
      void (async () => {
        try {
          while (!ended) {
            const part = await reader.read();
            if (ended) return;
            if (part.done) break;
            size += part.value.byteLength;
            if (size > CAPTION_LIMITS.responseBytes) {
              finish(new CaptionError('CAPTION_LIMIT'));
              return;
            }
            parts.push(decoder.decode(part.value, { stream: true }));
          }
          if (ended) return;
          parts.push(decoder.decode());
          const body = parts.join('');
          if (bytes(body) > CAPTION_LIMITS.responseBytes) finish(new CaptionError('CAPTION_LIMIT'));
          else finish(undefined, body);
        } catch {
          finish(new CaptionError('UNSUPPORTED_CAPTION_FORMAT'));
        }
      })();
    });
  }
}
