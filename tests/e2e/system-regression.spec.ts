import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';
async function manual(f: Awaited<ReturnType<typeof workflowFixture>>) {
  const page = await f.context.newPage();
  await f.page.bringToFront();
  await page.goto(f.popup.url());
  await page.getByRole('tab', { name: '手动翻译', exact: true }).click();
  await expect(page.getByLabel('待翻译文本', { exact: true })).toBeEnabled();
  return page;
}
test('a manual popup cannot steal the active writing slot and can retry after explicit cancellation', async () => {
  const f = await workflowFixture();
  try {
    f.delay(30_000);
    await f.page.locator('#editor').focus();
    const writing = await f.open('write');
    await writing.getByRole('button', { name: '翻译', exact: true }).click();
    await expect.poll(f.pending).toBe(1);
    const popup = await manual(f);
    await popup.getByLabel('待翻译文本', { exact: true }).fill('你好');
    await popup.getByRole('button', { name: '翻译文本', exact: true }).click();
    await expect(popup.getByRole('status')).toHaveText(
      '当前已有翻译正在处理，请等待或取消后再试。',
    );
    await expect(popup.getByLabel('待翻译文本', { exact: true })).toHaveValue('你好');
    expect(f.count()).toBe(1);
    expect(f.pending()).toBe(1);
    await writing.getByRole('button', { name: '取消翻译', exact: true }).click();
    await expect.poll(f.pending).toBe(0);
    f.delay(0);
    await popup.getByRole('button', { name: '翻译文本', exact: true }).click();
    await expect(popup.getByLabel('手动译文', { exact: true })).toHaveValue('English');
    expect(f.count()).toBe(2);
  } finally {
    await f.close();
  }
});
test('clearing configuration cancels a manual fetch and clears the open popup without restoring old text', async () => {
  const f = await workflowFixture();
  try {
    f.delay(30_000);
    const popup = await manual(f);
    await popup.getByLabel('待翻译文本', { exact: true }).fill('private running draft');
    await popup.getByRole('button', { name: '翻译文本', exact: true }).click();
    await expect.poll(f.pending).toBe(1);
    await f.settings.getByRole('button', { name: '权限与数据', exact: true }).click();
    await f.settings.getByLabel('同时撤销已授权主机').uncheck();
    f.settings.once('dialog', (dialog) => void dialog.accept());
    await f.settings.getByRole('button', { name: '清除全部本地数据', exact: true }).click();
    await expect.poll(f.pending).toBe(0);
    await expect(popup.getByLabel('待翻译文本', { exact: true })).toHaveValue('');
    await expect(popup.getByLabel('手动译文', { exact: true })).toHaveValue('');
    await expect(popup.getByRole('button', { name: '翻译文本', exact: true })).toBeDisabled();
    await expect(f.page.locator('#editor')).toHaveValue('前缀 中文 后缀');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
test('competing popup windows retain the rejected local text and block a stale translation', async () => {
  const f = await workflowFixture();
  try {
    const first = await manual(f);
    await first.getByLabel('待翻译文本', { exact: true }).fill('initial draft');
    await expect(first.getByRole('button', { name: '翻译文本', exact: true })).toBeEnabled();
    const second = await manual(f);
    await expect(second.getByLabel('待翻译文本', { exact: true })).toHaveValue('initial draft');
    await first.getByLabel('待翻译文本', { exact: true }).fill('newer first draft');
    await expect(first.getByRole('button', { name: '翻译文本', exact: true })).toBeEnabled();
    await second.getByLabel('待翻译文本', { exact: true }).fill('rejected local draft');
    await expect(second.getByRole('status')).toContainText('其他窗口修改或清除');
    await expect(second.getByLabel('待翻译文本', { exact: true })).toHaveValue(
      'rejected local draft',
    );
    await expect(second.getByRole('button', { name: '翻译文本', exact: true })).toBeDisabled();
    await first.close();
    const reopened = await manual(f);
    await expect(reopened.getByLabel('待翻译文本', { exact: true })).toHaveValue(
      'newer first draft',
    );
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
test('popup keyboard tabs can reach manual input and activate translation and copy', async () => {
  const f = await workflowFixture();
  try {
    const popup = await manual(f);
    await popup.getByRole('tab', { name: '当前页面', exact: true }).click();
    await popup.getByRole('tab', { name: '当前页面', exact: true }).press('ArrowRight');
    await expect(popup.getByRole('tab', { name: '手动翻译', exact: true })).toBeFocused();
    await popup.keyboard.press('Tab');
    await expect(popup.getByLabel('翻译模型', { exact: true })).toBeFocused();
    await popup.keyboard.press('Tab');
    await expect(popup.getByLabel('目标语言', { exact: true })).toBeFocused();
    await popup.keyboard.press('Tab');
    await expect(popup.getByLabel('待翻译文本', { exact: true })).toBeFocused();
    await popup.keyboard.insertText('你好');
    const translate = popup.getByRole('button', { name: '翻译文本', exact: true });
    await expect(translate).toBeEnabled();
    await popup.keyboard.press('Tab');
    await expect(popup.getByLabel('手动译文', { exact: true })).toBeFocused();
    await popup.keyboard.press('Tab');
    await expect(translate).toBeFocused();
    await popup.keyboard.press('Enter');
    await expect(popup.getByLabel('手动译文', { exact: true })).toHaveValue('English');
    await popup.getByRole('button', { name: '复制手动译文', exact: true }).press('Enter');
    await expect(popup.getByRole('status')).toHaveText('已复制译文。');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
