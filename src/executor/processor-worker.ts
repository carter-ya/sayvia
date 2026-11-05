import { ProviderError } from '../providers/completion-transport';

type Pending = { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void };

export class ProcessorWorker {
  private worker: Worker | undefined;
  private pending = new Map<string, Pending>();
  private disposed = false;

  constructor(
    private readonly create = () =>
      new Worker(new URL('./bootstrap.worker.ts', import.meta.url), { type: 'module' }),
  ) {}

  protected call(type: string, value: unknown, signal: AbortSignal) {
    if (this.disposed || signal.aborted) return Promise.reject(new ProviderError('CANCELED'));
    if (!this.worker) {
      this.worker = this.create();
      this.worker.addEventListener('message', (event: MessageEvent<unknown>) => {
        const reply = event.data as { id?: string; ok?: boolean; data?: unknown } | null;
        if (!reply || typeof reply.id !== 'string') return;
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id);
        pending.cleanup();
        if (reply.ok === true) pending.resolve(reply.data);
        else pending.reject(new ProviderError('FORMAT_INVALID'));
      });
      this.worker.addEventListener('error', () => this.dispose());
      this.worker.addEventListener('messageerror', () => this.dispose());
    }
    const id = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const cancel = () => {
        this.pending.delete(id);
        reject(new ProviderError('CANCELED'));
      };
      signal.addEventListener('abort', cancel, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => signal.removeEventListener('abort', cancel),
      });
      try {
        this.worker!.postMessage({ id, type, value });
      } catch {
        this.dispose();
      }
    });
  }

  dispose() {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = undefined;
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(new ProviderError('NETWORK_ERROR'));
    }
    this.pending.clear();
  }
}
