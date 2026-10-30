import { describe, expect, it } from 'vitest';
import {
  createTranslationPlan,
  needsTranslation,
  reconstructTranslation,
  translationPayload,
} from '../../src/core/translation-plan';

import { planResponse as response } from '../fixtures/plan-response';

const markdown = (text: string) => createTranslationPlan({ kind: 'markdown', text });

describe('source interval translation plans', () => {
  it('keeps plain text syntax literal and ordinary timeout translatable', () => {
    const plan = createTranslationPlan({ kind: 'plain-text', text: '<hello> timeout\n  next' });
    expect(translationPayload(plan)).toEqual({
      segments: [
        { id: 's0', text: '<hello> timeout', protectedTokens: [] },
        { id: 's1', text: 'next', protectedTokens: [] },
      ],
    });
    expect(
      reconstructTranslation(
        plan,
        response(plan, (text) => text.replace('timeout', '超时')),
      ),
    ).toBe('<hello> 超时\n  next');
  });

  it('preserves raw Markdown code, links, escapes, entities and line endings', () => {
    const input =
      '## Read `timeout`\r\n\r\n- [x] See **the guide** [here](https://example.test/?q=SECRET "title") &amp; \\*literal\\*.\r\n';
    const plan = markdown(input);
    const payload = JSON.stringify(translationPayload(plan));
    expect(payload).not.toMatch(/timeout|SECRET|example.test|amp|literal\\\\/);
    expect(reconstructTranslation(plan, response(plan))).toBe(input);
    const translated = reconstructTranslation(
      plan,
      response(plan, () => '译文'),
    );
    expect(translated).toContain('`timeout`');
    expect(translated).toContain('(https://example.test/?q=SECRET "title")');
    expect(translated).toContain('&amp;');
    expect(translated).toContain('\\*译文\\*');
    expect(translated.match(/\r\n/g)).toHaveLength(3);
  });

  it('translates image alt and full reference labels while retaining destinations', () => {
    const plan = markdown(
      '![picture](https://example.test/image.png "title") [guide][id]\n\n[id]: /destination "title"',
    );
    expect(plan.segments).toHaveLength(1);
    expect(translationPayload(plan).segments[0]!.text).toContain('picture');
    expect(translationPayload(plan).segments[0]!.text).toContain('guide');
    expect(
      reconstructTranslation(
        plan,
        response(plan, () => '说明'),
      ),
    ).toBe(
      '![说明](https://example.test/image.png "title") [说明][id]\n\n[id]: /destination "title"',
    );
  });

  it('retains shorthand references whose labels also identify their destinations', () => {
    const input = '[guide][] [guide] ![guide][]\n\n[guide]: /destination';
    const plan = markdown(input);
    expect(needsTranslation(plan)).toBe(false);
    expect(reconstructTranslation(plan, '{"segments":[]}')).toBe(input);
  });

  it('protects nested HTML contents but still translates adjacent natural text', () => {
    const plan = markdown(
      'Before <b>keep <i>INNER_SECRET</i></b> after.\n\n<div>BLOCK_SECRET</div>',
    );
    expect(JSON.stringify(translationPayload(plan))).not.toMatch(/INNER_SECRET|BLOCK_SECRET/);
    expect(
      reconstructTranslation(
        plan,
        response(plan, () => '译文'),
      ),
    ).toBe('译文 <b>keep <i>INNER_SECRET</i></b> 译文\n\n<div>BLOCK_SECRET</div>');
  });

  it('keeps table delimiters, task markers, fenced code and indentation without stringify', () => {
    const input =
      '- [ ] Review\n\n| Left | Right |\n| :--- | ---: |\n| hello | world |\n\n```ts\n  run(1);\n```\n';
    const plan = markdown(input);
    const result = reconstructTranslation(
      plan,
      response(plan, () => '译文'),
    );
    expect(result).toBe(
      '- [ ] 译文\n\n| 译文 | 译文 |\n| :--- | ---: |\n| 译文 | 译文 |\n\n```ts\n  run(1);\n```\n',
    );
    expect(JSON.stringify(translationPayload(plan))).not.toContain('run(1)');
  });

  it('retains URLs, emails, GitHub mentions and references in all sources', () => {
    const input =
      'Ask @carter-ya/team about owner/repo#123 and #42 via user@example.test or https://example.test/a?q=SECRET.\nNext';
    const plan = createTranslationPlan({ kind: 'plain-text', text: input });
    expect(JSON.stringify(translationPayload(plan))).not.toMatch(
      /carter-ya|repo#123|#42|user@|SECRET/,
    );
    const result = reconstructTranslation(
      plan,
      response(plan, () => '译文'),
    );
    expect(result).toContain('@carter-ya/team');
    expect(result).toContain('owner/repo#123');
    expect(result).toContain('user@example.test');
    expect(result).toContain('https://example.test/a?q=SECRET.');
    expect(result).toContain('\n');
  });

  it('uses DOM code metadata and allows the neighboring prose to translate', () => {
    const plan = createTranslationPlan({
      kind: 'dom-selection',
      text: 'Read timeout here.',
      protectedRanges: [{ kind: 'inline-code', start: 5, end: 12 }],
      marks: [],
    });
    expect(JSON.stringify(translationPayload(plan))).not.toContain('timeout');
    expect(
      reconstructTranslation(
        plan,
        response(plan, () => '译文'),
      ),
    ).toBe('译文 timeout 译文');
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.parts)).toBe(true);
    expect(Object.isFrozen(plan.parts[0])).toBe(true);
    expect(() => translationPayload({ ...plan })).toThrow('INVALID_PLAN');
  });

  it('does not call the model for code-only, URL-only or DOM code-only content', () => {
    for (const input of [
      markdown('```js\nrun();\n```'),
      markdown('`timeout`'),
      createTranslationPlan({ kind: 'plain-text', text: 'https://example.test' }),
      createTranslationPlan({
        kind: 'dom-selection',
        text: 'timeout',
        protectedRanges: [{ kind: 'inline-code', start: 0, end: 7 }],
        marks: [],
      }),
    ]) {
      expect(needsTranslation(input)).toBe(false);
      expect(reconstructTranslation(input, '{"segments":[]}')).toBe(input.sourceText);
    }
  });

  it('escapes generated Markdown syntax so output cannot become links, HTML, lists or headings', () => {
    for (const attack of ['<script>alert(1)</script>', '# heading', '- list', '**bold**', '---']) {
      const plan = markdown('Original');
      expect(() =>
        reconstructTranslation(
          plan,
          response(plan, () => attack),
        ),
      ).not.toThrow();
      expect(
        reconstructTranslation(
          plan,
          response(plan, () => attack),
        ),
      ).not.toBe(attack);
    }
  });

  it('keeps ordinary translated punctuation readable without unnecessary escaping', () => {
    const plan = markdown('请保持重试次数。');
    const prose = "Don't change retry-count, please.";
    expect(
      reconstructTranslation(
        plan,
        response(plan, () => prose),
      ),
    ).toBe(prose);
  });

  it('rejects new GFM autolinks even when Markdown punctuation has been escaped', () => {
    const plan = markdown('Original');
    for (const text of [
      '[go](https://evil.test)',
      '![picture](https://evil.test/a)',
      'www.evil.test',
    ]) {
      expect(() =>
        reconstructTranslation(
          plan,
          response(plan, () => text),
        ),
      ).toThrow('FORMAT_CHANGED');
    }
    const original = 'See https://example.test or me@example.test for more.';
    const existing = markdown(original);
    expect(reconstructTranslation(existing, response(existing))).toBe(original);
    expect(JSON.stringify(translationPayload(existing))).not.toContain('example.test');
  });

  it.each([
    'not json',
    '```json\n{"segments":[]}\n```',
    '{"segments":[],"action":"replace"}',
    '{"segments":[{"id":"s0","text":"ok","action":"replace"}]}',
    '{"segments":[]}',
    '{"segments":[{"id":"unknown","text":"ok"}]}',
    '{"segments":[{"id":"s0","text":""}]}',
    '{"segments":[{"id":"s0","text":" padded"}]}',
    '{"segments":[{"id":"s0","text":"new\\nline"}]}',
    '{"segments":[{"id":"s0","text":"\\ud800"}]}',
    '{"segments":[{"id":"s0","text":"one"},{"id":"s0","text":"duplicate"}]}',
  ])('rejects invalid model output without guessing a repair: %s', (json) => {
    expect(() => reconstructTranslation(markdown('Original'), json)).toThrow('INVALID_TRANSLATION');
  });

  it('rejects reordered IDs and output that grows beyond the task limit', () => {
    const plan = markdown('First\nsecond');
    expect(() =>
      reconstructTranslation(
        plan,
        '{"segments":[{"id":"s1","text":"second"},{"id":"s0","text":"first"}]}',
      ),
    ).toThrow('INVALID_TRANSLATION');
    expect(() =>
      reconstructTranslation(
        markdown('Original'),
        response(markdown('Original'), () => 'a'.repeat(24_001)),
      ),
    ).toThrow('OUTPUT_TOO_LONG');
  });
});
