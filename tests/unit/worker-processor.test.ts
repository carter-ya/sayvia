import { describe, expect, it, vi } from 'vitest';
import { WorkerProcessor } from '../../src/executor/worker-processor';

class WorkerFixture extends EventTarget {
  terminate = vi.fn();
  postMessage = vi.fn();
  reply(id: string, data: unknown, ok = true) {
    this.dispatchEvent(new MessageEvent('message', { data: { id, ok, data } }));
  }
}
const source = { kind: 'plain-text' as const, text: 'hello' };
const setup = () => {
  const worker = new WorkerFixture();
  const processor = new WorkerProcessor(() => worker as unknown as Worker);
  return { worker, processor, signal: new AbortController() };
};

describe('per-task worker lifecycle', () => {
  it('rejects oversized reconstruction before posting, rather than waiting for a deadline', async () => {
    const { worker, processor, signal } = setup();
    await expect(processor.reconstruct('x'.repeat(192_001), signal.signal)).rejects.toThrow(
      'FORMAT_INVALID',
    );
    expect(worker.postMessage).not.toHaveBeenCalled();
    processor.dispose();
  }, 500);

  it('sends only the source and candidate to the worker, and correlates replies', async () => {
    const { worker, processor, signal } = setup();
    const prepared = processor.prepare(source, signal.signal);
    const request = worker.postMessage.mock.calls[0]![0];
    expect(Object.keys(request).sort()).toEqual(['id', 'type', 'value']);
    expect(request.value).toEqual(source);
    const data = { sourceText: 'hello', payload: { segments: [] }, required: false };
    worker.reply('unknown-id', 'ignored');
    worker.reply(request.id, data);
    await expect(prepared).resolves.toEqual(data);
    const reconstructed = processor.reconstruct('{"segments":[]}', signal.signal);
    const second = worker.postMessage.mock.calls[1]![0];
    expect(second.value).toBe('{"segments":[]}');
    worker.reply(second.id, 'hello');
    await expect(reconstructed).resolves.toBe('hello');
    processor.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('cancellation rejects pending work and termination releases the worker', async () => {
    const { worker, processor, signal } = setup();
    const prepared = processor.prepare(source, signal.signal);
    const assertion = expect(prepared).rejects.toThrow('CANCELED');
    signal.abort();
    await assertion;
    processor.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(processor.prepare(source, signal.signal)).rejects.toThrow('CANCELED');
    expect(worker.postMessage).toHaveBeenCalledOnce();
  });

  it.each(['error', 'messageerror'])(
    'a worker %s rejects pending operations with an allowlisted error',
    async (event) => {
      const { worker, processor, signal } = setup();
      const prepared = processor.prepare(source, signal.signal);
      const assertion = expect(prepared).rejects.toThrow('NETWORK_ERROR');
      worker.dispatchEvent(new Event(event));
      await assertion;
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );

  it('does not pass raw parser errors through a failed reply', async () => {
    const { worker, processor, signal } = setup();
    const prepared = processor.prepare(source, signal.signal);
    const assertion = expect(prepared).rejects.toThrow('FORMAT_INVALID');
    worker.reply(worker.postMessage.mock.calls[0]![0].id, 'RAW_PRIVATE_ERROR', false);
    await assertion;
    processor.dispose();
  });
});
