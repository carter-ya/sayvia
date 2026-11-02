import { describe, expect, it } from 'vitest';
import { readCompletionStream, tokenUsage } from '../../src/providers/completion-stream';
import { translate } from '../../src/providers/chat-completions';
import type { TranslationProgress } from '../../src/runtime/translation-progress';
const event = (delta: unknown = {}, finish_reason: unknown = null, usage?: unknown) => ({
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason }],
  ...(usage ? { usage } : {}),
});
const frame = (value: unknown) =>
  'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
const config = {
  baseUrl: 'https://example.test/v1',
  model: 'fixture-stream',
  apiKey: 'DUMMY_SECRET_KEY',
};
function response(values: unknown[], bytewise = false, delay = 0) {
  const parts = bytewise
    ? [...new TextEncoder().encode(values.map(frame).join(''))].map(
        (byte) => new Uint8Array([byte]),
      )
    : values.map((value) => new TextEncoder().encode(frame(value)));
  const timers: ReturnType<typeof setTimeout>[] = [];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        parts.forEach((part, index) => {
          if (delay) timers.push(setTimeout(() => controller.enqueue(part), index * delay));
          else controller.enqueue(part);
        });
        if (delay) timers.push(setTimeout(() => controller.close(), parts.length * delay));
        else controller.close();
      },
      cancel() {
        timers.forEach(clearTimeout);
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
const usage = {
  prompt_tokens: 12,
  completion_tokens: 18,
  total_tokens: 30,
  completion_tokens_details: { reasoning_tokens: 10 },
};
describe('bounded completion SSE', () => {
  it('decodes UTF-8 split at arbitrary bytes and OpenAI usage-only final events', async () => {
    const result = await readCompletionStream(
      response(
        [event({ content: '你好 😀' }), event({}, 'stop'), { choices: [], usage }, '[DONE]'],
        true,
      ),
      1024 * 1024,
      async () => {},
    );
    expect(result.content).toBe('你好 😀');
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 18,
      totalTokens: 30,
      reasoningTokens: 10,
    });
  });
  it('reads DeepSeek usage on its finishing choice', async () => {
    const result = await readCompletionStream(
      response([event({ content: 'Hello' }), event({}, 'stop', usage), '[DONE]']),
      1024 * 1024,
      async () => {},
    );
    expect(result.usage?.totalTokens).toBe(30);
  });
  it('allows heartbeat comments and CRLF framing', async () => {
    const body =
      ': heartbeat\r\n\r\n' +
      [event({ content: 'Hello' }), event({}, 'stop'), '[DONE]']
        .map(frame)
        .join('')
        .replace(/\n/g, '\r\n');
    const r = await readCompletionStream(new Response(body), 1024 * 1024, async () => {});
    expect(r.content).toBe('Hello');
  });
  it.each([
    [event({ content: 'Hello' }), event({}, 'length'), '[DONE]'],
    [event({ content: 'Hello' }), event({}, 'stop')],
    [event({ content: 'Hello' }), '[DONE]'],
    [event({ content: 'Hello' }), event({}, 'stop'), event({ content: 'extra' }), '[DONE]'],
    [event({ tool_calls: [{}] }), '[DONE]'],
    [event({ refusal: 'no' }), '[DONE]'],
    [{ choices: [{ index: 1, delta: { content: 'bad' }, finish_reason: 'stop' }] }, '[DONE]'],
    [{ choices: [], usage }, '[DONE]'],
  ])('rejects malformed/incomplete streams %j', async (...values: unknown[]) => {
    await expect(
      readCompletionStream(response(values), 1024 * 1024, async () => {}),
    ).rejects.toThrow();
  });
  it('enforces a byte limit including stream framing', async () => {
    await expect(
      readCompletionStream(
        response([event({ content: 'x'.repeat(200) }), event({}, 'stop'), '[DONE]']),
        50,
        async () => {},
      ),
    ).rejects.toThrow();
  });
  it('keeps missing/invalid usage unknown instead of inventing zero', () => {
    expect(tokenUsage(null)).toBeUndefined();
    expect(tokenUsage({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 8 })).toBeUndefined();
  });
});
describe('provider streaming protocol', () => {
  it('publishes text before completion and validates the final result normally', async () => {
    const progress: TranslationProgress[] = [];
    let finished = false;
    const promise = translate(
      {
        config,
        source: { kind: 'plain-text', text: '你好' },
        sourceLanguage: 'auto',
        targetLanguage: 'en',
        onProgress: (p) => {
          progress.push(p);
          if (p.text === 'Hel') expect(finished).toBe(false);
        },
      },
      async () =>
        response(
          [
            event({ content: '{"segments":[{"id":"s0","text":"H' }),
            event({ content: 'el' }),
            event({ content: 'lo"}]}' }),
            event({}, 'stop', usage),
            '[DONE]',
          ],
          false,
          90,
        ),
    );
    const result = await promise;
    finished = true;
    expect(progress.some((p) => p.text === 'Hel')).toBe(true);
    expect(result.text).toBe('Hello');
    expect(result.streamed).toBe(true);
    expect(result.usage?.totalTokens).toBe(30);
    expect(progress[0]!.phase).toBe('connecting');
  });
  it('counts reasoning activity without exposing its content', async () => {
    const progress: TranslationProgress[] = [];
    await translate(
      {
        config,
        source: { kind: 'plain-text', text: '你好' },
        sourceLanguage: 'auto',
        targetLanguage: 'en',
        onProgress: (p) => progress.push(p),
      },
      async () =>
        response(
          [
            event({ reasoning_content: 'PRIVATE_REASONING' }),
            event({ reasoning_content: 'MORE_PRIVATE_REASONING' }),
            event({ content: '{"segments":[{"id":"s0","text":"Hello"}]}' }),
            event({}, 'stop', usage),
            '[DONE]',
          ],
          false,
          90,
        ),
    );
    expect(JSON.stringify(progress)).not.toContain('PRIVATE_REASONING');
    expect(progress.some((p) => p.phase === 'thinking' && p.estimates.outputTokens > 0)).toBe(true);
  });
  it('withholds API-key prefixes across chunks and rejects a completed reflected key', async () => {
    const progress: TranslationProgress[] = [];
    await expect(
      translate(
        {
          config,
          source: { kind: 'plain-text', text: '你好' },
          sourceLanguage: 'auto',
          targetLanguage: 'en',
          onProgress: (p) => progress.push(p),
        },
        async () =>
          response(
            [
              event({ content: '{"segments":[{"id":"s0","text":"Hello ' }),
              event({ content: 'DUMMY_SECRET' }),
              event({ content: '_KEY"}]}' }),
              event({}, 'stop'),
              '[DONE]',
            ],
            false,
            90,
          ),
      ),
    ).rejects.toThrow('UNSUPPORTED_RESPONSE');
    expect(JSON.stringify(progress)).not.toContain('DUMMY_SECRET');
  });
  it('does not make partial output usable when final format validation fails', async () => {
    await expect(
      translate(
        {
          config,
          source: { kind: 'plain-text', text: '你好' },
          sourceLanguage: 'auto',
          targetLanguage: 'en',
        },
        async () =>
          response([
            event({ content: '{"segments":[{"id":"wrong","text":"Hello"}]}' }),
            event({}, 'stop'),
            '[DONE]',
          ]),
      ),
    ).rejects.toThrow('FORMAT_INVALID');
  });
});
