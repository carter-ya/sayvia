import { expect, test, type Page } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';
const sentLanguage = (body: string) =>
  JSON.parse(JSON.parse(body).messages[1].content).sourceLanguage;
async function manual(f: Awaited<ReturnType<typeof workflowFixture>>) {
  const p: Page = await f.context.newPage();
  await f.page.bringToFront();
  await p.goto(f.popup.url());
  await p.getByRole('tab', { name: '手动翻译', exact: true }).click();
  await expect(p.getByLabel('源语言', { exact: true })).toBeEnabled();
  return p;
}
test('writing sends an explicit source language and changing it discards replacement eligibility', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await expect(panel.getByLabel('源语言', { exact: true })).toHaveValue('auto');
    await panel.getByLabel('源语言', { exact: true }).selectOption('zh-Hans');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    expect(sentLanguage(f.requestBodies[0]!)).toBe('zh-Hans');
    await panel.getByLabel('源语言', { exact: true }).selectOption('custom');
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('');
    await expect(panel.getByRole('button', { name: '翻译', exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: '替换全文', exact: true })).toBeDisabled();
    expect(f.count()).toBe(1);
    await panel.getByLabel('自定义源语言', { exact: true }).fill('Chinese');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    expect(sentLanguage(f.requestBodies[1]!)).toBe('Chinese');
    await expect(f.page.locator('#editor')).toHaveValue('前缀 中文 后缀');
  } finally {
    await f.close();
  }
});
test('reading can override source detection without losing rendered code protection', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      const p = document.createElement('p');
      p.innerHTML = 'Read <code>timeout</code> first.';
      document.body.append(p);
      const range = document.createRange();
      range.selectNodeContents(p);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    const panel = await f.open('read');
    await panel.getByLabel('源语言', { exact: true }).selectOption('en');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('阅读 timeout 优先。');
    expect(sentLanguage(f.requestBodies[0]!)).toBe('en');
    expect(f.requestBodies[0]).not.toContain('timeout');
    await panel.getByLabel('源语言', { exact: true }).selectOption('auto');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('阅读 timeout 优先。');
    expect(sentLanguage(f.requestBodies[1]!)).toBe('auto');
  } finally {
    await f.close();
  }
});
test('manual source language survives immediate popup closure, execution and a later draft edit', async () => {
  const f = await workflowFixture();
  try {
    let p = await manual(f);
    await expect(p.getByLabel('源语言', { exact: true })).toHaveValue('auto');
    await p.getByLabel('待翻译文本', { exact: true }).fill('你好');
    await p.getByLabel('源语言', { exact: true }).selectOption('zh-Hans');
    await p.close();
    p = await manual(f);
    await expect(p.getByLabel('源语言', { exact: true })).toHaveValue('zh-Hans');
    expect(f.count()).toBe(0);
    await p.getByRole('button', { name: '翻译文本', exact: true }).click();
    await expect(p.getByLabel('手动译文', { exact: true })).toHaveValue('English');
    expect(sentLanguage(f.requestBodies[0]!)).toBe('zh-Hans');
    await p.locator('.popup').evaluate((element) => {
      element.scrollTop = 0;
    });
    const action = await p.getByRole('button', { name: '翻译文本', exact: true }).boundingBox();
    expect(action!.y + action!.height).toBeLessThanOrEqual(590);
    await p
      .locator('.popup')
      .screenshot({ path: test.info().outputPath('source-language-ready.png') });
    await p.getByLabel('源语言', { exact: true }).selectOption('ja');
    await expect(p.getByLabel('手动译文', { exact: true })).toHaveValue('');
    await p.close();
    p = await manual(f);
    await expect(p.getByLabel('源语言', { exact: true })).toHaveValue('ja');
    await expect(p.getByLabel('待翻译文本', { exact: true })).toHaveValue('你好');
    await expect(p.getByLabel('手动译文', { exact: true })).toHaveValue('');
    expect(f.count()).toBe(1);
    await p
      .locator('.popup')
      .screenshot({ path: test.info().outputPath('source-language-manual.png') });
  } finally {
    await f.close();
  }
});
