// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://github.com/exc-works/migrate/pull/14/changes"}
import { afterEach, describe, expect, it } from 'vitest';
import { ReadingSelectionCache } from '../../src/adapters/selection-cache';
import {
  createTranslationPlan,
  needsTranslation,
  translationPayload,
} from '../../src/core/translation-plan';
const sentence = 'DriverDSN keeps Oracle reconnections on the full authentication path.';
function capture(element: Element, end = element) {
  const r = document.createRange();
  r.setStart(element, 0);
  r.setEnd(end, end.childNodes.length);
  const s = window.getSelection()!;
  s.removeAllRanges();
  s.addRange(r);
  const source = new ReadingSelectionCache(true).capture(s, document);
  return { source, plan: createTranslationPlan(source) };
}
afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});
function diff(name: string) {
  document.body.innerHTML = `<table role="grid" data-diff-anchor="diff-fixture" aria-label="Diff for: ${name}"><tbody><tr><td data-diff-side="left" data-line-number="11"><code class="diff-text"><div class="diff-text-inner">PRIVATE_LEFT</div></code></td><td data-diff-side="right" data-line-number="11"><code class="diff-text"><div class="diff-text-inner" id=selected>${sentence}</div></code></td></tr></tbody></table>`;
  return document.getElementById('selected')!;
}
describe('selection-first reading', () => {
  it.each(['p', 'pre', 'pre-code', 'code'])(
    'translates the same user-selected sentence inside %s',
    (container) => {
      document.body.innerHTML =
        container === 'pre-code'
          ? `<pre><code>${sentence}</code></pre>`
          : `<${container}>${sentence}</${container}>`;
      const { plan } = capture(document.body.firstElementChild!);
      expect(needsTranslation(plan)).toBe(true);
      expect(JSON.stringify(translationPayload(plan))).toContain(sentence);
    },
  );
  it.each(['README.md', 'driver.go', 'worker.py', 'unknown.custom', 'without-extension'])(
    'does not use filename %s as a translation gate',
    (name) => {
      const { plan } = capture(diff(name));
      expect(needsTranslation(plan)).toBe(true);
      expect(JSON.stringify(translationPayload(plan))).toContain(sentence);
      expect(JSON.stringify(translationPayload(plan))).not.toContain('PRIVATE_LEFT');
    },
  );
  it('makes a selected comment inside a Markdown code fence translatable', () => {
    const selected = diff('README.md');
    const row = selected.closest('tr')!;
    const body = row.parentElement!;
    const before = row.cloneNode(true) as Element;
    before.querySelector('[data-diff-side="right"]')!.setAttribute('data-line-number', '10');
    before.querySelector('[data-diff-side="right"] .diff-text-inner')!.textContent = '```go';
    body.prepend(before);
    const after = row.cloneNode(true) as Element;
    after.querySelector('[data-diff-side="right"]')!.setAttribute('data-line-number', '12');
    after.querySelector('[data-diff-side="right"] .diff-text-inner')!.textContent = '```';
    body.append(after);
    expect(needsTranslation(capture(selected).plan)).toBe(true);
  });
  it('keeps a short selection available when optional Markdown context exceeds its budget', () => {
    const selected = diff('README.md');
    const row = selected.closest('tr')!,
      body = row.parentElement!;
    for (let index = 0; index < 90; index++) {
      const before = row.cloneNode(true) as Element;
      before
        .querySelector('[data-diff-side="right"]')!
        .setAttribute('data-line-number', String(index + 1));
      before.querySelector('[data-diff-side="right"] .diff-text-inner')!.textContent =
        'UNSELECTED_CONTEXT '.repeat(100);
      body.insertBefore(before, row);
    }
    row.querySelector('[data-diff-side="right"]')!.setAttribute('data-line-number', '91');
    const { plan } = capture(selected);
    expect(needsTranslation(plan)).toBe(true);
    expect(JSON.stringify(translationPayload(plan))).toContain(sentence);
    expect(JSON.stringify(translationPayload(plan))).not.toContain('UNSELECTED_CONTEXT');
  });
  it('preserves explicit inline code and link destinations as separate pieces within prose', () => {
    document.body.innerHTML =
      '<p>Read <code>DriverDSN</code> and <a href="https://example.test/PRIVATE_TARGET">the guide</a>.</p>';
    const { plan } = capture(document.querySelector('p')!);
    expect(needsTranslation(plan)).toBe(true);
    expect(JSON.stringify(translationPayload(plan))).not.toMatch(/DriverDSN|PRIVATE_TARGET/);
  });
});
