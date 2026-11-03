// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://github.com/exc-works/decimal/pull/10/changes"}
import { afterEach, describe, expect, it } from 'vitest';
import { ReadingSelectionCache } from '../../src/adapters/selection-cache';
import {
  createTranslationPlan,
  needsTranslation,
  translationPayload,
  reconstructTranslation,
} from '../../src/core/translation-plan';
import { planResponse } from '../fixtures/plan-response';
import { commitDiff, commitUrl, commitAnchor } from '../fixtures/github-commit-diff';

function fixture(lines: string[], name = 'README.md', firstLine = 164) {
  document.body.innerHTML = `<table role="grid" data-diff-anchor="diff-fixture" aria-label="Diff for: ${name}"><tbody>${lines.map((line, i) => `<tr><td data-diff-side="left" data-line-number="${i + firstLine}">LEFT_OUTSIDE</td><td data-diff-side="left" data-line-number="${i + firstLine}"><code class="diff-text"><div class="diff-text-inner">LEFT_OUTSIDE</div></code></td><td data-diff-side="right" data-line-number="${i + firstLine}">${i + firstLine}</td><td data-diff-side="right" data-line-number="${i + firstLine}"><code class="diff-text syntax-highlighted-line addition"><span class="diff-text-marker">+</span><div class="diff-text-inner" id="line-${i}">${line || '<br>'}</div></code><button>CONTROL_OUTSIDE</button></td></tr>`).join('')}</tbody></table>`;
}
function capture(start = 0, end = start, from?: number, to?: number) {
  const range = document.createRange();
  const first = document.getElementById(`line-${start}`)!;
  const last = document.getElementById(`line-${end}`)!;
  range.setStart(from === undefined ? first : first.firstChild!, from ?? 0);
  range.setEnd(to === undefined ? last : last.firstChild!, to ?? last.childNodes.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const cache = new ReadingSelectionCache(true);
  const source = cache.capture(selection, document);
  return { source, cache, plan: createTranslationPlan(source) };
}
afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

describe('GitHub Markdown source diff reading', () => {
  it.each([
    commitUrl,
    'https://github.com/acme/repo/compare/base...head',
    'https://github.com/acme/repo/pull/12/files',
  ])('reads the observed anchor-only Markdown diff on %s', (url) => {
    const previous = location.href;
    history.replaceState({}, '', new URL(url).pathname);
    document.body.innerHTML = commitDiff();
    const range = document.createRange();
    const first = document.getElementById('commit-line-0')!;
    const last = document.getElementById('commit-line-1')!;
    range.setStart(first.childNodes[1]!, 1);
    range.setEnd(last, last.childNodes.length);
    const selected = window.getSelection()!;
    selected.addRange(range);
    try {
      const source = new ReadingSelectionCache(true).capture(selected, document);
      const plan = createTranslationPlan(source);
      expect(needsTranslation(plan)).toBe(true);
      expect(plan.segments).toHaveLength(2);
      expect(JSON.stringify(translationPayload(plan))).not.toMatch(
        /UNSELECTED_LEFT|\.mjs|new version --format mjs/,
      );
      expect(source.text).toContain('Accept `.mjs`');
    } finally {
      history.replaceState({}, '', previous);
    }
  });
  it('rejects missing, foreign or contradictory side/line metadata rather than claiming all prose is code', () => {
    for (const metadata of ['missing', 'foreign', 'contradictory', 'partial']) {
      document.body.innerHTML = commitDiff();
      const first = document.getElementById('commit-line-0')!;
      const cell = first.closest('td')!;
      if (metadata === 'missing') cell.removeAttribute('data-line-anchor');
      if (metadata === 'foreign') cell.setAttribute('data-line-anchor', 'diff-otherR13');
      if (metadata === 'contradictory') {
        cell.setAttribute('data-diff-side', 'left');
        cell.setAttribute('data-line-number', '13');
      }
      if (metadata === 'partial') cell.setAttribute('data-diff-side', 'left');
      const range = document.createRange();
      range.selectNodeContents(first);
      const selected = window.getSelection()!;
      selected.removeAllRanges();
      selected.addRange(range);
      expect(() => new ReadingSelectionCache(true).capture(selected, document)).toThrow(
        'UNSUPPORTED_SELECTION',
      );
    }
  });
  it('rejects opposite sides using commit anchors', () => {
    document.body.innerHTML = commitDiff();
    const left = document.querySelector(
      `td[data-line-anchor="${commitAnchor}L11"] .diff-text-inner`,
    )!;
    const right = document.getElementById('commit-line-1')!;
    const range = document.createRange();
    range.setStart(left, 0);
    range.setEnd(right, right.childNodes.length);
    const selected = window.getSelection()!;
    selected.addRange(range);
    expect(() => new ReadingSelectionCache(true).capture(selected, document)).toThrow(
      'UNSUPPORTED_SELECTION',
    );
  });
  it('translates README prose inside the structural code wrapper', () => {
    fixture(['Nearly equal costs keep the original direction.']);
    const { source, plan } = capture();
    expect(source.text).toBe('Nearly equal costs keep the original direction.');
    expect(needsTranslation(plan)).toBe(true);
    expect(
      reconstructTranslation(
        plan,
        planResponse(plan, () => '成本相近时保持原方向。'),
      ),
    ).toBe('成本相近时保持原方向。');
  });
  it('keeps actual inline code and link targets local', () => {
    fixture([
      'Read <span class="pl-s">`</span><span class="pl-c1">ln(x)</span><span class="pl-s">`</span> and [guide](https://example.test/PRIVATE_TARGET).',
    ]);
    const { source, plan } = capture();
    expect(source.text).toBe('Read `ln(x)` and [guide](https://example.test/PRIVATE_TARGET).');
    expect(JSON.stringify(translationPayload(plan))).not.toMatch(
      /ln\(x\)|example.test|PRIVATE_TARGET/,
    );
    expect(reconstructTranslation(plan, planResponse(plan))).toBe(source.text);
  });
  it('captures only the selected side, excluding line numbers, markers and controls', () => {
    fixture(['Read first.', 'Keep `timeout`.', 'End.']);
    const { source, cache } = capture(0, 2, 5, 3);
    expect(source.text).toBe('first.\nKeep `timeout`.\nEnd');
    expect(cache.readText(document)).toBe(source.text);
    expect(JSON.stringify(source)).not.toMatch(/LEFT_OUTSIDE|CONTROL_OUTSIDE|164|165|166/);
  });
  it('preserves blank source lines exactly once', () => {
    fixture(['First paragraph.', '', 'Second paragraph.']);
    expect(capture(0, 2).source.text).toBe('First paragraph.\n\nSecond paragraph.');
  });
  it('protects a partial selection inside raw inline code using local line context', () => {
    fixture(['Outside `timeout` after.']);
    const { source, plan } = capture(0, 0, 11, 14);
    expect(source.text).toBe('`meo`');
    expect(needsTranslation(plan)).toBe(false);
    expect(source.text).not.toMatch(/Outside|after|timeout/);
  });
  it('keeps a partially selected Markdown link destination local', () => {
    fixture(['Read [guide](https://example.test/PRIVATE_DESTINATION) first.']);
    const raw = document.getElementById('line-0')!.textContent!;
    const begin = raw.indexOf('PRIVATE_DESTINATION');
    const { source, plan } = capture(0, 0, begin, begin + 7);
    expect(source.text).toBe('`PRIVATE`');
    expect(needsTranslation(plan)).toBe(false);
  });
  it('preserves leading selected blank lines', () => {
    fixture(['', '', 'Read first.']);
    expect(capture(0, 2).source.text).toBe('\n\nRead first.');
  });
  it('reads trailing context to protect a code span closed on a later rendered line', () => {
    fixture(['Read `PRIVATE_CODE', 'continued` first.']);
    const { source, plan } = capture(0, 0, 6, 18);
    expect(source.text).toBe('`PRIVATE_CODE`');
    expect(needsTranslation(plan)).toBe(false);
    expect(source.text).not.toContain('continued');
  });
  it('protects partial relative link targets', () => {
    fixture(['Read [guide](PRIVATE_TARGET/path).']);
    const raw = document.getElementById('line-0')!.textContent!;
    const begin = raw.indexOf('PRIVATE_TARGET');
    expect(needsTranslation(capture(0, 0, begin, begin + 7).plan)).toBe(false);
  });
  it('keeps complete destinations protected when clipping removes the link opener', () => {
    fixture(['[guide](PRIVATE_TARGET/path)']);
    const raw = document.getElementById('line-0')!.textContent!;
    const { plan } = capture(0, 0, 1, raw.length);
    expect(needsTranslation(plan)).toBe(true);
    expect(JSON.stringify(translationPayload(plan))).not.toContain('PRIVATE_TARGET');
  });
  it('keeps raw HTML code-body protection after clipping away the tags', () => {
    fixture(['Read &lt;code&gt;PRIVATE_CODE&lt;/code&gt; first.']);
    const raw = document.getElementById('line-0')!.textContent!;
    const begin = raw.indexOf('PRIVATE_CODE');
    expect(needsTranslation(capture(0, 0, begin, begin + 12).plan)).toBe(false);
  });
  it('does not rewrap a complete protected raw HTML span', () => {
    fixture(['Read &lt;code&gt;PRIVATE_CODE&lt;/code&gt; first.']);
    const { source, plan } = capture();
    expect(source.text).toBe('Read <code>PRIVATE_CODE</code> first.');
    expect(JSON.stringify(translationPayload(plan))).not.toContain('PRIVATE_CODE');
  });
  it('keeps a partial bare URL path local', () => {
    fixture(['Read https://example.test/PRIVATE_TARGET first.']);
    const raw = document.getElementById('line-0')!.textContent!;
    const begin = raw.indexOf('PRIVATE_TARGET');
    expect(needsTranslation(capture(0, 0, begin, begin + 7).plan)).toBe(false);
  });
  it.each(['```', '~~~', '> ```'])(
    'uses literal selected text when a code fence cannot establish a useful format: %s',
    (fence) => {
      fixture(['PRIVATE_CODE', fence, 'Read first.']);
      const { plan } = capture(0);
      expect(needsTranslation(plan)).toBe(true);
      expect(JSON.stringify(translationPayload(plan))).toContain('PRIVATE_CODE');
      expect(needsTranslation(capture(2).plan)).toBe(true);
    },
  );
  it('parses a bare opening fence when the rendered context starts at file line one', () => {
    fixture(['Read first.', '```', 'PRIVATE_CODE', '```'], 'README.md', 1);
    expect(needsTranslation(capture(0).plan)).toBe(true);
    expect(needsTranslation(capture(2).plan)).toBe(true);
  });
  it('translates prose after a selected closing fence whose opener was not selected', () => {
    fixture(['```go', 'PRIVATE_CODE', '```', 'Read first.']);
    const { source, plan } = capture(2, 3);
    expect(needsTranslation(plan)).toBe(true);
    expect(JSON.stringify(translationPayload(plan))).toContain('Read first.');
    expect(source.text).not.toContain('PRIVATE_CODE');
  });
  it('retains prose after selecting only the closing inline-code delimiter', () => {
    fixture(['Read `PRIVATE_CODE` first.']);
    const raw = document.getElementById('line-0')!.textContent!;
    const { plan } = capture(0, 0, raw.lastIndexOf('`'), raw.length);
    expect(needsTranslation(plan)).toBe(true);
    expect(JSON.stringify(translationPayload(plan))).toContain('first.');
    expect(JSON.stringify(translationPayload(plan))).not.toContain('PRIVATE_CODE');
  });
  it.each(['    ', '\t'])(
    'translates list-continuation prose selected with indentation %j',
    (indentation) => {
      fixture(['- First.', '', `${indentation}Read first.`]);
      const { plan } = capture(2);
      expect(needsTranslation(plan)).toBe(true);
      expect(JSON.stringify(translationPayload(plan))).toContain('Read first.');
    },
  );
  it('retains code and links when selected list indentation is normalized', () => {
    fixture(['- First.', '', '    Read `PRIVATE_CODE` and [guide](PRIVATE_TARGET).']);
    const { source, plan } = capture(2);
    expect(needsTranslation(plan)).toBe(true);
    expect(source.text).toContain('[guide](PRIVATE_TARGET)');
    expect(JSON.stringify(translationPayload(plan))).not.toMatch(/PRIVATE_CODE|PRIVATE_TARGET/);
  });
  it('allows explicitly selected indented source text outside a list', () => {
    fixture(['Context.', '', '    PRIVATE_CODE']);
    expect(needsTranslation(capture(2).plan)).toBe(true);
  });
  it('recognizes visible Markdown prose following the closing fence in public PR #15', () => {
    fixture(
      [
        '```',
        '',
        '<span class="pl-s">`</span><span class="pl-c1">NullDecimal</span><span class="pl-s">`</span> implements <span class="pl-s">`</span><span class="pl-c1">sql.Scanner</span><span class="pl-s">`</span>.',
        'Read [decoding table](docs/numeric-contract.md).',
      ],
      'README.md',
      450,
    );
    const { source, plan } = capture(2, 3);
    expect(needsTranslation(plan)).toBe(true);
    expect(source.text).toBe(
      '`NullDecimal` implements `sql.Scanner`.\nRead [decoding table](docs/numeric-contract.md).',
    );
    expect(JSON.stringify(translationPayload(plan))).not.toMatch(
      /NullDecimal|sql.Scanner|numeric-contract/,
    );
    expect(
      reconstructTranslation(
        plan,
        planResponse(plan, (text) => text.replace('implements', '实现')),
      ),
    ).toContain('实现');
  });
  it('keeps the unknown prefix before a confirmed closing fence opaque', () => {
    fixture([
      'PRIVATE_CODE',
      '```',
      '<span class="pl-s">`</span><span class="pl-c1">x</span><span class="pl-s">`</span> implements this.',
    ]);
    const { plan } = capture(0, 2);
    expect(needsTranslation(plan)).toBe(true);
    expect(JSON.stringify(translationPayload(plan))).not.toMatch(/PRIVATE_CODE/);
  });
  it('does not let missing or unrelated Markdown evidence disable literal selected text', () => {
    const hint =
      '<span class="pl-s">`</span><span class="pl-c1">x</span><span class="pl-s">`</span>';
    for (const text of [
      `PRIVATE_CODE<span hidden>${hint}</span>`,
      `<span class="pl-c1">${hint}</span>`,
      `PRIVATE_CODE`,
    ]) {
      fixture(['```', text]);
      expect(needsTranslation(capture(1).plan)).toBe(true);
    }
    fixture(['```', 'PRIVATE_CODE', '```', hint]);
    expect(needsTranslation(capture(1).plan)).toBe(true);
  });
  it('invalidates a capture when the visible Markdown context evidence changes', () => {
    fixture([
      '```',
      '<span class="pl-s">`</span><span class="pl-c1">x</span><span class="pl-s">`</span> implements this.',
    ]);
    const { cache } = capture(1);
    document.querySelector('#line-1 .pl-s')!.className = 'plain';
    expect(() => cache.read(document)).toThrow('SELECTION_LOST');
  });
  it('does not translate a fenced code body when its opening fence is outside the selection', () => {
    fixture(['```text', 'PRIVATE_CODE_BODY', '```', 'Read first.']);
    const { source, plan } = capture(1, 3);
    expect(JSON.stringify(translationPayload(plan))).not.toContain('PRIVATE_CODE_BODY');
    expect(needsTranslation(plan)).toBe(true);
    expect(source.text).not.toContain('LEFT_OUTSIDE');
  });
  it('retains complete selected code fences unchanged', () => {
    fixture(['```go', 'const n = 1;', '```', 'Read first.']);
    const { source, plan } = capture(0, 3);
    expect(source.text).toBe('```go\nconst n = 1;\n```\nRead first.');
    expect(JSON.stringify(translationPayload(plan))).not.toContain('const n');
  });
  it('keeps unchanged selected prose available when an unselected line becomes a code fence', () => {
    fixture(['Context.', 'Read first.']);
    const { cache } = capture(1);
    document.getElementById('line-0')!.textContent = '```';
    expect(needsTranslation(createTranslationPlan(cache.read(document)))).toBe(true);
  });
  it('does not send any surrounding hunk text or opposite column', () => {
    fixture(['PRIVATE_BEFORE', 'Read first.', 'PRIVATE_AFTER']);
    const { source, plan } = capture(1);
    expect(source.text).toBe('Read first.');
    expect(JSON.stringify(translationPayload(plan))).not.toMatch(/PRIVATE_|LEFT_|CONTROL_/);
  });
  it('allows selected text in program source files', () => {
    fixture(['Read first.'], 'source.go');
    expect(needsTranslation(capture().plan)).toBe(true);
  });
  it('uses the generic selected-text baseline outside GitHub', () => {
    fixture(['Read first.']);
    const outside = document.implementation.createHTMLDocument();
    outside.body.innerHTML = document.body.innerHTML;
    const range = outside.createRange();
    range.selectNodeContents(outside.getElementById('line-0')!);
    const source = new ReadingSelectionCache(true);
    const selected = {
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => range,
    } as unknown as Selection;
    expect(needsTranslation(createTranslationPlan(source.capture(selected, outside)))).toBe(true);
  });
  it('rejects selections between two diff columns', () => {
    fixture(['Read first.']);
    const range = document.createRange();
    range.setStart(document.querySelector('.diff-text-inner')!.firstChild!, 0);
    range.setEnd(document.getElementById('line-0')!.firstChild!, 4);
    const selected = window.getSelection()!;
    selected.addRange(range);
    expect(() => new ReadingSelectionCache(true).capture(selected, document)).toThrow(
      'UNSUPPORTED_SELECTION',
    );
  });
  it('does not include hidden text from the selected line', () => {
    fixture(['Read <span hidden>PRIVATE_HIDDEN</span>first.']);
    const { source, plan } = capture();
    expect(source.text).toBe('Read first.');
    expect(JSON.stringify(translationPayload(plan))).not.toContain('PRIVATE_HIDDEN');
  });
});
