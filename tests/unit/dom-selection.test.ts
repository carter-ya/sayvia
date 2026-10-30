// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureDomRange, captureDomSelection } from '../../src/adapters/dom-selection';
import { ReadingSelectionCache } from '../../src/adapters/selection-cache';

function fixture(html: string) {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}
function contents(element: Node) {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range;
}
function selected(range: Range) {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}
afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

describe('DOM selection semantics', () => {
  it('keeps rendered inline code even though the selected string has no backticks', () => {
    const root = fixture('<p>Read <code>timeout</code> first.</p>');
    const source = captureDomRange(contents(root));
    expect(source.text).toBe('Read timeout first.');
    expect(source.protectedRanges).toEqual([{ kind: 'inline-code', start: 5, end: 12 }]);
  });

  it('clips a selection fully inside a code text node', () => {
    const root = fixture('<p>Outside <code>timeout</code> outside</p>');
    const text = root.querySelector('code')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 5);
    expect(captureDomRange(range)).toEqual({
      kind: 'dom-selection',
      text: 'meo',
      protectedRanges: [{ kind: 'inline-code', start: 0, end: 3 }],
      marks: [],
    });
  });

  it('merges code split over nested spans without copying surrounding text', () => {
    const root = fixture('<p>OUTSIDE <code><span>time</span><b>out</b></code> OUTSIDE</p>');
    const range = document.createRange();
    range.setStart(root.querySelector('span')!.firstChild!, 1);
    range.setEnd(root.querySelector('b')!.firstChild!, 2);
    const source = captureDomRange(range);
    expect(source.text).toBe('imeou');
    expect(source.protectedRanges).toEqual([{ kind: 'inline-code', start: 0, end: 5 }]);
  });

  it('preserves code block spaces, indentation and newlines', () => {
    const root = fixture(
      '<p>Before</p><pre><code>const a = 1;\n  run(a);</code></pre><p>After</p>',
    );
    const source = captureDomRange(contents(root));
    expect(source.text).toBe('Before\nconst a = 1;\n  run(a);\nAfter');
    const code = source.protectedRanges[0]!;
    expect(code.kind).toBe('code-block');
    expect(source.text.slice(code.start, code.end)).toBe('const a = 1;\n  run(a);');
  });

  it('captures cross-link label fragments without reading the hidden destination', () => {
    const root = fixture(
      '<p>Read <a href="https://private.example/?token=SECRET">documentation</a> today.</p>',
    );
    const link = root.querySelector('a')!;
    const read = vi.spyOn(link, 'getAttribute');
    read.mockImplementation((name) => {
      if (name === 'href') throw new Error('href was read');
      return null;
    });
    const range = document.createRange();
    range.setStart(root.querySelector('p')!.firstChild!, 2);
    range.setEnd(link.firstChild!, 5);
    const source = captureDomRange(range);
    expect(source.text).toBe('ad docum');
    expect(source.marks.some((mark) => mark.kind === 'link-label')).toBe(true);
    expect(JSON.stringify(source)).not.toContain('private.example');
    expect(JSON.stringify(source)).not.toContain('SECRET');
  });

  it('marks a link selection whose common ancestor is only a text node', () => {
    const root = fixture('<p><a href="/hidden">documentation</a></p>');
    const text = root.querySelector('a')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 4);
    const source = captureDomRange(range);
    expect(source.text).toBe('docu');
    expect(source.marks).toContainEqual({ kind: 'link-label', start: 0, end: 4 });
  });

  it('does not include nodes outside element boundary offsets', () => {
    const root = fixture('<p>BEFORE <code>timeout</code> AFTER</p>');
    const paragraph = root.querySelector('p')!;
    const range = document.createRange();
    range.setStart(paragraph, 1);
    range.setEnd(paragraph, 2);
    expect(captureDomRange(range).text).toBe('timeout');
  });

  it('excludes hidden content, executable markup and sensitive form values', () => {
    const root = fixture(
      '<p>visible<span hidden>HIDDEN</span><span style="display:none">CSS_HIDDEN</span><script>SCRIPT_SECRET</script><style>.x{}</style><textarea>FORM_SECRET</textarea><span data-sayvia-ui>PLUGIN</span><br style="visibility:hidden"> end</p>',
    );
    const source = captureDomRange(contents(root));
    expect(source.text).toBe('visible end');
    expect(JSON.stringify(source)).not.toMatch(/SECRET|HIDDEN|PLUGIN/);
  });

  it('allows visible descendants that explicitly override inherited visibility', () => {
    const root = fixture(
      '<p style="visibility:hidden">HIDDEN <span style="visibility:visible">visible</span></p>',
    );
    expect(captureDomRange(contents(root)).text).toBe('visible');
  });

  it('preserves explicit breaks and CSS pre-wrapped natural language', () => {
    const root = fixture(
      '<p>first<br>second</p><div style="white-space:pre-wrap">third\n  fourth</div>',
    );
    const source = captureDomRange(contents(root));
    expect(source.text).toBe('first\nsecond\nthird\n  fourth');
    expect(source.marks.filter((mark) => mark.kind === 'line-break')).toHaveLength(3);
  });

  it('ignores HTML indentation while keeping spaces between inline nodes and their offsets', () => {
    const root = fixture(
      '<p>\n  Read <code>timeout</code> using\n  <a href="/hidden">the docs</a> now.\n</p>\n<p>Next </p>',
    );
    const source = captureDomRange(contents(root));
    expect(source.text).toBe('Read timeout using the docs now.\nNext');
    expect(source.protectedRanges).toEqual([{ kind: 'inline-code', start: 5, end: 12 }]);
    expect(source.marks).toContainEqual({ kind: 'link-label', start: 19, end: 27 });
    const inline = fixture('<p>A <b>bold</b>word <em>then</em> end<br>next</p>');
    expect(captureDomRange(contents(inline)).text).toBe('A boldword then end\nnext');
  });

  it('omits a closed disclosure body, direct text and non-rendered extra summaries', () => {
    const root = fixture(
      '<p>Before</p><details><summary>Visible <code>name</code></summary>DIRECT_SECRET<p>BODY_SECRET</p><summary>EXTRA_SECRET</summary></details><p>After</p>',
    );
    const source = captureDomRange(contents(root));
    expect(source.text).toBe('Before\nVisible name\nAfter');
    expect(JSON.stringify(source)).not.toContain('SECRET');
    const hidden = root.querySelector('details p')!;
    expect(() => captureDomRange(contents(hidden))).toThrow('EMPTY_SOURCE');
    root.querySelector('details')!.open = true;
    expect(captureDomRange(contents(root)).text).toContain('BODY_SECRET');
  });

  it('checks collapsed ancestors even inside an otherwise open disclosure', () => {
    const root = fixture(
      '<details><summary>Outer</summary><details open><summary>INNER_SECRET</summary>BODY_SECRET</details></details>',
    );
    expect(captureDomRange(contents(root)).text).toBe('Outer');
  });

  it.each([
    ['<dl><dt>Term</dt><dd>Definition</dd></dl>', 'Term\nDefinition'],
    [
      '<span style="display:block">First</span><span style="display:block">Second</span>',
      'First\nSecond',
    ],
    [
      '<div style="display:inline">First</div><div style="display:inline">Second</div>',
      'FirstSecond',
    ],
  ])('uses computed block layout for %s', (html, expected) => {
    expect(captureDomRange(contents(fixture(html))).text).toBe(expected);
  });

  it('excludes content-visibility-hidden descendants from a spanning selection', () => {
    const root = fixture(
      '<p>Before</p><div style="content-visibility:hidden"><span>CONCEALED</span></div><p>After</p>',
    );
    expect(captureDomRange(contents(root)).text).toBe('Before\nAfter');
  });

  it.each([
    ['<span>Hello</span>&nbsp;&nbsp;<code>timeout</code>', 'Hello\u00a0\u00a0timeout', 7],
    ['中文<span>　</span><code>timeout</code>', '中文\u3000timeout', 3],
  ])('preserves non-collapsible Unicode whitespace and source offsets', (html, text, start) => {
    const source = captureDomRange(contents(fixture(String(html))));
    expect(source.text).toBe(text);
    expect(source.protectedRanges).toEqual([
      { kind: 'inline-code', start, end: Number(start) + 7 },
    ]);
  });

  it('keeps UTF-16 offsets correct after emoji', () => {
    const root = fixture('<p>🙂 <code>timeout</code></p>');
    const source = captureDomRange(contents(root));
    expect(source.protectedRanges[0]).toEqual({ kind: 'inline-code', start: 3, end: 10 });
  });

  it('refuses empty, detached, shadow-root and multiple-range selections', () => {
    const root = fixture('<p>text</p>');
    const collapsed = document.createRange();
    collapsed.setStart(root, 0);
    expect(() => captureDomRange(collapsed)).toThrow('EMPTY_SOURCE');
    const other = document.createElement('p');
    other.textContent = 'detached';
    expect(() => captureDomRange(contents(other))).toThrow('UNSUPPORTED_SELECTION');
    const shadow = root.attachShadow({ mode: 'open' });
    shadow.textContent = 'shadow';
    expect(() => captureDomRange(contents(shadow.firstChild!))).toThrow('UNSUPPORTED_SELECTION');
    expect(() => captureDomSelection({ rangeCount: 2 } as Selection)).toThrow(
      'UNSUPPORTED_SELECTION',
    );
  });

  it('fails over-length or overly deep selections instead of truncating', () => {
    const root = fixture('<p>' + 'a'.repeat(12_001) + '</p>');
    expect(() => captureDomRange(contents(root))).toThrow('SOURCE_TOO_LONG');
    root.innerHTML = '<span>'.repeat(270) + 'text' + '</span>'.repeat(270);
    expect(() => captureDomRange(contents(root))).toThrow('SELECTION_TOO_COMPLEX');
  });
});

describe('reading selection snapshot', () => {
  it('survives focus selection collapse without exposing the cached object', () => {
    const root = fixture('<p>Read <code>timeout</code>.</p>');
    const cache = new ReadingSelectionCache();
    const source = cache.capture(selected(contents(root)), document);
    source.text = 'tampered';
    window.getSelection()!.removeAllRanges();
    expect(cache.read(document).text).toBe('Read timeout.');
    cache.clear();
    expect(() => cache.read(document)).toThrow('SELECTION_LOST');
  });

  it('invalidates changed text or changed code semantics', () => {
    const root = fixture('<p>Read <code>timeout</code>.</p>');
    const cache = new ReadingSelectionCache();
    cache.capture(selected(contents(root)), document);
    root.querySelector('code')!.replaceWith(document.createTextNode('timeout'));
    expect(() => cache.read(document)).toThrow('SELECTION_LOST');
    expect(() => cache.read(document)).toThrow('SELECTION_LOST');
  });

  it('invalidates removed content and does not reuse an older selection after a failed capture', () => {
    const root = fixture('<p>original</p>');
    const cache = new ReadingSelectionCache();
    cache.capture(selected(contents(root)), document);
    root.remove();
    expect(() => cache.read(document)).toThrow('SELECTION_LOST');
    const next = fixture('<p>next</p>');
    cache.capture(selected(contents(next)), document);
    expect(() => cache.capture(null, document)).toThrow('EMPTY_SOURCE');
    expect(() => cache.read(document)).toThrow('EMPTY_SOURCE');
  });
});
