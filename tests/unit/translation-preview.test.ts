import { describe, expect, it } from 'vitest';
import { createTranslationPlan } from '../../src/core/translation-plan';
import { previewTranslation } from '../../src/core/translation-preview';
const source = { kind: 'markdown' as const, text: 'Read `PRIVATE_CODE` first.\nNext line.' };
describe('uncommitted streaming previews', () => {
  it('decodes incomplete JSON text instead of showing JSON syntax', () => {
    const plan = createTranslationPlan({ kind: 'plain-text', text: 'Hello' });
    expect(previewTranslation(plan, '{"segments":[{"id":"s0","text":"你好')).toBe('你好');
  });
  it('buffers unfinished JSON escapes and surrogate pairs', () => {
    const plan = createTranslationPlan({ kind: 'plain-text', text: 'Hello' });
    const prefix = '{"segments":[{"id":"s0","text":"';
    expect(previewTranslation(plan, prefix + 'A\\u4F')).toBe('A');
    expect(previewTranslation(plan, prefix + 'A\\u4F60')).toBe('A你');
    expect(previewTranslation(plan, prefix + 'A\\uD83D')).toBe('A');
    expect(previewTranslation(plan, prefix + 'A\\uD83D\\uDE00')).toBe('A😀');
  });
  it('restores only complete known markers and stops at an unfinished marker', () => {
    const plan = createTranslationPlan(source),
      marker = plan.segments[0]!.tokens[0]!.marker,
      prefix = '{"segments":[{"id":"s0","text":"';
    for (let i = 1; i < marker.length; i++)
      expect(previewTranslation(plan, prefix + '阅读 ' + marker.slice(0, i))).toBe('阅读 ');
    expect(previewTranslation(plan, prefix + '阅读 ' + marker)).toBe('阅读 `PRIVATE_CODE`');
  });
  it('does not display invented or reordered segments and placeholders', () => {
    const plan = createTranslationPlan(source);
    expect(previewTranslation(plan, '{"segments":[{"id":"s1","text":"wrong')).toBe('');
    expect(previewTranslation(plan, '{"segments":[{"id":"s0","text":"bad ⟦SV0:999⟧')).toBe('');
  });
  it('continues a completed segment using local separators without showing untranslated future prose', () => {
    const plan = createTranslationPlan({ kind: 'plain-text', text: 'First.\nSecond.' });
    expect(
      previewTranslation(plan, '{"segments":[{"id":"s0","text":"第一。"},{"id":"s1","text":"第'),
    ).toBe('第一。\n第');
  });
});
