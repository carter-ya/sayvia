import { describe, expect, it, vi } from 'vitest';
import { prepareCompletion, sendCompletion } from '../../src/providers/completion-transport';

const config = { baseUrl: 'https://example.test/v1', model: 'fixture', apiKey: 'DUMMY_LOCAL_KEY' };
const signal = () => new AbortController().signal;
const envelope = (content: string) =>
  new Response(
    JSON.stringify({
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
  );

describe('shared completion transport', () => {
  it('sends a single ordinary JSON request without requiring structured-output support', async () => {
    const payload = { text: '銀行', sourceLanguage: 'ja', explanationLanguage: 'en' };
    const request = prepareCompletion(config, 'trusted lookup instruction', payload, false);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelope('{"value":"bank"}'));
    const result = await sendCompletion(request, signal(), fetcher);
    expect(result).toMatchObject({
      content: '{"value":"bank"}',
      streamed: false,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://example.test/v1/chat/completions');
    expect(options).toMatchObject({
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    expect(JSON.parse(String(options!.body))).toEqual({
      model: 'fixture',
      stream: false,
      messages: [
        { role: 'system', content: 'trusted lookup instruction' },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    });
    expect(request.body).not.toContain(config.apiKey);
  });
  it.each([401, 429, 500])(
    'does not retry a failed HTTP %s request or expose its body',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('sensitive provider message', { status }));
      await expect(
        sendCompletion(prepareCompletion(config, 'prompt', {}), signal(), fetcher),
      ).rejects.toThrow(
        status === 401 ? 'AUTH_FAILED' : status === 429 ? 'RATE_LIMITED' : 'NETWORK_ERROR',
      );
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it('does not issue a request after prior cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(envelope(config.apiKey));
    const controller = new AbortController();
    controller.abort();
    const request = prepareCompletion(config, 'prompt', {});
    await expect(sendCompletion(request, controller.signal, fetcher)).rejects.toThrow('CANCELED');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
