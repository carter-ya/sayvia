import { describe, expect, it } from 'vitest';
import { PlanError } from '../../src/core/plan-types';
import {
  createTranslationPlan,
  reconstructTranslation,
  translationPayload,
} from '../../src/core/translation-plan';
import { translate } from '../../src/providers/chat-completions';
import { userError } from '../../src/runtime/user-errors';
import { bitcoinDescription } from '../fixtures/bitcoin-description';

const plan = () => createTranslationPlan({ kind: 'markdown', text: bitcoinDescription });
const candidate = () => translationPayload(plan());
// Synthetic Chinese response: checks the local protocol, not model translation quality.
function chineseCandidate() {
  const payload = candidate();
  payload.segments.forEach((segment) => {
    segment.text = segment.text
      .split(/(⟦SV\d+:\d+⟧)/)
      .map((piece) =>
        /^⟦SV\d+:\d+⟧$/.test(piece) ? piece : piece.trim() ? '比特币相关译文' : piece,
      )
      .join('');
  });
  return JSON.stringify({ segments: payload.segments.map(({ id, text }) => ({ id, text })) });
}
function reason(json: string) {
  try {
    reconstructTranslation(plan(), json);
  } catch (error) {
    expect(error).toBeInstanceOf(PlanError);
    return (error as PlanError).reason;
  }
  throw new Error('Expected invalid response');
}
describe('CoinMarketCap Bitcoin description regression', () => {
  it('retains all seven link targets and three paragraphs with a conforming response', () => {
    const result = reconstructTranslation(plan(), chineseCandidate());
    const links = (text: string) => [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    expect(links(result)).toEqual(links(bitcoinDescription));
    expect(links(result)).toHaveLength(7);
    expect(result.split('\n\n')).toHaveLength(3);
    expect(result).not.toContain('⟦SV');
    expect(JSON.stringify(translationPayload(plan()))).not.toContain('coinmarketcap.com');
  });
  it('differentiates JSON wrapping, missing segments, whitespace, and changed link markers', () => {
    expect(reason('```json\n' + chineseCandidate() + '\n```')).toBe('JSON');
    const missing = JSON.parse(chineseCandidate());
    missing.segments.pop();
    expect(reason(JSON.stringify(missing))).toBe('SEGMENTS');
    const whitespace = JSON.parse(chineseCandidate());
    whitespace.segments[0].text += '\n';
    expect(reason(JSON.stringify(whitespace))).toBe('TEXT');
    expect(reason(chineseCandidate().replace(/⟦SV0:1⟧/, ''))).toBe('TOKENS');
  });
  it('passes a specific failure through the provider boundary without exposing model output', async () => {
    const error = await translate(
      {
        config: { baseUrl: 'https://fixture.test/v1', model: 'fixture', apiKey: 'DUMMY_KEY' },
        source: { kind: 'markdown', text: bitcoinDescription },
        sourceLanguage: 'auto',
        targetLanguage: 'zh-Hans',
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
                  content: chineseCandidate().replace(/⟦SV0:1⟧/, ''),
                },
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        ),
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('FORMAT_INVALID_TOKENS');
    expect(userError(error)).toContain('保护标记');
    expect((error as Error).message).not.toContain('coinmarketcap');
  });
});
