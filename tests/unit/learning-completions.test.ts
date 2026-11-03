import { afterEach, describe, expect, it, vi } from 'vitest';
import { localLearningProcessor } from '../../src/core/learning-processor';
import { executeLearning } from '../../src/providers/learning-completions';
import type { LearningRequest } from '../../src/providers/learning-completions';
import type { TranslationProgress } from '../../src/runtime/translation-progress';

const config = {
  apiKey: 'DUMMY_PRIVATE_KEY',
  model: 'fixture',
  baseUrl: 'https://model.example/v1',
};
const request = (): LearningRequest => ({
  config,
  task: {
    purpose: 'lookup',
    input: { text: 'bank', sourceLanguage: 'en', explanationLanguage: 'zh-CN' },
  },
});
const lookup = () => ({
  detectedLanguage: 'en',
  meanings: [{ partOfSpeech: '名词', definition: '银行' }],
  example: null,
  note: null,
});
const response = (value: unknown) =>
  new Response(
    JSON.stringify({
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(value) },
        },
      ],
    }),
  );
afterEach(() => vi.useRealTimers());

describe('single-request learning execution', () => {
  it('separates untrusted source from instructions and never previews half a lookup object', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(lookup()));
    const progress: TranslationProgress[] = [];
    const input = request();
    const result = await executeLearning(
      { ...input, onProgress: (p) => progress.push(p) },
      fetcher,
    );
    expect(result).toMatchObject({
      requested: true,
      algorithmVersion: 'lookup-v3',
      data: { purpose: 'lookup', value: lookup() },
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(JSON.parse(body.messages[1].content)).toEqual(input.task.input);
    expect(body.stream).toBe(false);
    expect(body).not.toHaveProperty('response_format');
    expect(progress.map((p) => p.text)).toEqual(['', '']);
    expect(progress.at(-1)?.phase).toBe('validating');
  });
  it('rejects malformed output without hidden repair calls', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ ...lookup(), audioUrl: 'https://untrusted.test' }));
    await expect(executeLearning(request(), fetcher)).rejects.toThrow('FORMAT_INVALID');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(['literal', 'escaped'])(
    'rejects a %s credential in decoded lookup fields',
    async (kind) => {
      const data = lookup();
      data.meanings[0]!.definition = config.apiKey;
      const text = JSON.stringify(data);
      const content =
        kind === 'escaped'
          ? text.replace(
              config.apiKey,
              [...config.apiKey]
                .map((c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
                .join(''),
            )
          : text;
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content },
              },
            ],
          }),
        ),
      );
      await expect(executeLearning(request(), fetcher)).rejects.toThrow('UNSUPPORTED_RESPONSE');
    },
  );
  it('does not confuse a protocol field name with the Key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(lookup()));
    await expect(
      executeLearning({ ...request(), config: { ...config, apiKey: 'meanings' } }, fetcher),
    ).resolves.toMatchObject({ requested: true });
  });
  it('keeps caption document identity, revision and timestamps out of the model request', async () => {
    const input = {
      sessionId: crypto.randomUUID(),
      generation: 4,
      videoId: 'PRIVATE_VIDEO',
      trackKey: 'PRIVATE_TRACK',
      batchId: crypto.randomUUID(),
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      units: [{ unitId: 'g1', revision: 3, text: 'behind the wheel' }],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ cues: [{ id: 'g1', text: '掌舵' }] }));
    const result = await executeLearning({ config, task: { purpose: 'captions', input } }, fetcher);
    const body = String(fetcher.mock.calls[0]![1]!.body);
    expect(body).not.toMatch(/PRIVATE_VIDEO|PRIVATE_TRACK|revision|generation|startMs|endMs/);
    expect(JSON.parse(JSON.parse(body).messages[1].content)).toEqual({
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      cues: [{ id: 'g1', text: 'behind the wheel' }],
    });
    expect(result.data).toMatchObject({
      purpose: 'captions',
      value: {
        sessionId: input.sessionId,
        generation: 4,
        units: [{ unitId: 'g1', revision: 3, text: '掌舵' }],
      },
    });
  });
  it('preparation freezes caption input before later source edits', async () => {
    const processor = localLearningProcessor();
    const input = {
      sessionId: crypto.randomUUID(),
      generation: 1,
      videoId: 'video',
      trackKey: 'track',
      batchId: crypto.randomUUID(),
      sourceLanguage: 'en',
      targetLanguage: 'fr',
      units: [{ unitId: 'g0', revision: 0, text: 'hello' }],
    };
    await processor.prepare({ purpose: 'captions', input }, new AbortController().signal);
    input.generation = 2;
    input.units[0]!.revision = 9;
    expect(
      await processor.finish(
        '{"cues":[{"id":"g0","text":"bonjour"}]}',
        new AbortController().signal,
      ),
    ).toMatchObject({ value: { generation: 1, units: [{ revision: 0 }] } });
    processor.dispose();
  });
  it('cancels during preparation before any paid call and disposes the processor', async () => {
    const processor = localLearningProcessor();
    const dispose = vi.spyOn(processor, 'dispose');
    const control = new AbortController();
    const fetcher = vi.fn<typeof fetch>();
    const operation = executeLearning({ ...request(), signal: control.signal }, fetcher, processor);
    control.abort();
    await expect(operation).rejects.toThrow('CANCELED');
    expect(fetcher).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it('uses the remaining deadline and does not accept a late completion', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const processor = localLearningProcessor();
    const dispose = vi.spyOn(processor, 'dispose');
    const operation = executeLearning(
      { ...request(), deadlineAt: Date.now() + 25 },
      fetcher,
      processor,
    );
    const assertion = expect(operation).rejects.toThrow('TIMEOUT');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(26);
    expect(fetcher.mock.calls[0]![1]!.signal?.aborted).toBe(true);
    finish(response(lookup()));
    await assertion;
    expect(dispose).toHaveBeenCalledOnce();
  });
});
