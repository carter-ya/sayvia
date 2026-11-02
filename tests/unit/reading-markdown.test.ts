// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureDomRange } from '../../src/adapters/dom-selection';
import { ReadingSelectionCache } from '../../src/adapters/selection-cache';
import {
  createTranslationPlan,
  needsTranslation,
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
  it('keeps indented preformatted prose eligible for translation', () => {
    const { source } = capture('<pre>    Please translate this note.\n\tKeep this line too.</pre>');
    expect(needsTranslation(createTranslationPlan(source))).toBe(true);
    expect(JSON.stringify(parseMarkdown(source.text))).not.toContain('"type":"code"');
  });
  it('preserves entity-like query values in actual selected destinations', () => {
    const { source } = capture(
      '<p>Read <a href="https://example.test/?x=&amp;copy;">guide</a>.</p>',
    );
    const tree = parseMarkdown(source.text);
    expect(JSON.stringify(tree)).toContain('https://example.test/?x=&copy;');
    expect(JSON.stringify(tree)).not.toContain('©');
  });
  it.each([
    '<p>https://example.test/?x=&amp;copy;</p>',
    '<p><a href="https://example.test/?x=&amp;copy;">https://example.test/?x=&amp;copy;</a></p>',
  ])('preserves entity-like values in visible URL autolinks: %s', (html) => {
    const { source } = capture(html);
    expect(JSON.stringify(parseMarkdown(source.text))).toContain('https://example.test/?x=&copy;');
    expect(JSON.stringify(translationPayload(createTranslationPlan(source)))).not.toContain(
      'example.test',
    );
  });
  it('preserves literal entity-like prose rather than decoding it as HTML', () => {
    const { source } = capture('<p>Keep &amp;copy; as written.</p>');
    expect(JSON.stringify(parseMarkdown(source.text))).toContain('Keep &copy; as written.');
  });
  it('does not let a bare URL consume an adjacent code interval', () => {
    const { source } = capture('<p>Read https://example.test/<code>path with spaces</code>.</p>');
    expect(source.text).toContain('`path with spaces`');
    expect(JSON.stringify(translationPayload(createTranslationPlan(source)))).not.toMatch(
      /path|with spaces/,
    );
  });
  it('does not let a bare URL discard an adjacent anchor target', () => {
    const { source } = capture(
      '<p>Read https://example.test/<a href="https://actual.test/target">guide</a>.</p>',
    );
    expect(source.text).toContain('[guide](<https://actual.test/target>)');
  });
  it.each([
    ['See https://example.test/guide.', 'https://example.test/guide'],
    ['See (https://example.test/wiki/Foo_(bar)).', 'https://example.test/wiki/Foo_(bar)'],
    ['See https://example.test/guide!', 'https://example.test/guide'],
  ])('separates prose punctuation from a bare URL: %s', (text, expected) => {
    const { source } = capture(`<p>${text}</p>`);
    const paragraph = parseMarkdown(source.text).children[0]!;
    const link =
      'children' in paragraph ? paragraph.children.find((node) => node.type === 'link') : undefined;
    expect(link && 'url' in link ? link.url : undefined).toBe(expected);
  });
  it('escapes literal backslashes in selected Markdown link destinations', () => {
    const { source } = capture(
      '<p>Read <a href="https://example.test/?pattern=\\*">guide</a>.</p>',
    );
    const paragraph = parseMarkdown(source.text).children[0]!;
    const link =
      'children' in paragraph ? paragraph.children.find((node) => node.type === 'link') : undefined;
    expect(link && 'url' in link ? link.url : undefined).toBe('https://example.test/?pattern=\\*');
  });
  it.each([
    '<p>Read <code>CODE_FIRST\n\nCODE_SECOND</code> first.</p>',
    '<p>Read <a href="https://example.test/code"><code>CODE_FIRST\n\nCODE_SECOND</code></a> first.</p>',
  ])('keeps multiline code out of model payloads without a pre ancestor: %s', (html) => {
    const { source } = capture(html);
    expect(JSON.stringify(translationPayload(createTranslationPlan(source)))).not.toMatch(
      /CODE_FIRST|CODE_SECOND/,
    );
    expect(JSON.stringify(parseMarkdown(source.text))).toContain('"type":"code"');
  });
  it('preserves link targets on each visible line of a multi-paragraph anchor', () => {
    const { source } = capture(
      '<a href="https://example.test/guide"><p>Read guide</p><p>Next step</p></a>',
    );
    const tree = parseMarkdown(source.text);
    expect(JSON.stringify(tree).match(/"type":"link"/g)).toHaveLength(2);
    expect(JSON.stringify(tree).match(/https:\/\/example.test\/guide/g)).toHaveLength(2);
  });
  it.each(['CODE_LINE\n', 'CODE_LINE\n\n'])('preserves trailing code newlines: %j', (value) => {
    const { source } = capture(`<pre><code>${value}</code></pre>`);
    const node = parseMarkdown(source.text).children.find((node) => node.type === 'code');
    expect(node && 'value' in node ? node.value : undefined).toBe(value);
  });
  it.each(['---', '==='])(
    'keeps literal prose delimiters from becoming Markdown blocks: %s',
    (delimiter) => {
      const { source } = capture(`<pre>Title\n${delimiter}</pre>`);
      expect(JSON.stringify(parseMarkdown(source.text))).not.toMatch(
        /"type":"(?:heading|thematicBreak)"/,
      );
    },
  );
  it.each([
    '<a href="https://example.test/">Read <code>BOUND_SECRET</code></a><code>BOUND_VALUE</code>',
    '<code>BOUND_SECRET</code><a href="https://example.test/"><code>BOUND_VALUE</code> first</a>',
  ])('partitions merged code at link-label boundaries: %s', (html) => {
    const { source } = capture(`<p>${html}</p>`);
    expect(source.text.match(/BOUND_SECRET/g)).toHaveLength(1);
    expect(source.text.match(/BOUND_VALUE/g)).toHaveLength(1);
    expect(source.text).toContain('](<https://example.test/>)');
    expect(JSON.stringify(translationPayload(createTranslationPlan(source)))).not.toMatch(
      /BOUND_SECRET|BOUND_VALUE/,
    );
  });
  it('retains opaque code content across adjacent, nested and multiline link layouts', () => {
    const bodies = [
      'CODESECRET',
      ' CODESECRET ',
      'CODESECRET `CODETAIL`',
      'CODESECRET\nCODETAIL',
      'CODESECRET\n\nCODETAIL',
      'CODESECRET\nCODETAIL\n',
      '\tCODESECRET\t',
    ];
    const layouts = [
      (body: string) => `<p>Read <code>${body}</code> first.</p>`,
      (body: string) => `<p>Read https://example.test/<code>${body}</code>.</p>`,
      (body: string) =>
        `<p><a href="https://example.test/">Read <code>${body}</code></a><code>CODEVALUE</code></p>`,
      (body: string) =>
        `<p><code>CODEVALUE</code><a href="https://example.test/"><code>${body}</code> first</a></p>`,
      (body: string) => `<code><a href="https://example.test/">${body}</a></code>`,
      (body: string) =>
        `<a href="https://example.test/"><code>${body}</code></a><a href="https://other.test/"><code>CODEVALUE</code></a>`,
    ];
    for (const body of bodies)
      for (const layout of layouts) {
        const { source } = capture(layout(body));
        const range = document.createRange();
        range.selectNodeContents(document.body);
        const flat = captureDomRange(range);
        const expected = flat.protectedRanges
          .map((span) => flat.text.slice(span.start, span.end))
          .join('');
        const values: string[] = [];
        const walk = (node: unknown) => {
          const item = node as { type: string; value?: string; children?: unknown[] };
          if (item.type === 'code' || item.type === 'inlineCode') values.push(item.value!);
          for (const child of item.children ?? []) walk(child);
        };
        walk(parseMarkdown(source.text));
        expect(values.join(''), layout(body)).toBe(expected);
        expect(
          JSON.stringify(translationPayload(createTranslationPlan(source))),
          layout(body),
        ).not.toMatch(/CODESECRET|CODETAIL|CODEVALUE/);
      }
  });
  it('retains literal exclamation marks immediately before selected links', () => {
    const { source } = capture(
      '<p>Read !<a href="https://example.test/guide">guide</a> first.</p>',
    );
    const tree = parseMarkdown(source.text);
    expect(JSON.stringify(tree)).not.toContain('"type":"image"');
    expect(JSON.stringify(tree)).toContain('"type":"link"');
    expect(JSON.stringify(tree)).toContain('Read !');
  });
  it.each(['#', '###', '+', '1.', '2)'])(
    'keeps standalone Markdown block markers literal: %s',
    (value) => {
      const { source } = capture(`<p>${value}</p>`);
      const tree = parseMarkdown(source.text);
      expect(tree.children[0]?.type).toBe('paragraph');
      const first = tree.children[0];
      expect(
        first && 'children' in first
          ? first.children.map((child) => ('value' in child ? child.value : '')).join('')
          : '',
      ).toBe(value);
    },
  );
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
