import { expect, test } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { workflowFixture } from '../fixtures/core-workflow-extension';
const url = 'https://github.com/sayvia-fixture/repo/issues/1';
async function githubFixture() {
  const f = await workflowFixture();
  await f.context.route(url, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font: 14px/1.6 system-ui; max-width: 780px; margin: 36px auto; padding: 20px; color: #26362e; background: #fffefa; }
    textarea { display: block; width: 100%; min-height: 120px; padding: 12px; box-sizing: border-box; border: 1px solid #c6d2c9; border-radius: 8px; font: inherit; background: transparent; color: inherit; }
    @media(prefers-color-scheme: dark) { body { color: #e6eee8; background: #1b2421; } }
    </style></head><body><h1>GitHub comment fixture</h1><p>Self-authored page; no GitHub account or private content.</p>
    <form><textarea id="comment-one" name="comment[body]">前缀 中文 后缀</textarea><button type="submit">模拟提交</button><output id="submitted">0</output></form>
    <textarea id="other">另一份草稿</textarea><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#submitted').textContent='1'}</script></body></html>`,
    }),
  );
  await f.page.goto(url);
  return f;
}
async function enable(f: Awaited<ReturnType<typeof workflowFixture>>) {
  await f.settings.getByRole('button', { name: '权限与数据', exact: true }).click();
  await f.settings.getByLabel('网站地址').fill(url);
  await f.settings.getByRole('button', { name: '授权此网站', exact: true }).click();
}
test('an enabled GitHub editor has its own trusted direct entry, preserving selection and never submitting', async () => {
  const f = await githubFixture();
  try {
    const button = f.page.getByRole('button', { name: '使用 Sayvia 翻译这份评论', exact: true });
    await expect(button).toHaveCount(0);
    await enable(f);
    await expect(button).toHaveCount(1);
    await f.page.screenshot({ path: test.info().outputPath('writing-entry-light.png') });
    await f.page.emulateMedia({ colorScheme: 'dark' });
    await f.page.screenshot({ path: test.info().outputPath('writing-entry-dark.png') });
    await f.page.locator('#comment-one').evaluate((element: HTMLTextAreaElement) => {
      element.focus();
      element.setSelectionRange(3, 5);
    });
    await f.page.locator('#other').focus();
    await button.evaluate((element: HTMLButtonElement) => element.click());
    expect(f.count()).toBe(0);
    await expect(f.page.getByRole('dialog')).toHaveCount(0);
    await button.click();
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('中文');
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English');
    await expect(f.page.locator('#comment-one')).toHaveValue('前缀 中文 后缀');
    await panel.getByRole('button', { name: '替换选区', exact: true }).click();
    await expect(f.page.locator('#comment-one')).toHaveValue('前缀 English 后缀');
    await expect(f.page.locator('#other')).toHaveValue('另一份草稿');
    await expect(f.page.locator('#submitted')).toHaveText('0');
    await panel.getByRole('button', { name: '恢复原文', exact: true }).click();
    await expect(f.page.locator('#comment-one')).toHaveValue('前缀 中文 后缀');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
test('dynamic editors deduplicate, re-check eligibility and remove entries and running work when disabled', async () => {
  const f = await githubFixture();
  try {
    await enable(f);
    const buttons = f.page.getByRole('button', { name: '使用 Sayvia 翻译这份评论', exact: true });
    await expect(buttons).toHaveCount(1);
    await f.page.evaluate(() => {
      const editor = document.createElement('textarea');
      editor.name = 'comment[body]';
      editor.value = '你好';
      editor.id = 'dynamic';
      document.body.append(editor);
    });
    await expect(buttons).toHaveCount(2);
    await f.page.locator('#comment-one').evaluate((element: HTMLTextAreaElement) => {
      element.readOnly = true;
    });
    await expect(buttons).toHaveCount(1);
    await f.page.locator('#comment-one').evaluate((element: HTMLTextAreaElement) => {
      element.readOnly = false;
    });
    await expect(buttons).toHaveCount(2);
    await f.settings.evaluate(async (url) => {
      const api = (globalThis as unknown as { chrome: typeof browser }).chrome;
      const tab = (await api.tabs.query({})).find((tab) => tab.url === url)!;
      await api.scripting.executeScript({
        target: { tabId: tab.id! },
        files: ['/content-scripts/translator.js'],
      });
    }, url);
    await expect(buttons).toHaveCount(2);
    await f.page.locator('#dynamic').evaluate((element: HTMLTextAreaElement) => {
      element.name = 'unsupported';
    });
    await expect(buttons).toHaveCount(1);
    await f.page.locator('#comment-one').evaluate((element) => element.remove());
    await expect(buttons).toHaveCount(0);
    await f.page.locator('#dynamic').evaluate((element: HTMLTextAreaElement) => {
      element.name = 'comment[body]';
    });
    await expect(buttons).toHaveCount(1);
    f.delay(30_000);
    await buttons.click();
    await expect.poll(f.pending).toBe(1);
    await buttons.focus();
    await f.page.keyboard.press('Enter');
    expect(f.count()).toBe(1);
    await f.settings.getByRole('button', { name: '停用 https://github.com', exact: true }).click();
    await expect.poll(f.pending).toBe(0);
    await expect(buttons).toHaveCount(0);
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

test('same-document navigation removes GitHub entries outside the supported Issue and PR routes', async () => {
  const f = await githubFixture();
  try {
    await enable(f);
    const button = f.page.getByRole('button', { name: '使用 Sayvia 翻译这份评论', exact: true });
    await expect(button).toHaveCount(1);
    await f.page.evaluate(() => history.pushState({}, '', '/sayvia-fixture/repo/discussions/2'));
    await expect(button).toHaveCount(0);
    await f.page.evaluate(() => history.pushState({}, '', '/sayvia-fixture/repo/pull/2'));
    await expect(button).toHaveCount(1);
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
