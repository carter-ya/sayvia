// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.test/article"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadingSelectionCache } from '../../src/adapters/selection-cache';
import { captureReadingSnapshot, type ReadingSnapshot } from '../../src/adapters/reading-snapshot';

const snapshots: ReadingSnapshot[] = [];
function capture(element: Element, range?: Range) {
  range ??= document.createRange();
  if (range.collapsed) range.selectNodeContents(element);
  const source = new ReadingSelectionCache(true).captureRange(range, document);
  const snapshot = captureReadingSnapshot(range, source);
  if (snapshot) snapshots.push(snapshot);
  return { source, snapshot };
}
afterEach(() => {
  snapshots.splice(0).forEach((snapshot) => snapshot.dispose());
  document.body.replaceChildren();
});
describe('reading snapshot', () => {
  it('keeps adjacent native text nodes and their exact originals across toggles', () => {
    const p = document.createElement('p');
    const nodes = ['Read ', 'first', '.'].map((text) => document.createTextNode(text));
    p.append(...nodes);
    document.body.append(p);
    const { snapshot } = capture(p);
    expect(snapshot!.show('阅读优先。')).toBe(true);
    expect(p.textContent).toBe('阅读优先。');
    expect([...p.childNodes]).toEqual(nodes);
    expect(snapshot!.show(null)).toBe(true);
    expect(nodes.map((node) => node.data)).toEqual(['Read ', 'first', '.']);
  });
  it('changes only selected text, preserving node identity and repeated restoration', () => {
    document.body.innerHTML = '<p>Before Read first. After</p>';
    const p = document.querySelector('p')!,
      node = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 7);
    range.setEnd(node, 18);
    const { snapshot } = capture(p, range);
    expect(snapshot).toBeDefined();
    for (let i = 0; i < 3; i++) {
      expect(snapshot!.show('阅读优先。')).toBe(true);
      expect(p.textContent).toBe('Before 阅读优先。 After');
      expect(p.firstChild).toBe(node);
      expect(snapshot!.show(null)).toBe(true);
      expect(node.data).toBe('Before Read first. After');
    }
  });
  it('preserves links, targets, code and website listeners across multiple paragraphs', () => {
    document.body.innerHTML =
      '<article><p>Read <a href="/guide">guide</a> first.</p><p>Keep <code>CONST</code> here.</p></article>';
    const article = document.querySelector('article')!,
      link = document.querySelector('a')!,
      code = document.querySelector('code')!;
    const handler = vi.fn();
    link.addEventListener('click', handler);
    const { snapshot } = capture(article);
    expect(
      snapshot!.show('阅读 [指南](<https://example.test/guide>) 优先。\n\n保留 `CONST` 于此。'),
    ).toBe(true);
    expect(link.textContent).toBe('指南');
    expect(link.getAttribute('href')).toBe('/guide');
    expect(document.querySelector('code')).toBe(code);
    expect(code.textContent).toBe('CONST');
    link.dispatchEvent(new Event('click'));
    expect(handler).toHaveBeenCalledOnce();
    expect(snapshot!.show(null)).toBe(true);
    expect(link.textContent).toBe('guide');
  });
  it('rejects changed structure, injected markup and code/target changes atomically', () => {
    document.body.innerHTML =
      '<p>Read <a href="/guide">guide</a> and <code>CONST</code> first.</p>';
    const p = document.querySelector('p')!,
      original = p.innerHTML;
    const { source, snapshot } = capture(p);
    for (const invalid of [
      source.text.replace('CONST', 'CHANGED'),
      source.text.replace('/guide', '/evil'),
      '<img src=x onerror=alert(1)>',
      'Plain replacement',
    ]) {
      expect(snapshot!.show(invalid)).toBe(false);
      expect(p.innerHTML).toBe(original);
    }
  });
  it('invalidates changes even when the site changes the text back before applying', () => {
    document.body.innerHTML = '<p>Read first.</p>';
    const p = document.querySelector('p')!,
      node = p.firstChild as Text;
    const { snapshot } = capture(p);
    node.data = 'New content';
    node.data = 'Read first.';
    expect(snapshot!.show('阅读优先。')).toBe(false);
  });
  it('does not restore stale originals after a site update', () => {
    document.body.innerHTML = '<p>Read first.</p>';
    const p = document.querySelector('p')!,
      { snapshot } = capture(p);
    expect(snapshot!.show('阅读优先。')).toBe(true);
    p.firstChild!.nodeValue = 'Newest website content';
    snapshot!.dispose(true);
    expect(p.textContent).toBe('Newest website content');
  });
  it('invalidates rerenders and link attribute changes, while allowing unrelated changes', () => {
    document.body.innerHTML =
      '<p id=selected>Read <a href="/guide">guide</a> first.</p><aside>Other</aside>';
    const p = document.querySelector('p')!,
      { snapshot } = capture(p);
    document.querySelector('aside')!.textContent = 'Unrelated update';
    expect(snapshot!.isValid()).toBe(true);
    document.querySelector('a')!.setAttribute('href', '/changed');
    expect(snapshot!.isValid()).toBe(false);
    const second = capture(p).snapshot!;
    p.replaceWith(p.cloneNode(true));
    expect(second.isValid()).toBe(false);
  });
  it('allows extension-owned controls without changing the original snapshot', () => {
    document.body.innerHTML = '<p>Read first.</p>';
    const p = document.querySelector('p')!,
      { snapshot } = capture(p);
    const entry = document.createElement('span');
    entry.dataset.sayviaUi = '';
    p.append(entry);
    expect(snapshot!.show('阅读优先。')).toBe(true);
    expect(snapshot!.show(null)).toBe(true);
  });
  it('keeps complex or interactive structures in preview instead of guessing node mappings', () => {
    for (const html of [
      '<p>Read <strong>important</strong> text.</p>',
      '<button>Read first.</button>',
      '<p contenteditable>Read first.</p>',
      '<pre><code>Read first.</code></pre>',
    ]) {
      document.body.innerHTML = html;
      expect(capture(document.body.firstElementChild!).snapshot).toBeUndefined();
    }
  });
  it('restores valid text when the extension ends its session', () => {
    document.body.innerHTML = '<p>Read first.</p>';
    const p = document.querySelector('p')!,
      { snapshot } = capture(p);
    snapshot!.show('阅读优先。');
    snapshot!.dispose(true);
    expect(p.textContent).toBe('Read first.');
  });
});
