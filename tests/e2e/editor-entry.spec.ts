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
    markdown-toolbar, [role="toolbar"] { display:flex; justify-content:flex-end; align-items:center; gap:6px; padding:8px; background:#f6f8fa; border:1px solid #c6d2c9; border-bottom:0; }
    markdown-toolbar > button { border:0; background:transparent; color:inherit; font:600 14px system-ui; width:28px; height:28px; }
    textarea { display: block; width: 100%; min-height: 120px; padding: 12px; box-sizing: border-box; border: 1px solid #c6d2c9; border-radius: 8px; font: inherit; background: transparent; color: inherit; }
    @media(prefers-color-scheme: dark) { body { color: #e6eee8; background: #1b2421; } }
    </style></head><body><h1>GitHub comment fixture</h1><p>Self-authored page; no GitHub account or private content.</p>
    <form><markdown-toolbar for="comment-one" aria-label="格式工具栏"><button type="button" aria-label="加粗">B</button><button type="button" aria-label="插入链接">↗</button></markdown-toolbar><textarea id="comment-one" name="comment[body]">前缀 中文 后缀</textarea><button type="submit">模拟提交</button><output id="submitted">0</output></form>
    <textarea id="other">另一份草稿</textarea><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#submitted').textContent='1'}</script></body></html>`,
    }),
  );
  await f.page.goto(url);
  return f;
}
test('an enabled GitHub editor has its own trusted direct entry, preserving selection and never submitting', async () => {
  const f = await githubFixture();
  try {
    const button = f.page.getByRole('button', { name: '使用 Sayvia 翻译这份评论', exact: true });
    await expect(button).toHaveCount(1);
    await expect(
      f.page.locator('markdown-toolbar[for="comment-one"] [data-sayvia-write-entry]'),
    ).toHaveCount(1);
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
    const buttons = f.page.getByRole('button', { name: '使用 Sayvia 翻译这份评论', exact: true });
    await expect(buttons).toHaveCount(1);
    await f.page.evaluate(() => {
      const editor = document.createElement('textarea');
      editor.name = 'comment[body]';
      editor.value = '你好';
      editor.id = 'dynamic';
      const toolbar = document.createElement('markdown-toolbar');
      toolbar.setAttribute('for', 'dynamic');
      document.body.append(toolbar, editor);
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
    await f.blockSite('https://github.com');
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

test('writing popover opens next to the toolbar trigger rather than the viewport corner', async () => {
  const f = await githubFixture();
  try {
    await f.page.setViewportSize({ width: 1280, height: 950 });
    await f.page.locator('form').evaluate((element) => {
      element.style.marginTop = '280px';
    });
    const button = f.page.getByRole('button', { name: '使用 Sayvia 翻译这份评论' });
    await expect(button).toBeVisible();
    await button.click();
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    const trigger = (await button.boundingBox())!,
      box = (await panel.boundingBox())!;
    expect(
      Math.min(
        Math.abs(box.y - trigger.y - trigger.height),
        Math.abs(box.y + box.height - trigger.y),
      ),
    ).toBeLessThanOrEqual(12);
    expect(box.x).toBeLessThanOrEqual(trigger.x + trigger.width);
    expect(box.x + box.width).toBeGreaterThanOrEqual(trigger.x);
    await f.page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '40px';
      document.body.prepend(spacer);
    });
    await expect
      .poll(async () => {
        const b = (await button.boundingBox())!,
          p = (await panel.boundingBox())!;
        return Math.min(Math.abs(p.y - b.y - b.height), Math.abs(p.y + p.height - b.y));
      })
      .toBeLessThanOrEqual(12);
  } finally {
    await f.close();
  }
});

test('toolbar discovery supports modern forms, delayed remounts and multiple editors without crossing drafts', async () => {
  const f = await githubFixture();
  try {
    await f.page.evaluate(() => {
      const form = document.createElement('form');
      form.id = 'modern';
      form.innerHTML =
        '<div role="toolbar" aria-label="格式"><button type="button">B</button></div><textarea id="second" name="comment[body]">第二份 中文</textarea>';
      const ambiguous = document.createElement('form');
      ambiguous.id = 'ambiguous';
      ambiguous.innerHTML =
        '<div role="toolbar"><button type="button">B</button></div><textarea name="comment[body]">不要猜测</textarea><textarea name="comment[body]">另一份</textarea>';
      document.body.append(form, ambiguous);
    });
    await expect(f.page.locator('#modern [data-sayvia-write-entry]')).toHaveCount(1);
    await expect(f.page.locator('#ambiguous [data-sayvia-write-entry]')).toHaveCount(0);
    await f.page.locator('#comment-one').focus();
    await f.page
      .locator('#modern')
      .getByRole('button', { name: '使用 Sayvia 翻译这份评论' })
      .click();
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('第二份 English');
    await panel.getByRole('button', { name: '替换全文', exact: true }).click();
    await expect(f.page.locator('#second')).toHaveValue('第二份 English');
    await expect(f.page.locator('#comment-one')).toHaveValue('前缀 中文 后缀');
    await panel.getByRole('button', { name: '关闭翻译面板' }).click();
    await f.page
      .locator('markdown-toolbar[for="comment-one"]')
      .evaluate((element) => element.remove());
    await expect(f.page.locator('[data-sayvia-write-entry]')).toHaveCount(1);
    await f.page
      .locator('form')
      .first()
      .evaluate((form) => {
        const toolbar = document.createElement('markdown-toolbar');
        toolbar.setAttribute('for', 'comment-one');
        toolbar.innerHTML = '<button type="button">B</button>';
        form.prepend(toolbar);
      });
    await expect(
      f.page.locator('markdown-toolbar[for="comment-one"] [data-sayvia-write-entry]'),
    ).toHaveCount(1);
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

test('anchored writing follows scrolling, flips above when needed and fits narrow viewports', async () => {
  const f = await githubFixture();
  try {
    await f.page.setViewportSize({ width: 900, height: 700 });
    await f.page.locator('form').evaluate((form) => {
      form.style.marginTop = '390px';
    });
    const button = f.page.getByRole('button', { name: '使用 Sayvia 翻译这份评论' });
    await button.click();
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    await expect
      .poll(async () => {
        const b = (await button.boundingBox())!,
          p = (await panel.boundingBox())!;
        return Math.abs(p.y + p.height + 8 - b.y);
      })
      .toBeLessThanOrEqual(3);
    await panel.screenshot({ path: test.info().outputPath('writing-popover-dark-or-light.png') });
    await panel.getByLabel('译文', { exact: true }).fill('Reviewed candidate');
    await f.page.evaluate(() => window.scrollBy(0, 100));
    await expect
      .poll(async () => {
        const b = (await button.boundingBox())!,
          p = (await panel.boundingBox())!;
        return Math.min(Math.abs(p.y - b.y - b.height), Math.abs(p.y + p.height - b.y));
      })
      .toBeLessThanOrEqual(12);
    await f.page.setViewportSize({ width: 375, height: 700 });
    await expect
      .poll(async () => {
        const p = (await panel.boundingBox())!;
        return p.x >= 0 && p.x + p.width <= 375 && p.y >= 0 && p.y + p.height <= 700;
      })
      .toBe(true);
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('Reviewed candidate');
    f.page.once('dialog', (d) => void d.accept());
    await panel.getByRole('button', { name: '关闭翻译面板' }).click();
    await expect(panel).toHaveCount(0);
    await f.page.setViewportSize({ width: 900, height: 700 });
    await expect(panel).toHaveCount(0);
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
