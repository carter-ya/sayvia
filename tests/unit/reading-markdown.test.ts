// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadingSelectionCache } from '../../src/adapters/selection-cache';
import {
  createTranslationPlan,
  reconstructTranslation,
  translationPayload,
} from '../../src/core/translation-plan';
import { parseMarkdown } from '../../src/core/markdown';
import { planResponse } from '../fixtures/plan-response';
import { parseSourceInput } from '../../src/core/source-input';

function capture(html: string) {
  document.body.innerHTML = html;
  const range = document.createRange();
  range.selectNodeContents(document.body);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const cache = new ReadingSelectionCache(true);
  return { cache, source: cache.capture(selection, document) };
}
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

describe('formatted reading selections', () => {
  it('retains paragraph, inline code and selected link destinations entirely locally', () => {
    const { source } = capture(
      '<p>Fix <code>%.3g</code> of <code>999.9</code>.</p><p>Stack: <a href="https://github.com/exc-works/decimal/pull/8">#8</a> → <a href="https://github.com/exc-works/decimal/pull/9">#9</a>.</p>',
    );
    expect(source.format).toBe('markdown');
    expect(source.text).toBe(
      'Fix `%.3g` of `999.9`.\n\nStack: [#8](<https://github.com/exc-works/decimal/pull/8>) → [#9](<https://github.com/exc-works/decimal/pull/9>).',
    );
    const plan = createTranslationPlan(source);
    expect(JSON.stringify(translationPayload(plan))).not.toMatch(/github.com|%.3g|999.9/);
    expect(
      reconstructTranslation(
        plan,
        planResponse(plan, (text) => text.replace('Fix', '修复').replace('Stack', '堆栈')),
      ),
    ).toContain('[#8](<https://github.com/exc-works/decimal/pull/8>)');
  });
  it('retains a hyperlink whose visible label is itself inline code', () => {
    const { source } = capture(
      '<p>Read <a href="https://example.test/guide"><code>timeout</code></a> first.</p>',
    );
    expect(source.text).toBe('Read [`timeout`](<https://example.test/guide>) first.');
    expect(JSON.stringify(translationPayload(createTranslationPlan(source)))).not.toMatch(
      /timeout|example.test/,
    );
  });
  it('clips partial code and link labels and freezes their target before activation', () => {
    document.body.innerHTML =
      '<p><code>999.9</code> <a href="https://example.test/target">documentation</a></p>';
    const range = document.createRange();
    range.setStart(document.querySelector('code')!.firstChild!, 1);
    range.setEnd(document.querySelector('a')!.firstChild!, 3);
    const selected = window.getSelection()!;
    selected.removeAllRanges();
    selected.addRange(range);
    const cache = new ReadingSelectionCache(true);
    const source = cache.capture(selected, document);
    expect(source.text).toBe('`99.9` [doc](<https://example.test/target>)');
    document.querySelector('a')!.setAttribute('href', 'https://other.test/new');
    expect(() => cache.read(document)).toThrow('SELECTION_LOST');
  });
  it('keeps prose preformatted notes translatable and bare URLs out of model payloads', () => {
    const { source } = capture(
      '<pre class="note">To which function JSON_* are you referring?\nhttps://dev.mysql.com/doc/refman/8.4/en/json-function-reference.html</pre>',
    );
    const plan = createTranslationPlan(source);
    expect(plan.segments.length).toBeGreaterThan(0);
    expect(JSON.stringify(translationPayload(plan))).not.toContain('dev.mysql.com');
    expect(reconstructTranslation(plan, planResponse(plan))).toBe(source.text);
  });
  it('escapes literal Markdown-looking prose instead of inventing code, HTML or emphasis', () => {
    const { source } = capture('<p>*literal* &lt;script&gt; [label] #8</p>');
    const tree = parseMarkdown(source.text);
    expect(JSON.stringify(tree)).not.toMatch(/"type":"(?:html|emphasis|strong|link)"/);
    expect(source.text).toContain('\\*literal\\*');
  });
  it('keeps code fences and backticks round-trippable without exposing source code', () => {
    const { source } = capture(
      '<p>Before <code>use `name`</code>.</p><pre><code>const n = 3;\n  run(n);</code></pre><p>After</p>',
    );
    const plan = createTranslationPlan(source);
    expect(JSON.stringify(translationPayload(plan))).not.toMatch(/name|const n|run\(n\)/);
    expect(reconstructTranslation(plan, planResponse(plan))).toBe(source.text);
    expect(JSON.stringify(parseMarkdown(source.text))).toContain('inlineCode');
  });
  it.each(['javascript:alert(1)', 'data:text/html,secret', 'https://user:pass@example.test/'])(
    'renders unsafe selected href as a plain label: %s',
    (href) => {
      const { source } = capture(`<p>Read <a href="${href}">guide</a>.</p>`);
      expect(source.text).toBe('Read guide.');
    },
  );
  it('does not read unselected or hidden link destinations', () => {
    document.body.innerHTML =
      '<p id="selected">Read <span hidden><a href="https://hidden.test/private">SECRET</a></span><a href="https://example.test/guide">guide</a>.</p><a id="outside" href="https://outside.test/private">OUTSIDE</a>';
    const outside = vi.spyOn(document.getElementById('outside')!, 'getAttribute');
    const hidden = vi.spyOn(document.querySelector('[hidden] a')!, 'getAttribute');
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('selected')!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const source = new ReadingSelectionCache(true).capture(selection, document);
    expect(source.text).toBe('Read [guide](<https://example.test/guide>).');
    expect(outside).not.toHaveBeenCalled();
    expect(hidden).not.toHaveBeenCalled();
  });
  it('rejects formatted input mixed with contradictory flat semantic intervals', () => {
    expect(() =>
      parseSourceInput({
        kind: 'dom-selection',
        format: 'markdown',
        text: 'Read `code`',
        protectedRanges: [{ kind: 'inline-code', start: 0, end: 4 }],
        marks: [],
      }),
    ).toThrow('INVALID_SOURCE');
  });
});
