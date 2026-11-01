import { expect, test } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { workflowFixture } from '../fixtures/core-workflow-extension';
type ChromeGlobal = { chrome: typeof browser };
test('registered commands use the background direct-reading message without a raw-text fallback', async () => {
  const f = await workflowFixture();
  try {
    const commands = await f.settings.evaluate(() =>
      (globalThis as unknown as ChromeGlobal).chrome.commands.getAll(),
    );
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'translate-selection', shortcut: expect.any(String) }),
        expect.objectContaining({ name: 'translate-editor' }),
      ]),
    );
    await f.page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'reading';
      p.innerHTML = 'Read <code>timeout</code> first.';
      document.body.prepend(p);
      const range = document.createRange();
      range.selectNodeContents(p);
      const selected = window.getSelection()!;
      selected.removeAllRanges();
      selected.addRange(range);
    });
    // Headless CDP key dispatch does not reach the native Chrome accelerator.
    // Exercise the real background sender -> content bridge; OS gesture routing is a native release check.
    await f.open('read');
    await f.worker.evaluate(async (url) => {
      const api = (globalThis as unknown as ChromeGlobal).chrome;
      const tab = (await api.tabs.query({})).find((item) => item.url === url)!;
      await api.tabs.sendMessage(
        tab.id!,
        { protocolVersion: 1, type: 'page.show', mode: 'read', autoTranslate: true },
        { frameId: 0 },
      );
    }, f.page.url());
    await expect(f.page.getByRole('dialog', { name: 'Sayvia 翻译' })).toBeVisible({
      timeout: 5000,
    });
    await expect(f.page.getByLabel('译文', { exact: true })).toHaveValue('阅读 timeout 优先。');
    expect(f.count()).toBe(1);
    expect(f.requestBodies[0]).not.toContain('timeout');
  } finally {
    await f.close();
  }
});

test('a repeated background gesture asks to finish the active request instead of canceling and charging again', async () => {
  const f = await workflowFixture();
  try {
    f.delay(30_000);
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect.poll(f.pending).toBe(1);
    await f.worker.evaluate(async (url) => {
      const api = (globalThis as unknown as ChromeGlobal).chrome;
      const tab = (await api.tabs.query({})).find((item) => item.url === url)!;
      await api.tabs.sendMessage(
        tab.id!,
        { protocolVersion: 1, type: 'page.show', mode: 'read', autoTranslate: true },
        { frameId: 0 },
      );
    }, f.page.url());
    await expect(panel.getByRole('status')).toHaveText(
      '当前已有翻译正在处理，请等待或取消后再试。',
    );
    expect(f.pending()).toBe(1);
    expect(f.count()).toBe(1);
    await panel.getByRole('button', { name: '取消翻译', exact: true }).click();
    await expect.poll(f.pending).toBe(0);
  } finally {
    await f.close();
  }
});
test('a collapsed selection never auto-translates an earlier cached range from a shortcut', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'previous-selection';
      p.textContent = 'Read this first.';
      document.body.prepend(p);
      const range = document.createRange();
      range.selectNodeContents(p);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    const preview = await f.open('read');
    await expect(preview.getByLabel('原文', { exact: true })).toHaveValue('Read this first.');
    await preview.getByRole('button', { name: '关闭翻译面板', exact: true }).click();
    await f.page.evaluate(() => window.getSelection()!.removeAllRanges());
    await f.worker.evaluate(async (url) => {
      const api = (globalThis as unknown as ChromeGlobal).chrome;
      const tab = (await api.tabs.query({})).find((item) => item.url === url)!;
      await api.tabs.sendMessage(
        tab.id!,
        { protocolVersion: 1, type: 'page.show', mode: 'read', autoTranslate: true },
        { frameId: 0 },
      );
    }, f.page.url());
    await expect(
      f.page.getByRole('dialog', { name: 'Sayvia 翻译' }).getByRole('status'),
    ).toHaveText('选区已变化，请重新选择原文。');
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
