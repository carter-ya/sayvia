import { expect, test, vi } from 'vitest';
import { CaptionBodyReader } from '../../src/captions/body-reader';
import { CAPTION_LIMITS } from '../../src/captions/contract';

test('clone observation leaves the original response readable', async () => {
  const source = new Response('{"events":[]}');
  const pool = new CaptionBodyReader();
  const captured = pool.read(source, new AbortController().signal);
  expect(await source.text()).toBe('{"events":[]}');
  expect(await captured).toBe('{"events":[]}');
  expect(pool.size).toBe(0);
});

test('cancel frees the slot without waiting for a tee branch or disturbing original data', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const original = new Response(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    }),
  );
  const pool = new CaptionBodyReader();
  const abort = new AbortController();
  const captured = pool.read(original, abort.signal);
  const check = expect(captured).rejects.toThrow('CAPTION_BRIDGE_INVALID');
  abort.abort();
  expect(pool.size).toBe(0);
  await check;
  controller.enqueue(new TextEncoder().encode('still belongs to player'));
  controller.close();
  expect(await original.text()).toBe('still belongs to player');
});

test('bounded readers reject overflow and timeout all local work without waiting for the site', async () => {
  vi.useFakeTimers();
  const pool = new CaptionBodyReader(100);
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const responses = Array.from(
    { length: 3 },
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controllers.push(value);
          },
        }),
      ),
  );
  try {
    const first = pool.read(responses[0]!, new AbortController().signal);
    const second = pool.read(responses[1]!, new AbortController().signal);
    const checks = [
      expect(first).rejects.toThrow('CAPTION_BRIDGE_INVALID'),
      expect(second).rejects.toThrow('CAPTION_BRIDGE_INVALID'),
    ];
    await expect(pool.read(responses[2]!, new AbortController().signal)).rejects.toThrow(
      'CAPTION_LIMIT',
    );
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(checks);
    expect(pool.size).toBe(0);
  } finally {
    for (const controller of controllers) controller.close();
    await Promise.all(responses.map((response) => response.text()));
    vi.useRealTimers();
  }
});

test('limits cover actual streamed bytes, declared size and malformed UTF-8', async () => {
  const pool = new CaptionBodyReader();
  await expect(
    pool.read(
      new Response('x', {
        headers: { 'content-length': String(CAPTION_LIMITS.responseBytes + 1) },
      }),
      new AbortController().signal,
    ),
  ).rejects.toThrow('CAPTION_LIMIT');
  const huge = new Response(new Uint8Array(CAPTION_LIMITS.responseBytes + 1));
  const hugeCopy = pool.read(huge, new AbortController().signal);
  await huge.arrayBuffer();
  await expect(hugeCopy).rejects.toThrow('CAPTION_LIMIT');
  const invalid = new Response(new Uint8Array([0xff]));
  const invalidCopy = pool.read(invalid, new AbortController().signal);
  await invalid.arrayBuffer();
  await expect(invalidCopy).rejects.toThrow('UNSUPPORTED_CAPTION_FORMAT');
  expect(pool.size).toBe(0);
});
