// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.test/article"}
import { parseMarkdown } from '../../src/core/markdown';
import { bitcoinDescription } from '../fixtures/bitcoin-description';
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
  it('maps the reported Bitcoin paragraphs even when plain prose is split into neutral spans', () => {
    const article = document.createElement('article');
    const tree = parseMarkdown(bitcoinDescription);
    for (const block of tree.children) {
      if (block.type !== 'paragraph') throw Error('Unexpected fixture');
      const p = document.createElement('p');
      for (const child of block.children) {
        if (child.type === 'link') {
          const a = document.createElement('a');
          a.href = child.url;
          a.textContent = child.children.map((n) => ('value' in n ? n.value : '')).join('');
          p.append(a);
        } else if (child.type === 'text') {
          const cut = Math.floor(child.value.length / 2);
          for (const text of [child.value.slice(0, cut), child.value.slice(cut)]) {
            if (!text) continue;
            const span = document.createElement('span');
            span.textContent = text;
            p.append(span);
          }
        }
      }
      article.append(p);
    }
    document.body.append(article);
    const nodes = [...article.querySelectorAll('*')];
    const original = article.innerHTML;
    const { source, snapshot } = capture(article);
    expect(snapshot).toBeDefined();
    expect(snapshot!.show(source.text.replace('is a decentralized', '是一种去中心化的'))).toBe(
      true,
    );
    expect(article.textContent).toContain('是一种去中心化的');
    expect([...article.querySelectorAll('*')]).toEqual(nodes);
    expect(article.querySelectorAll('a')).toHaveLength(7);
    expect(snapshot!.show(null)).toBe(true);
    expect(article.innerHTML).toBe(original);
  });
  it('preserves whitespace-only separators between adjacent links', () => {
    document.body.innerHTML = '<p><a href="/one">One</a> <a href="/two">Two</a></p>';
    const p = document.querySelector('p')!;
    const { source, snapshot } = capture(p);
    expect(snapshot).toBeDefined();
    expect(snapshot!.show(source.text.replace('One', '一').replace('Two', '二'))).toBe(true);
    expect(p.textContent).toBe('一 二');
    expect(snapshot!.show(null)).toBe(true);
    expect(p.textContent).toBe('One Two');
  });

  it.each([
    '<p>Read <span style="font-weight: bold">important</span> text.</p>',
    '<p>Read <span style="display: block">separate</span> text.</p>',
    '<p>Read<br>another line.</p>',
    '<p>Read <span role="link" tabindex="0">interactive</span> text.</p>',
  ])('does not flatten formatting, layout or interactive boundaries: %s', (html) => {
    document.body.innerHTML = html;
    const p = document.querySelector('p')!;
    const { snapshot } = capture(p);
    expect(snapshot?.canApply('扁平译文') ?? false).toBe(false);
  });
  it('keeps partial selections and detects updates inside merged span groups', () => {
    document.body.innerHTML = '<p><span>Before Read </span><span>first. After</span></p>';
    const p = document.querySelector('p')!;
    const nodes = [...p.querySelectorAll('span')].map((span) => span.firstChild as Text);
    const range = document.createRange();
    range.setStart(nodes[0]!, 7);
    range.setEnd(nodes[1]!, 6);
    const { snapshot } = capture(p, range);
    expect(snapshot!.show('阅读优先。')).toBe(true);
    expect(p.textContent).toBe('Before 阅读优先。 After');
    expect(snapshot!.show(null)).toBe(true);
    expect(p.textContent).toBe('Before Read first. After');
    nodes[1]!.data = 'Website update';
    expect(snapshot!.show('旧译文')).toBe(false);
    expect(nodes[1]!.data).toBe('Website update');
  });
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
  it.each(['text', 'span'])('rejects new %s content inserted between merged spans', (kind) => {
    document.body.innerHTML = '<p><span>Read </span><span>first.</span></p>';
    const p = document.querySelector('p')!;
    const { snapshot } = capture(p);
    const inserted =
      kind === 'text' ? document.createTextNode('new content ') : document.createElement('span');
    inserted.textContent = 'new content ';
    p.insertBefore(inserted, p.lastChild);
    const current = p.innerHTML;
    expect(snapshot!.canApply('阅读优先。')).toBe(false);
    expect(snapshot!.show('阅读优先。')).toBe(false);
    expect(p.innerHTML).toBe(current);
  });
  it.each(['paragraph', 'wrapper'])('rejects inserted prose at the %s boundary', (target) => {
    document.body.innerHTML = '<p><span><span>Read </span></span><span>first.</span></p>';
    const p = document.querySelector('p')!;
    const { snapshot } = capture(p);
    const container = target === 'paragraph' ? p : p.firstElementChild!;
    container.insertBefore(document.createTextNode('new content '), container.firstChild);
    const current = p.innerHTML;
    expect(snapshot!.show('阅读优先。')).toBe(false);
    expect(p.innerHTML).toBe(current);
  });
  it('does not restore stale merged prose after content is inserted between its spans', () => {
    document.body.innerHTML = '<p><span>Read </span><span>first.</span></p>';
    const p = document.querySelector('p')!;
    const { snapshot } = capture(p);
    expect(snapshot!.show('阅读优先。')).toBe(true);
    p.insertBefore(document.createTextNode('new content '), p.lastChild);
    const current = p.innerHTML;
    expect(snapshot!.show(null)).toBe(false);
    snapshot!.dispose(true);
    expect(p.innerHTML).toBe(current);
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
  it('accepts unrelated ancestor attributes and theme changes when the exact selected content stays unchanged', () => {
    document.body.innerHTML = '<p id=selected>Read <a href="/guide">guide</a> first.</p>';
    const p = document.querySelector('p')!,
      { snapshot, source } = capture(p);
    document.body.dataset.ticker = '42';
    document.body.classList.add('theme-dark');
    expect(snapshot!.isValid()).toBe(true);
    expect(snapshot!.show(source.text.replace('Read', '阅读'))).toBe(true);
    expect(snapshot!.show(null)).toBe(true);
  });
  it('still rejects appearance changes which hide selected text or change mapping semantics', () => {
    document.body.innerHTML = '<p>Read first.</p>';
    const p = document.querySelector('p')!,
      { snapshot } = capture(p);
    p.style.display = 'none';
    expect(snapshot!.show('阅读优先。')).toBe(false);
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
