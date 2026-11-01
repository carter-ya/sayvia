import { expect, test } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { workflowFixture } from '../fixtures/core-workflow-extension';
type ChromeGlobal = { chrome: typeof browser };

test('API grants never opt in to website capture; explicit enable registers current and future documents', async () => {
  const f = await workflowFixture();
  try {
    await expect(f.page.locator('[data-sayvia-ui]')).toHaveCount(0);
    await f.settings.getByRole('button', { name: '权限与数据', exact: true }).click();
    await f.settings.getByLabel('网站地址').fill(f.page.url());
    await f.settings.getByRole('button', { name: '授权此网站', exact: true }).click();
    await expect(f.settings.getByRole('note')).toContainText('已启用网站入口');
    await expect(f.page.locator('[data-sayvia-ui]')).toHaveCount(1);
    const scripts = await f.settings.evaluate(() =>
      (globalThis as unknown as ChromeGlobal).chrome.scripting.getRegisteredContentScripts(),
    );
    expect(scripts).toEqual([
      expect.objectContaining({
        id: 'sayvia-selection-v1',
        matches: ['http://127.0.0.1/*'],
        allFrames: false,
        persistAcrossSessions: true,
      }),
    ]);
    await f.page.reload();
    await expect(f.page.locator('[data-sayvia-ui]')).toHaveCount(1);
    expect(f.count()).toBe(0);
    await f.settings.getByRole('button', { name: '停用 http://127.0.0.1', exact: true }).click();
    await expect(f.settings.getByRole('note')).toContainText('已停用网站自动入口');
    expect(
      await f.settings.evaluate(() =>
        (globalThis as unknown as ChromeGlobal).chrome.permissions.contains({
          origins: ['http://127.0.0.1/*'],
        }),
      ),
    ).toBe(true);
    await f.page.reload();
    await expect(f.page.locator('[data-sayvia-ui]')).toHaveCount(0);
    // Stopping automatic capture does not revoke the shared API host grant.
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

test('real duplicate bundle injection preserves an edited candidate and its original source', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    await panel.getByLabel('译文', { exact: true }).fill('My reviewed candidate');
    await f.settings.evaluate(async (url) => {
      const api = (globalThis as unknown as ChromeGlobal).chrome;
      const tab = (await api.tabs.query({})).find((item) => item.url === url)!;
      await api.scripting.executeScript({
        target: { tabId: tab.id!, frameIds: [0] },
        files: ['/content-scripts/translator.js'],
      });
      await api.scripting.executeScript({
        target: { tabId: tab.id!, frameIds: [0] },
        files: ['/content-scripts/translator.js'],
      });
    }, f.page.url());
    await expect(f.page.locator('[data-sayvia-ui]')).toHaveCount(1);
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('My reviewed candidate');
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('前缀 中文 后缀');
    await panel.getByRole('button', { name: '替换全文', exact: true }).click();
    await expect(f.page.locator('#editor')).toHaveValue('My reviewed candidate');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
