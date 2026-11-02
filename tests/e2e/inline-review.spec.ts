import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';
const url = 'https://github.com/sayvia-fixture/repo/pull/3/changes';
async function fixture() {
  const f = await workflowFixture();
  await f.context.route(url, (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset=utf-8><style>body{margin:40px;font:14px system-ui}form{padding:14px;border:1px solid #bbb;margin:20px 0}textarea{display:block;width:100%;height:110px}markdown-toolbar,[role=toolbar]{display:flex;justify-content:flex-end;gap:6px;padding:8px;background:#f6f8fa}</style><h2>Add a comment on line R42</h2><form id=inline><markdown-toolbar for=review-body><button type=button>B</button></markdown-toolbar><textarea id=review-body name="review_comment[body]">前缀 中文 后缀</textarea><button type=submit>Start a review</button><output class=sent>0</output><output class=state>前缀 中文 后缀</output></form><form id=modern data-testid=markdown-editor><div role=toolbar><button type=button>B</button></div><textarea id=modern-body data-testid=markdown-editor-textarea>你好 \`sql.Scanner\`</textarea><button type=submit>Add review comment</button><output class=sent>0</output><output class=state>你好 \`sql.Scanner\`</output></form><textarea id=unrelated>不要修改</textarea><script>for(const form of document.forms){form.addEventListener('input',e=>form.querySelector('.state').textContent=e.target.value);form.onsubmit=e=>{e.preventDefault();form.querySelector('.sent').textContent='1'}}</script>`,
    }),
  );
  await f.page.goto(url);
  return f;
}
test('inline review toolbar translates its own selected draft and replaces/restores without submitting', async () => {
  const f = await fixture();
  try {
    const form = f.page.locator('#inline'),
      field = form.locator('textarea');
    const button = form.getByRole('button', { name: '使用 Sayvia 翻译这份评论' });
    await expect(button).toBeVisible();
    await field.focus();
    await field.press('ControlOrMeta+A');
    await field.press('ArrowLeft');
    await field.press('ArrowRight');
    await field.press('ArrowRight');
    await field.press('ArrowRight');
    await field.press('Shift+ArrowRight');
    await field.press('Shift+ArrowRight');
    await button.click();
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('中文');
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English');
    await panel.getByRole('button', { name: '替换选区', exact: true }).click();
    await expect(field).toHaveValue('前缀 English 后缀');
    await expect(form.locator('.state')).toHaveText('前缀 English 后缀');
    await expect(f.page.locator('#modern-body')).toHaveValue('你好 `sql.Scanner`');
    await expect(form.locator('.sent')).toHaveText('0');
    await panel.getByRole('button', { name: '恢复原文', exact: true }).click();
    await expect(field).toHaveValue('前缀 中文 后缀');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
test('modern review composer has a scoped toolbar entry with Markdown protection', async () => {
  const f = await fixture();
  try {
    const form = f.page.locator('#modern');
    await form.getByRole('button', { name: '使用 Sayvia 翻译这份评论' }).click();
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English `sql.Scanner`');
    expect(f.requestBodies[0]).not.toContain('sql.Scanner');
    await panel.getByRole('button', { name: '替换全文', exact: true }).click();
    await expect(form.locator('textarea')).toHaveValue('English `sql.Scanner`');
    await expect(form.locator('.state')).toHaveText('English `sql.Scanner`');
    await expect(form.locator('.sent')).toHaveText('0');
    await expect(f.page.locator('#unrelated')).toHaveValue('不要修改');
  } finally {
    await f.close();
  }
});

test('a native mouse selection in an inline review has a small nearby writing entry', async () => {
  const f = await fixture();
  try {
    const field = f.page.locator('#review-body');
    await field.fill('中文');
    await field.click({ clickCount: 3, position: { x: 20, y: 12 } });
    const button = f.page.getByRole('button', { name: '使用 Sayvia 翻译输入选区' });
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!,
      editor = (await field.boundingBox())!;
    expect(box.width).toBe(26);
    expect(Math.abs(box.x - (editor.x + 28))).toBeLessThanOrEqual(3);
    expect(Math.abs(box.y - (editor.y + 22))).toBeLessThanOrEqual(3);
    expect(f.count()).toBe(0);
    await button.click();
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English');
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('中文');
    await panel.getByRole('button', { name: '替换选区', exact: true }).click();
    await expect(field).toHaveValue('English');
    await expect(f.page.locator('#inline .state')).toHaveText('English');
    await expect(f.page.locator('#inline .sent')).toHaveText('0');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
test('a script-changed range or draft cannot reuse the earlier trusted editor selection', async () => {
  const f = await fixture();
  try {
    const field = f.page.locator('#review-body');
    await field.focus();
    await field.press('ControlOrMeta+A');
    const button = f.page.getByRole('button', { name: '使用 Sayvia 翻译输入选区' });
    await expect(button).toBeVisible();
    await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 1));
    await button.click();
    expect(f.count()).toBe(0);
    await expect(f.page.getByRole('dialog', { name: 'Sayvia 翻译' })).toHaveCount(0);
    await field.focus();
    await field.press('ControlOrMeta+A');
    await expect(button).toBeVisible();
    await field.evaluate((el: HTMLTextAreaElement) => {
      el.value = 'changed draft';
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    });
    await expect(button).toBeHidden();
    expect(f.count()).toBe(0);
    await f.page.locator('#unrelated').focus();
    await f.page.locator('#unrelated').press('ControlOrMeta+A');
    await expect(button).toBeHidden();
  } finally {
    await f.close();
  }
});
test('dynamically opened review editors gain entries and remove them when closed or disabled', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      const parent = document.createElement('form');
      parent.id = 'dynamic-review';
      parent.innerHTML =
        '<div role="toolbar"><button type="button">B</button></div><textarea name="review_comment[body]">中文</textarea>';
      document.body.append(parent);
    });
    const form = f.page.locator('#dynamic-review'),
      button = form.getByRole('button', { name: '使用 Sayvia 翻译这份评论' });
    await expect(button).toBeVisible();
    await form.locator('textarea').evaluate((el: HTMLTextAreaElement) => {
      el.readOnly = true;
    });
    await expect(button).toHaveCount(0);
    await form.locator('textarea').evaluate((el: HTMLTextAreaElement) => {
      el.readOnly = false;
    });
    await expect(button).toBeVisible();
    // Settle native focus scrolling, then use the platform select-all shortcut;
    // Home/End may scroll rather than move the caret on macOS.
    await form.locator('textarea').click();
    await f.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await form.locator('textarea').press('ControlOrMeta+A');
    await expect(f.page.getByRole('button', { name: '使用 Sayvia 翻译输入选区' })).toBeVisible();
    await form.evaluate((el) => el.remove());
    await expect(f.page.getByRole('button', { name: '使用 Sayvia 翻译输入选区' })).toBeHidden();
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
