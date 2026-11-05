import { afterEach, describe, expect, it, vi } from 'vitest';

async function bootstrap() {
  vi.resetModules();
  const worker = Object.assign(new EventTarget(), { postMessage: vi.fn() });
  vi.stubGlobal('self', worker);
  await import('../../src/executor/bootstrap.worker');
  const send = async (data: unknown) => {
    worker.dispatchEvent(new MessageEvent('message', { data }));
    await Promise.resolve();
  };
  return { worker, send };
}
afterEach(() => vi.unstubAllGlobals());

describe('production Worker request boundary', () => {
  it('returns a bounded failure immediately for invalid lookup or caption payloads', async () => {
    const { worker, send } = await bootstrap();
    const caption = {
      sessionId: crypto.randomUUID(),
      generation: 0,
      videoId: 'video',
      trackKey: 'track',
      batchId: crypto.randomUUID(),
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      units: [{ unitId: 'g0', revision: 0, text: 'source' }],
    };
    const invalid = [
      {
        purpose: 'lookup',
        input: { text: 'x'.repeat(81), sourceLanguage: 'en', explanationLanguage: 'fr' },
      },
      {
        purpose: 'lookup',
        input: { text: 'private source', sourceLanguage: 'en', explanationLanguage: 'bad_locale' },
      },
      { purpose: 'captions', input: { ...caption, units: [caption.units[0], caption.units[0]] } },
      {
        purpose: 'captions',
        input: { ...caption, units: [{ ...caption.units[0], startMs: 123 }] },
      },
    ];
    for (const value of invalid) {
      worker.postMessage.mockClear();
      const id = crypto.randomUUID();
      await send({ id, type: 'learning.prepare', value });
      expect(worker.postMessage.mock.calls).toEqual([[{ id, ok: false }]]);
    }
    worker.postMessage.mockClear();
    await send({ id: 'invalid-id', type: 'learning.prepare', value: invalid[0] });
    await send({ id: crypto.randomUUID(), type: 'unknown', value: invalid[0] });
    expect(worker.postMessage).not.toHaveBeenCalled();
  });
  it('executes real lookup preparation and strict result validation through bootstrap', async () => {
    const { worker, send } = await bootstrap();
    const id = crypto.randomUUID();
    await send({
      id,
      type: 'learning.prepare',
      value: {
        purpose: 'lookup',
        input: { text: 'hello', sourceLanguage: 'en', explanationLanguage: 'fr' },
      },
    });
    expect(worker.postMessage.mock.calls[0]![0]).toMatchObject({
      id,
      ok: true,
      data: { algorithmVersion: 'lookup-v3', payload: { text: 'hello' } },
    });
    const finishId = crypto.randomUUID();
    await send({
      id: finishId,
      type: 'learning.finish',
      value: JSON.stringify({
        detectedLanguage: 'en',
        meanings: [{ partOfSpeech: null, definition: 'bonjour' }],
        example: null,
        note: null,
      }),
    });
    expect(worker.postMessage.mock.calls[1]![0]).toMatchObject({
      id: finishId,
      ok: true,
      data: { purpose: 'lookup', value: { meanings: [{ definition: 'bonjour' }] } },
    });
    const invalidId = crypto.randomUUID();
    await send({ id: invalidId, type: 'learning.finish', value: '{"private":"RAW_SOURCE"}' });
    expect(worker.postMessage.mock.calls[2]![0]).toEqual({ id: invalidId, ok: false });
  });
});
