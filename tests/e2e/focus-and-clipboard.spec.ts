import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';
test('closing a reading dialog restores its own focus rather than an earlier writing editor', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    const writing = await f.open('write');
    await writing.getByRole('button', { name: '关闭翻译面板', exact: true }).click();
    await f.page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'reader-focus';
      p.tabIndex = 0;
      p.textContent = 'Read this first.';
      document.body.prepend(p);
      p.focus();
      const range = document.createRange();
      range.selectNodeContents(p);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    const reading = await f.open('read');
    await reading.getByRole('button', { name: '关闭翻译面板', exact: true }).click();
    await expect(f.page.locator('#reader-focus')).toBeFocused();
  } finally {
    await f.close();
  }
});
test('clipboard paste contains edited translation and conflict recovery copy keeps the exact original', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    await panel.getByLabel('译文', { exact: true }).fill('Reviewed clipboard result');
    await panel.getByRole('button', { name: '复制译文', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('已复制。');
    await expect(f.page.locator('#editor')).toHaveValue('前缀 中文 后缀');
    await f.page.evaluate(() => {
      const box = document.createElement('textarea');
      box.id = 'paste-target';
      document.body.prepend(box);
    });
    await f.page.bringToFront();
    await f.page.locator('#paste-target').focus();
    await f.page.keyboard.press('ControlOrMeta+V');
    await expect(f.page.locator('#paste-target')).toHaveValue('Reviewed clipboard result');
    await panel.getByRole('button', { name: '替换全文', exact: true }).click();
    await expect(f.page.locator('#editor')).toHaveValue('Reviewed clipboard result');
    await expect(panel.getByRole('status')).toHaveText('已替换，可恢复原文。');
    await f.page.locator('#editor').fill('new user draft');
    await expect(panel.getByRole('button', { name: '恢复原文', exact: true })).toBeDisabled();
    await panel.getByRole('button', { name: '复制替换前原文', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('已复制。');
    await f.page.locator('#paste-target').fill('');
    await f.page.keyboard.press('ControlOrMeta+V');
    await expect(f.page.locator('#paste-target')).toHaveValue('前缀 中文 后缀');
    await expect(f.page.locator('#editor')).toHaveValue('new user draft');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
