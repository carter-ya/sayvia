import { describe, expect, it, vi } from 'vitest';
import {
  createTranslationPlan,
  translationPayload,
  reconstructTranslation,
} from '../../src/core/translation-plan';
import { previewTranslation } from '../../src/core/translation-preview';
import { translate } from '../../src/providers/chat-completions';
import { bitcoinDescription } from '../fixtures/bitcoin-description';

function partsReply(text: string) {
  const plan = createTranslationPlan({ kind: 'markdown', text });
  const reply = {
    segments: translationPayload(plan).segments.map((segment) => ({
      id: segment.id,
      parts: segment.textParts ?? [segment.text],
    })),
  };
  return { plan, reply };
}
describe('local restoration from translated prose slots', () => {
  it('rebuilds all 7 Bitcoin links without any model-echoed markers or destinations', () => {
    const { plan, reply } = partsReply(bitcoinDescription);
    expect(reply.segments.map((s) => s.parts.length)).toEqual([9, 5, 3]);
    expect(JSON.stringify(reply)).not.toMatch(/⟦SV|coinmarketcap/);
    expect(reconstructTranslation(plan, JSON.stringify(reply))).toBe(bitcoinDescription);
    reply.segments.forEach((segment) => {
      segment.parts = segment.parts.map((part) =>
        part.replaceAll('Bitcoin', '比特币').replace('is a decentralized', '是一种去中心化的'),
      );
    });
    const output = reconstructTranslation(plan, JSON.stringify(reply));
    const links = (value: string) => [...value.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(output).toContain('比特币');
    expect(links(output)).toEqual(links(bitcoinDescription));
    expect(output.split('\n\n')).toHaveLength(3);
  });
  it('allows empty slots and moving a condition before opaque code', () => {
    const { plan } = partsReply('Read `PRIVATE_CODE` only if the request fails.');
    const reply = { segments: [{ id: 's0', parts: ['仅当请求失败时才读取 ', '。'] }] };
    expect(reconstructTranslation(plan, JSON.stringify(reply))).toBe(
      '仅当请求失败时才读取 `PRIVATE_CODE`。',
    );
    expect(
      reconstructTranslation(
        plan,
        JSON.stringify({ segments: [{ id: 's0', parts: ['请读取', ''] }] }),
      ),
    ).toBe('请读取`PRIVATE_CODE`');
  });
  it.each([
    ['short', ['译文']],
    ['long', ['译文', '后文', '额外内容']],
    ['invented marker', ['译文⟦SV0:999⟧', '后文']],
    ['reflected marker', ['译文⟦SV0:1⟧', '后文']],
    ['newline', ['译文\n', '后文']],
    ['no prose', ['', '']],
    ['wrong type', ['译文', 42]],
  ])('rejects %s slots rather than guessing missing content', (_label, parts) => {
    const { plan } = partsReply('Read `code` first.');
    expect(() =>
      reconstructTranslation(plan, JSON.stringify({ segments: [{ id: 's0', parts }] })),
    ).toThrow();
  });
  it('streams partial slots and restores only local code while buffering escapes', () => {
    const { plan } = partsReply('Read `PRIVATE_CODE` first.');
    expect(previewTranslation(plan, '{"segments":[{"id":"s0","parts":["阅读')).toBe('阅读');
    expect(previewTranslation(plan, '{"segments":[{"id":"s0","parts":["阅读 ","优先')).toBe(
      '阅读 `PRIVATE_CODE`优先',
    );
    expect(previewTranslation(plan, '{"segments":[{"id":"s0","parts":["阅读 ","\\u4F')).toBe(
      '阅读 `PRIVATE_CODE`',
    );
    expect(previewTranslation(plan, '{"segments":[{"id":"s0","parts":["坏⟦SV0:1⟧')).toBe('');
    expect(previewTranslation(plan, '{"segments":[{"id":"s0","parts":["一","二","三')).toBe('');
  });
  it('uses one model request and accepts the new protocol with preview and final validation', async () => {
    const progress: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      expect(body.messages[0].content).not.toContain('Copy every marker exactly once');
      const payload = JSON.parse(body.messages[1].content);
      expect(payload.segments[0].textParts).toEqual(['Read ', ' first.']);
      expect(JSON.stringify(payload)).not.toContain('PRIVATE_CODE');
      return new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({ segments: [{ id: 's0', parts: ['阅读 ', ' 优先。'] }] }),
              },
            },
          ],
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    });
    const result = await translate(
      {
        config: { baseUrl: 'https://example.test/v1', model: 'fixture', apiKey: 'DUMMY_KEY' },
        source: { kind: 'markdown', text: 'Read `PRIVATE_CODE` first.' },
        sourceLanguage: 'auto',
        targetLanguage: 'zh-Hans',
        onProgress: (p) => progress.push(p.text),
      },
      fetcher,
    );
    expect(result.text).toBe('阅读 `PRIVATE_CODE` 优先。');
    expect(progress).toContain(result.text);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('accepts slot arrays in an SSE stream and never exposes protocol syntax', async () => {
    const progress: string[] = [];
    const values = [
      {
        choices: [
          {
            index: 0,
            delta: { content: '{"segments":[{"id":"s0","parts":["阅读 ' },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ index: 0, delta: { content: '"," 优先。"]}]}' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    const result = await translate(
      {
        config: { baseUrl: 'https://example.test/v1', model: 'fixture', apiKey: 'DUMMY_KEY' },
        source: { kind: 'markdown', text: 'Read `PRIVATE_CODE` first.' },
        sourceLanguage: 'auto',
        targetLanguage: 'zh-Hans',
        onProgress: (p) => progress.push(p.text),
      },
      async () =>
        new Response(
          values.map((value) => 'data: ' + JSON.stringify(value) + '\n\n').join('') +
            'data: [DONE]\n\n',
          {
            headers: { 'Content-Type': 'text/event-stream' },
          },
        ),
    );
    expect(result.text).toBe('阅读 `PRIVATE_CODE` 优先。');
    expect(result.streamed).toBe(true);
    expect(progress).toContain('阅读 ');
    expect(progress.join('')).not.toMatch(/segments|parts|⟦SV/);
  });
  it('rejects a credential reflected through slots without exposing it in previews', async () => {
    const progress: string[] = [];
    await expect(
      translate(
        {
          config: { baseUrl: 'https://example.test/v1', model: 'fixture', apiKey: 'DUMMY_KEY' },
          source: { kind: 'markdown', text: 'Read `PRIVATE_CODE` first.' },
          sourceLanguage: 'auto',
          targetLanguage: 'zh-Hans',
          onProgress: (p) => progress.push(p.text),
        },
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: {
                    role: 'assistant',
                    content: JSON.stringify({
                      segments: [{ id: 's0', parts: ['DUMMY_KEY', 'text'] }],
                    }),
                  },
                },
              ],
            }),
          ),
      ),
    ).rejects.toThrow('UNSUPPORTED_RESPONSE');
    expect(progress.join('')).not.toContain('DUMMY_KEY');
  });
});
