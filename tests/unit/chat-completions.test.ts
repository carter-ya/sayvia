import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { chatCompletionsEndpoint, normalizeBaseUrl } from '../../src/providers/endpoint';
import { translate, MAX_RESPONSE_BYTES } from '../../src/providers/chat-completions';

const config = {
  baseUrl: 'https://example.test/gateway/v1/',
  model: 'explicit-test-model',
  apiKey: 'DUMMY_TEST_KEY',
};
const request = () => ({
  config,
  source: { kind: 'plain-text' as const, text: '你好' },
  sourceLanguage: 'auto',
  targetLanguage: 'en',
});
function completion(content = '{"segments":[{"id":"s0","text":"Hello"}]}') {
  return {
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  };
}
const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
afterEach(() => {
  vi.useRealTimers();
});

describe('configured Chat Completions endpoints', () => {
  it.each([
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1/chat/completions'],
    ['https://api.deepseek.com', 'https://api.deepseek.com/chat/completions'],
    ['https://EXAMPLE.test/gateway/v1///', 'https://example.test/gateway/v1/chat/completions'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1/chat/completions'],
    ['http://127.0.0.1:8000/prefix', 'http://127.0.0.1:8000/prefix/chat/completions'],
  ])('preserves the configured path prefix: %s', (input, expected) => {
    expect(chatCompletionsEndpoint(input)).toBe(expected);
    expect(normalizeBaseUrl(normalizeBaseUrl(input))).toBe(normalizeBaseUrl(input));
  });
  it.each([
    'http://example.test/v1',
    'ftp://example.test',
    'https://user:pass@example.test',
    'https://example.test/?key=SECRET',
    'https://example.test/#fragment',
    'https://example.test/?',
    'https://example.test/#',
    'https://example.test/v1/chat/completions',
    'https://example.test/chat%2Fcompletions/',
    'http://[::1]:8000',
    'not a URL',
    'https://example.test/\npath',
    'https://example.test/%invalid',
  ])('rejects an unsafe or complete endpoint: %s', (value) => {
    expect(() => normalizeBaseUrl(value)).toThrow('INVALID_ENDPOINT');
  });
});

describe('single-request translation protocol', () => {
  it('sends minimum fields and an opaque protected placeholder, then rebuilds locally', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const payload = JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
      return jsonResponse(
        completion(
          JSON.stringify({
            segments: [
              { id: 's0', text: `Hello ${payload.segments[0].protectedTokens[0].marker}` },
            ],
          }),
        ),
      );
    });
    const input = {
      ...request(),
      source: { kind: 'markdown' as const, text: '你好 `CODE_SECRET`' },
    };
    const result = await translate(input, fetcher);
    expect(result.text).toBe('Hello `CODE_SECRET`');
    expect(result.requested).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://example.test/gateway/v1/chat/completions');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { Authorization: 'Bearer DUMMY_TEST_KEY' },
    });
    const body = JSON.parse(String(init!.body));
    expect(Object.keys(body).sort()).toEqual(['messages', 'model', 'stream']);
    expect(body.stream).toBe(false);
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
      'system',
      'user',
    ]);
    expect(String(init!.body)).not.toContain('CODE_SECRET');
    expect(String(init!.body)).not.toContain('DUMMY_TEST_KEY');
    expect(body.messages[0].content).not.toContain('你好');
  });

  it('does not return a successful compatible-server response that echoes its credential', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(completion('{"segments":[{"id":"s0","text":"DUMMY_TEST_KEY"}]}')),
      );
    await expect(translate(request(), fetcher)).rejects.toThrow('UNSUPPORTED_RESPONSE');
  });

  it('skips protected-only input and never contacts the service', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await translate(
      { ...request(), source: { kind: 'markdown', text: '`timeout`' } },
      fetcher,
    );
    expect(result.text).toBe('`timeout`');
    expect(result.requested).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['length', 'content_filter', 'tool_calls', 'function_call', 'unknown', null])(
    'rejects incomplete finish reason: %s',
    async (reason) => {
      const value = completion();
      Object.assign(value.choices[0]!, { finish_reason: reason });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(value));
      await expect(translate(request(), fetcher)).rejects.toThrow('UNSUPPORTED_RESPONSE');
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { refusal: 'PRIVATE_REFUSAL' },
    { tool_calls: [{ function: { name: 'submit' } }] },
    { content: null },
    { content: [{ type: 'text', text: 'hello' }] },
    { content: '   ' },
    { role: 'user' },
  ])('rejects refusal, tools, empty or non-text output', async (patch) => {
    const value = completion();
    Object.assign(value.choices[0]!.message, patch);
    await expect(
      translate(request(), vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(value))),
    ).rejects.toThrow('UNSUPPORTED_RESPONSE');
  });

  it('ignores reasoning text and rejects malformed translation JSON', async () => {
    const value = completion('not json');
    Object.assign(value.choices[0]!.message, {
      reasoning_content: '{"segments":[{"id":"s0","text":"SECRET_REASONING"}]}',
    });
    await expect(
      translate(request(), vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(value))),
    ).rejects.toThrow('FORMAT_INVALID');
    await expect(
      translate(request(), vi.fn<typeof fetch>().mockResolvedValue(new Response('NOT_JSON'))),
    ).rejects.toThrow('UNSUPPORTED_RESPONSE');
  });

  it.each([
    [401, 'AUTH_FAILED'],
    [403, 'AUTH_FAILED'],
    [402, 'QUOTA_EXCEEDED'],
    [404, 'MODEL_UNAVAILABLE'],
    [429, 'RATE_LIMITED'],
    [500, 'NETWORK_ERROR'],
  ])('maps HTTP %s without retaining response text or retrying', async (status, code) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('PRIVATE_RESPONSE DUMMY_TEST_KEY', { status: Number(status) }),
      );
    await expect(translate(request(), fetcher)).rejects.toThrow(String(code));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('distinguishes a quota error using only allowlisted error codes', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ error: { code: 'insufficient_quota', message: 'PRIVATE_RESPONSE' } }, 429),
      );
    await expect(translate(request(), fetcher)).rejects.toThrow('QUOTA_EXCEEDED');
  });

  it('cancels a response as soon as its decoded byte stream exceeds 1 MiB', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        canceled = true;
      },
    });
    await expect(
      translate(request(), vi.fn<typeof fetch>().mockResolvedValue(new Response(stream))),
    ).rejects.toThrow('UNSUPPORTED_RESPONSE');
    expect(canceled).toBe(true);
  });

  it('rejects broken UTF-8 and empty choices', async () => {
    await expect(
      translate(
        request(),
        vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([0xff]))),
      ),
    ).rejects.toThrow('UNSUPPORTED_RESPONSE');
    await expect(
      translate(request(), vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ choices: [] }))),
    ).rejects.toThrow('UNSUPPORTED_RESPONSE');
  });

  it('honors cancellation before and during a request and releases timeout resources', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const untouched = vi.fn<typeof fetch>();
    await expect(translate({ ...request(), signal: controller.signal }, untouched)).rejects.toThrow(
      'CANCELED',
    );
    expect(untouched).not.toHaveBeenCalled();
    const active = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('PRIVATE_ABORT')), {
            once: true,
          });
        }),
    );
    const result = translate({ ...request(), signal: active.signal }, fetcher);
    const assertion = expect(result).rejects.toThrow('CANCELED');
    active.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses a total 60 second deadline and never retries a timeout', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('PRIVATE_TIMEOUT')), {
            once: true,
          });
        }),
    );
    const result = translate(request(), fetcher);
    const assertion = expect(result).rejects.toThrow('TIMEOUT');
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await expect(translate({ ...request(), deadlineAt: Date.now() - 1 }, fetcher)).rejects.toThrow(
      'TIMEOUT',
    );
  });

  it('rejects invalid config before contacting a host and sanitizes arbitrary fetch errors', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('DUMMY_TEST_KEY https://private.test'));
    await expect(
      translate({ ...request(), config: { ...config, baseUrl: 'http://remote.test' } }, fetcher),
    ).rejects.toThrow('CONFIG_REQUIRED');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(translate(request(), fetcher)).rejects.toThrow(/^NETWORK_ERROR$/);
  });

  it('real fetch refuses redirects without contacting the destination', async () => {
    let redirects = 0;
    let destination = 0;
    const server = createServer((req, res) => {
      if (req.url === '/v1/chat/completions') {
        redirects += 1;
        res.writeHead(307, { Location: '/destination' });
        res.end();
      } else {
        destination += 1;
        res.end('unexpected');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture unavailable');
      await expect(
        translate({
          ...request(),
          config: { ...config, baseUrl: `http://127.0.0.1:${address.port}/v1` },
        }),
      ).rejects.toThrow('NETWORK_ERROR');
      expect(redirects).toBe(1);
      expect(destination).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
