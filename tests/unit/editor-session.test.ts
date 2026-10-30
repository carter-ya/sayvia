// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectAdapter } from '../../src/adapters/detect';
import { EditorRegistry } from '../../src/adapters/registry';
import { TextEditorSession } from '../../src/adapters/text-session';

let sessions: TextEditorSession[];
function editor(text = '中文草稿', parent: HTMLElement = document.body) {
  const element = document.createElement('textarea');
  element.value = text;
  parent.append(element);
  const session = new TextEditorSession(element, 'generic-text', 'fixture-document');
  sessions.push(session);
  return { element, session };
}
function userInput(element: HTMLTextAreaElement, text: string) {
  element.value = text;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
beforeEach(() => {
  sessions = [];
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    new DOMRect(0, 0, 200, 80),
  ] as unknown as DOMRectList);
  document.body.replaceChildren();
});
afterEach(() => {
  sessions.forEach((session) => session.dispose());
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('editor safety', () => {
  it('replaces only the captured selection and restores the exact prior draft', async () => {
    const { element, session } = editor('前缀 中文 后缀');
    element.setSelectionRange(3, 5);
    const snapshot = session.capture();
    element.setSelectionRange(0, 0);
    expect(await session.apply(snapshot, 'English')).toEqual({ ok: true });
    expect(element.value).toBe('前缀 English 后缀');
    expect(await session.restore()).toEqual({ ok: true });
    expect(element.value).toBe('前缀 中文 后缀');
  });

  it('binds to the original node even after another editor gains focus', async () => {
    const first = editor('第一份');
    const second = editor('第二份');
    const snapshot = first.session.capture();
    second.element.focus();
    expect(await first.session.apply(snapshot, 'First')).toEqual({ ok: true });
    expect(first.element.value).toBe('First');
    expect(second.element.value).toBe('第二份');
  });

  it.each([
    { type: 'text', translation: 'First\nSecond' },
    { type: 'search', translation: 'First\r\nSecond' },
  ])(
    'rejects native line sanitization before changing a $type draft',
    async ({ type, translation }) => {
      const element = document.createElement('input');
      element.type = type;
      element.value = '原始单行草稿';
      document.body.append(element);
      const session = new TextEditorSession(element, 'generic-text', 'fixture-document');
      sessions.push(session);
      const snapshot = session.capture();
      const input = vi.fn();
      element.addEventListener('input', input);
      expect(await session.apply(snapshot, translation)).toEqual({
        ok: false,
        reason: 'WRITE_REJECTED',
      });
      expect(element.value).toBe('原始单行草稿');
      expect(input).not.toHaveBeenCalled();
      expect(session.validate(snapshot)).toEqual({ ok: true });
      expect(await session.apply(snapshot, 'English')).toEqual({ ok: true });
      expect(await session.restore()).toEqual({ ok: true });
      expect(element.value).toBe('原始单行草稿');
    },
  );

  it('keeps an existing restore record when a candidate would be sanitized', async () => {
    const element = document.createElement('input');
    element.value = '原稿';
    document.body.append(element);
    const session = new TextEditorSession(element, 'generic-text', 'fixture-document');
    sessions.push(session);
    await session.apply(session.capture(), 'First');
    expect(await session.apply(session.capture(), 'One\nTwo')).toEqual({
      ok: false,
      reason: 'WRITE_REJECTED',
    });
    expect(await session.restore()).toEqual({ ok: true });
    expect(element.value).toBe('原稿');
  });

  it('ignores a delayed blur change for edits already included in the snapshot', async () => {
    const { element, session } = editor();
    userInput(element, '已输入的完整草稿');
    const snapshot = session.capture();
    element.dispatchEvent(new Event('change', { bubbles: true }));
    expect(await session.apply(snapshot, 'English')).toEqual({ ok: true });
    expect(await session.restore()).toEqual({ ok: true });
    expect(element.value).toBe('已输入的完整草稿');
  });

  it('tracks new change-only values without reviving an older snapshot', async () => {
    const { element, session } = editor();
    const snapshot = session.capture();
    element.value = '脚本改动';
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.value = snapshot.fullText;
    element.dispatchEvent(new Event('change', { bubbles: true }));
    expect(await session.apply(snapshot, 'English')).toEqual({
      ok: false,
      reason: 'SOURCE_CHANGED',
    });
  });

  it('captures a value assigned before the snapshot without a false later commit', async () => {
    const { element, session } = editor();
    const old = session.capture();
    element.value = '快照前已有的脚本赋值';
    const current = session.capture();
    element.dispatchEvent(new Event('change', { bubbles: true }));
    expect(await session.apply(current, 'English')).toEqual({ ok: true });
    expect(session.validate(old).ok).toBe(false);
  });

  it('rejects old snapshots after a user edits and undoes the edit', async () => {
    const { element, session } = editor();
    const snapshot = session.capture();
    userInput(element, '新内容');
    userInput(element, snapshot.fullText);
    expect(await session.apply(snapshot, 'English')).toEqual({
      ok: false,
      reason: 'SOURCE_CHANGED',
    });
    expect(element.value).toBe(snapshot.fullText);
  });

  it('rejects direct value changes and forged snapshot objects', async () => {
    const { element, session } = editor();
    const snapshot = session.capture();
    expect(await session.apply({ ...snapshot }, 'English')).toEqual({
      ok: false,
      reason: 'SOURCE_CHANGED',
    });
    element.value = '脚本修改';
    expect(await session.apply(snapshot, 'English')).toEqual({
      ok: false,
      reason: 'SOURCE_CHANGED',
    });
  });

  it('detects node removal even if the same node was reinserted before validation', async () => {
    const { element, session } = editor();
    const snapshot = session.capture();
    element.remove();
    document.body.append(element);
    expect(await session.apply(snapshot, 'English')).toEqual({ ok: false, reason: 'CONTEXT_LOST' });
  });

  it('does not overwrite newer edits when restoring', async () => {
    const { element, session } = editor();
    await session.apply(session.capture(), 'English');
    userInput(element, 'English plus new work');
    expect(await session.restore()).toEqual({ ok: false, reason: 'SOURCE_CHANGED' });
    expect(element.value).toBe('English plus new work');
    expect(session.previousOriginal()).toBe('中文草稿');
  });

  it('keeps only the most recent successful restore record', async () => {
    const { element, session } = editor();
    await session.apply(session.capture(), 'First');
    await session.apply(session.capture(), 'Second');
    expect(await session.restore()).toEqual({ ok: true });
    expect(element.value).toBe('First');
    expect(await session.restore()).toEqual({ ok: false, reason: 'SOURCE_CHANGED' });
  });

  it('does not capture or replace during IME composition', async () => {
    const { element, session } = editor();
    const snapshot = session.capture();
    element.dispatchEvent(new CompositionEvent('compositionstart'));
    expect(() => session.capture()).toThrow('COMPOSING');
    expect(await session.apply(snapshot, 'English')).toEqual({ ok: false, reason: 'COMPOSING' });
    element.dispatchEvent(new CompositionEvent('compositionend'));
    expect(await session.apply(snapshot, 'English')).toEqual({
      ok: false,
      reason: 'SOURCE_CHANGED',
    });
  });

  it('does not treat a framework rollback as a successful replacement', async () => {
    const { element, session } = editor();
    element.addEventListener('input', () => {
      element.value = '框架回滚';
    });
    expect(await session.apply(session.capture(), 'English')).toEqual({
      ok: false,
      reason: 'WRITE_REJECTED',
    });
    expect(element.value).toBe('框架回滚');
    expect(session.previousOriginal()).toBeUndefined();
  });

  it('preserves competing input dispatched from another event handler', async () => {
    const { element, session } = editor();
    element.addEventListener('input', () => userInput(element, '竞争输入'), { once: true });
    expect(await session.apply(session.capture(), 'English')).toEqual({
      ok: false,
      reason: 'WRITE_REJECTED',
    });
    expect(element.value).toBe('竞争输入');
  });

  it('blocks concurrent writes and does not submit a form', async () => {
    const form = document.createElement('form');
    document.body.append(form);
    const { session } = editor('中文草稿', form);
    let submissions = 0;
    form.addEventListener('submit', () => {
      submissions += 1;
    });
    const snapshot = session.capture();
    const first = session.apply(snapshot, 'English');
    expect(await session.apply(snapshot, 'Other')).toEqual({ ok: false, reason: 'BUSY' });
    expect(await first).toEqual({ ok: true });
    expect(submissions).toBe(0);
  });

  it('rejects readonly and length-limited fields without writing', async () => {
    const { element, session } = editor();
    const snapshot = session.capture();
    element.readOnly = true;
    expect(await session.apply(snapshot, 'English')).toEqual({ ok: false, reason: 'UNSUPPORTED' });
    element.readOnly = false;
    element.maxLength = 2;
    expect(await session.apply(snapshot, 'English')).toEqual({
      ok: false,
      reason: 'WRITE_REJECTED',
    });
    expect(element.value).toBe('中文草稿');
  });

  it('uses GitHub Markdown only for identified Issue and PR comment boxes', () => {
    const { element } = editor();
    element.name = 'comment[body]';
    expect(detectAdapter(element, new URL('https://github.com/acme/repo/issues/1'))).toBe(
      'github-markdown',
    );
    expect(detectAdapter(element, new URL('https://github.com/acme/repo/pull/1/files'))).toBe(
      'github-markdown',
    );
    expect(
      detectAdapter(element, new URL('https://github.com/acme/repo/discussions/1')),
    ).toBeUndefined();
    element.autocomplete = 'cc-number';
    expect(detectAdapter(element)).toBeUndefined();
    const password = document.createElement('input');
    password.type = 'password';
    document.body.append(password);
    expect(detectAdapter(password)).toBeUndefined();
  });

  it('rejects an input that changes to a password field after capture', async () => {
    const element = document.createElement('input');
    element.type = 'text';
    element.value = '原始文字';
    document.body.append(element);
    const registry = new EditorRegistry();
    const session = registry.bind(element)!;
    const snapshot = session.capture();
    element.type = 'password';
    expect(await session.apply(snapshot, 'English')).toEqual({ ok: false, reason: 'UNSUPPORTED' });
    expect(element.value).toBe('原始文字');
    registry.dispose();
  });

  it('reuses sessions and invalidates them on registry disposal', async () => {
    const element = document.createElement('textarea');
    document.body.append(element);
    const registry = new EditorRegistry();
    const session = registry.bind(element)!;
    expect(registry.bind(element)).toBe(session);
    const snapshot = session.capture();
    registry.dispose();
    expect(await session.apply(snapshot, 'English')).toEqual({ ok: false, reason: 'CONTEXT_LOST' });
  });
});
