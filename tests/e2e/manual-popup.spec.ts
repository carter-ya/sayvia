import { expect, test, type Page } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';
import type { browser } from 'wxt/browser';
async function popup(f: Awaited<ReturnType<typeof workflowFixture>>, target: Page = f.page) {
  const url = f.popup.url();
  const result = await f.context.newPage();
  await target.bringToFront();
  await result.goto(url);
  await result.getByRole('tab', { name: '手动翻译', exact: true }).click();
  await expect(result.getByLabel('待翻译文本', { exact: true })).toBeEnabled();
  return result;
}
test('unsent drafts and edited manual results survive immediate popup closure without changing the website', async () => {
  const f = await workflowFixture();
  try {
    let p = await popup(f);
    await p.getByLabel('待翻译文本', { exact: true }).fill('你好');
    await p.close();
    p = await popup(f);
    await expect(p.getByLabel('待翻译文本', { exact: true })).toHaveValue('你好');
    expect(f.count()).toBe(0);
    await p.getByRole('button', { name: '翻译文本', exact: true }).click();
    await expect(p.getByLabel('手动译文', { exact: true })).toHaveValue('English');
    await p.getByLabel('手动译文', { exact: true }).fill('Reviewed English');
    await p.close();
    p = await popup(f);
    await expect(p.getByLabel('手动译文', { exact: true })).toHaveValue('Reviewed English');
    await p.getByRole('button', { name: '复制手动译文', exact: true }).click();
    await expect(p.getByRole('status')).toHaveText('已复制译文。');
    await expect(f.page.locator('#editor')).toHaveValue('前缀 中文 后缀');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
test('manual work finishes while closed and can be canceled after reopening, without replay', async () => {
  const f = await workflowFixture();
  try {
    f.delay(800);
    let p = await popup(f);
    await p.getByLabel('待翻译文本', { exact: true }).fill('你好');
    await p.getByRole('button', { name: '翻译文本', exact: true }).click();
    await expect.poll(f.count).toBe(1);
    await p.close();
    p = await popup(f);
    await expect(p.getByLabel('手动译文', { exact: true })).toHaveValue('English');
    expect(f.count()).toBe(1);
    f.delay(30_000);
    await p.getByRole('button', { name: '翻译文本', exact: true }).click();
    await expect.poll(f.pending).toBe(1);
    await p.getByRole('button', { name: '取消翻译', exact: true }).click();
    await expect.poll(f.pending).toBe(0);
    expect(f.count()).toBe(2);
  } finally {
    await f.close();
  }
});
test('manual drafts belong to the captured tab and are removed by clear-all in another window', async () => {
  const f = await workflowFixture();
  try {
    const p = await popup(f);
    await p.getByLabel('待翻译文本', { exact: true }).fill('private draft one');
    const second = await f.context.newPage();
    await second.goto(`${f.page.url()}?second`);
    const other = await popup(f, second);
    await expect(other.getByLabel('待翻译文本', { exact: true })).toHaveValue('');
    await other.getByLabel('待翻译文本', { exact: true }).fill('private draft two');
    await f.settings.getByRole('button', { name: '权限与数据', exact: true }).click();
    await f.settings.getByLabel('同时撤销已授权主机').uncheck();
    f.settings.once('dialog', (dialog) => void dialog.accept());
    await f.settings.getByRole('button', { name: '清除全部本地数据', exact: true }).click();
    await expect(p.getByLabel('待翻译文本', { exact: true })).toHaveValue('');
    await expect(other.getByLabel('待翻译文本', { exact: true })).toHaveValue('');
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});

for (const restored of [false, true]) {
  test(`cancel targets the new request before the start reply (${restored ? 'restored draft' : 'fresh popup'})`, async () => {
    const f = await workflowFixture();
    try {
      let p = await popup(f);
      if (restored) {
        await p.getByLabel('待翻译文本', { exact: true }).fill('你好');
        await p.getByRole('button', { name: '翻译文本', exact: true }).click();
        await expect(p.getByLabel('手动译文', { exact: true })).toHaveValue('English');
        await p.close();
        p = await popup(f);
      }
      await p.getByLabel('待翻译文本', { exact: true }).fill('中文');
      await p.evaluate(() => {
        const chrome = (globalThis as unknown as { chrome: typeof browser }).chrome;
        const original = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = ((request: { type?: string }) => {
          const reply = original(request);
          if (request.type !== 'translation.start') return reply;
          return reply.then(
            (value) => new Promise((resolve) => setTimeout(() => resolve(value), 2500)),
          );
        }) as typeof chrome.runtime.sendMessage;
      });
      f.delay(30_000);
      await p.getByRole('button', { name: '翻译文本', exact: true }).click();
      await expect.poll(f.pending).toBe(1);
      await p.getByRole('button', { name: '取消翻译', exact: true }).click();
      await expect.poll(f.pending, { timeout: 1500 }).toBe(0);
      await expect(p.getByRole('button', { name: '翻译文本', exact: true })).toBeEnabled();
      expect(f.count()).toBe(restored ? 2 : 1);
    } finally {
      await f.close();
    }
  });
}
