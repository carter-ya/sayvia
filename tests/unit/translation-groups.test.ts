import { describe, expect, it } from 'vitest';
import {
  createTranslationPlan,
  reconstructTranslation,
  translationPayload,
} from '../../src/core/translation-plan';
import { planResponse } from '../fixtures/plan-response';

const markdown = (text: string) => createTranslationPlan({ kind: 'markdown', text });
function answer(id: string, text: string) {
  return JSON.stringify({ segments: [{ id, text }] });
}

describe('whole-line protected translation context', () => {
  it('allows natural spaces outside emphasis while keeping the original delimiters', () => {
    const plan = markdown('> 这**不是**发布承诺。');
    const segment = plan.segments[0]!;
    const [open, close] = segment.tokens;
    expect(open!.role).toBe('format-open');
    expect(close!.role).toBe('format-close');
    expect(
      reconstructTranslation(
        plan,
        answer(segment.id, `This ${open!.marker}is not${close!.marker} a release commitment.`),
      ),
    ).toBe('> This **is not** a release commitment.');
  });

  it('allows a natural word boundary before a link without sending its destination', () => {
    const plan = markdown('查看[安装说明](https://example.test/?private=SECRET)。');
    expect(plan.segments).toHaveLength(1);
    const segment = plan.segments[0]!;
    const [open, close] = segment.tokens;
    expect(JSON.stringify(translationPayload(plan))).not.toMatch(/SECRET|example.test/);
    expect(
      reconstructTranslation(
        plan,
        answer(segment.id, `See ${open!.marker}the installation instructions${close!.marker}.`),
      ),
    ).toBe('See [the installation instructions](https://example.test/?private=SECRET).');
  });

  it('includes opaque code at the beginning and end of a line', () => {
    for (const [source, leading] of [
      ['`timeout`参数', true],
      ['请使用`timeout`', false],
    ] as const) {
      const plan = markdown(source);
      const segment = plan.segments[0]!;
      expect(segment.tokens).toHaveLength(1);
      expect(JSON.stringify(translationPayload(plan))).not.toContain('timeout');
      const text = leading
        ? `${segment.tokens[0]!.marker} parameter`
        : `Please use ${segment.tokens[0]!.marker}`;
      expect(reconstructTranslation(plan, answer(segment.id, text))).toBe(
        leading ? '`timeout` parameter' : 'Please use `timeout`',
      );
    }
  });

  it('lets a condition move before DOM code without moving or changing the protected identifier', () => {
    const plan = createTranslationPlan({
      kind: 'dom-selection',
      text: 'Read timeout only if the request fails.',
      protectedRanges: [{ kind: 'inline-code', start: 5, end: 12 }],
      marks: [],
    });
    const segment = plan.segments[0]!;
    expect(
      reconstructTranslation(
        plan,
        answer(segment.id, `仅当请求失败时才读取 ${segment.tokens[0]!.marker}。`),
      ),
    ).toBe('仅当请求失败时才读取 timeout。');
  });

  it.each(['missing', 'duplicate', 'reordered', 'unknown'])(
    'rejects %s protection markers',
    (scenario) => {
      const plan = markdown('Read `a` then `b`.');
      const segment = plan.segments[0]!;
      const [a, b] = segment.tokens;
      const invalid = {
        missing: `Read ${a!.marker}.`,
        duplicate: `Read ${a!.marker} ${a!.marker} ${b!.marker}.`,
        reordered: `Read ${b!.marker} then ${a!.marker}.`,
        unknown: `Read ${a!.marker} then ${b!.marker} ${segment.tokenPrefix}unknown⟧.`,
      }[scenario]!;
      expect(() => reconstructTranslation(plan, answer(segment.id, invalid))).toThrow(
        'INVALID_TRANSLATION',
      );
    },
  );

  it('does not interpret a marker-like literal in source as protection metadata', () => {
    const source = 'Keep ⟦SV0:1⟧ near https://example.test';
    const plan = createTranslationPlan({ kind: 'plain-text', text: source });
    expect(plan.segments[0]!.tokenPrefix).toBe('⟦SV1:');
    expect(reconstructTranslation(plan, planResponse(plan))).toBe(source);
  });

  it('preserves CRLF, heading/list prefixes, indentation and line-end spaces', () => {
    const source = '## `name` 标题\r\n\r\n- [ ] 内容`code`  \r\n  next';
    const plan = markdown(source);
    expect(reconstructTranslation(plan, planResponse(plan))).toBe(source);
    expect(plan.segments.every((segment) => !/[\r\n]/.test(segment.text))).toBe(true);
    expect(
      reconstructTranslation(
        plan,
        planResponse(plan, () => 'Translated'),
      ),
    ).toContain('- [ ] Translated`code`  \r\n');
  });

  it('never cuts a multiline protected code range into independent translatable groups', () => {
    const code = 'const a = 1;\n  run(a);';
    const text = `Before ${code} after`;
    const plan = createTranslationPlan({
      kind: 'dom-selection',
      text,
      protectedRanges: [{ kind: 'code-block', start: 7, end: 7 + code.length }],
      marks: [],
    });
    const output = reconstructTranslation(
      plan,
      planResponse(plan, () => '译文'),
    );
    expect(output).toBe(`译文 ${code} 译文`);
    expect(JSON.stringify(translationPayload(plan))).not.toMatch(/const a|run\(a\)/);
  });

  it('still rejects spaces that destroy emphasis semantics and escapes injected HTML', () => {
    const plan = markdown('这**不是**承诺。');
    const segment = plan.segments[0]!;
    const [open, close] = segment.tokens;
    expect(() =>
      reconstructTranslation(
        plan,
        answer(segment.id, `This ${open!.marker} is not ${close!.marker} a promise.`),
      ),
    ).toThrow('FORMAT_CHANGED');
    const valid = reconstructTranslation(
      plan,
      answer(segment.id, `<script> ${open!.marker}is not${close!.marker} a promise.`),
    );
    expect(valid).toContain('\\<script\\>');
  });
});
