import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';

// Public comment excerpt and markup from bugs.mysql.com/bug.php?id=116731 (c548791).
const original =
  'Probably I can use information_schema to find all columns than concat everything to single string for \nJSON_OBJECT, and use prepare/execute inside trigger to get compiled result...';
const translated =
  '也许我可以使用 information_schema 查找所有列，然后把所有内容拼接成一个字符串，传给 \nJSON_OBJECT，再在触发器内使用 prepare/execute 来获得编译后的结果……';

test('a MySQL pre.note selection calls the model and displays a translation instead of echoing prose', async () => {
  const f = await workflowFixture();
  try {
    await f.context.route('https://bugs.mysql.com/bug.php?id=116731', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html><body><div class="comment" id="c548791"><div class="header">PUBLIC COMMENT HEADER</div><pre class="note" style="white-space:pre-wrap;max-width:600px;margin:80px 20px">${original}</pre></div></body></html>`,
      }),
    );
    const page = await f.context.newPage();
    await page.goto('https://bugs.mysql.com/bug.php?id=116731');
    await expect(page.locator('[data-sayvia-entry]')).toHaveCount(1);
    const before = await page.locator('#c548791').innerHTML();
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('pre.note')!);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press('Shift');
    await page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' }).click();
    const panel = page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await expect(panel.getByLabel('目标语言', { exact: true })).toHaveValue('zh-Hans');
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue(translated);
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue(original);
    expect(f.count()).toBe(1);
    expect(f.requestBodies[0]).toContain('Probably I can use information_schema');
    expect(f.requestBodies[0]).not.toContain('PUBLIC COMMENT HEADER');
    expect(await page.locator('#c548791').innerHTML()).toBe(before);
    await panel.getByRole('button', { name: '复制译文' }).click();
    await expect(panel.getByRole('status')).toHaveText('已复制。');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
