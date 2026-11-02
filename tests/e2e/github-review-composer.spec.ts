import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';
import { reviewComposer } from '../fixtures/github-review-composer';
const url = 'https://github.com/sayvia-fixture/repo/pull/15/changes';
async function fixture() {
  const f = await workflowFixture();
  await f.context.route(url, (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><style>body{font:14px system-ui;margin:30px}fieldset{margin:20px;padding:16px}textarea{display:block;width:100%;height:120px}[role=toolbar]{display:flex;justify-content:flex-end;background:#f6f8fa;padding:8px}.header__3BFPRT{display:flex}nav{flex:0 0 auto}[data-component=ActionBar]{display:flex;flex:1 1 0;overflow:hidden}[role=toolbar]{flex:0 1 auto;overflow:hidden}.prc-ActionBar-OverflowContainer-AkYZs{display:flex;flex:0 1 auto;overflow:hidden}[role=toolbar] button{flex:0 0 auto;min-width:32px}</style><h1>Add a comment on line R455</h1>${reviewComposer('_r_nc_')}${reviewComposer('_r_other_', '另一份草稿')}<fieldset id=unrelated><div role=toolbar>B</div><textarea id=other data-component=Textarea aria-label="Markdown value">无关联的编辑框</textarea></fieldset>`,
    }),
  );
  await f.page.goto(url);
  return f;
}
test('the observed fieldset composer mounts in the visible ActionBar and translates its own full draft', async () => {
  const f = await fixture();
  try {
    const composer = f.page.locator('#_r_nc_-composer');
    const button = composer.getByRole('button', { name: '使用 Sayvia 翻译这份评论' });
    await expect(button).toBeVisible();
    await expect(composer.locator('markdown-toolbar [data-sayvia-write-entry]')).toHaveCount(0);
    await expect(
      composer.locator('[aria-label="Formatting tools"] [data-sayvia-write-entry]'),
    ).toHaveCount(1);
    await expect(f.page.locator('#unrelated [data-sayvia-write-entry]')).toHaveCount(0);
    await f.page.setViewportSize({ width: 420, height: 800 });
    const toolbarBox = (await composer.locator('[aria-label="Formatting tools"]').boundingBox())!;
    const buttonBox = (await button.boundingBox())!;
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(toolbarBox.x + toolbarBox.width + 1);
    await button.click();
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English `sql.Scanner`');
    expect(f.requestBodies[0]).not.toContain('sql.Scanner');
    await panel.getByRole('button', { name: '替换全文', exact: true }).click();
    await expect(f.page.locator('#_r_nc_')).toHaveValue('English `sql.Scanner`');
    await expect(f.page.locator('#_r_other_')).toHaveValue('另一份草稿');
    await expect(composer.locator('output')).toHaveText('not submitted');
    await panel.getByRole('button', { name: '恢复原文', exact: true }).click();
    await expect(f.page.locator('#_r_nc_')).toHaveValue('你好 `sql.Scanner`');
    await f.page.screenshot({ path: test.info().outputPath('review-composer-translation.png') });
  } finally {
    await f.close();
  }
});
test('the observed composer supports trusted mouse-selected draft translation', async () => {
  const f = await fixture();
  try {
    const field = f.page.locator('#_r_nc_');
    await field.fill('中文');
    await field.click({ clickCount: 3, position: { x: 20, y: 12 } });
    const button = f.page.getByRole('button', { name: '使用 Sayvia 翻译输入选区' });
    await expect(button).toBeVisible();
    expect(f.count()).toBe(0);
    await button.click();
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('中文');
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English');
    await panel.getByRole('button', { name: '替换选区', exact: true }).click();
    await expect(field).toHaveValue('English');
    await expect(f.page.locator('#_r_other_')).toHaveValue('另一份草稿');
    await expect(f.page.locator('#_r_nc_-composer output')).toHaveText('not submitted');
  } finally {
    await f.close();
  }
});
test('a fieldset composer remount follows its own toolbar and loses eligibility when its association changes', async () => {
  const f = await fixture();
  try {
    const composer = f.page.locator('#_r_nc_-composer');
    const button = composer.getByRole('button', { name: '使用 Sayvia 翻译这份评论' });
    await expect(button).toBeVisible();
    await composer.evaluate((el) => el.remove());
    await f.page.evaluate(
      (html) => document.body.insertAdjacentHTML('beforeend', html),
      reviewComposer('_r_new_'),
    );
    const next = f.page.locator('#_r_new_-composer');
    await expect(next.getByRole('button', { name: '使用 Sayvia 翻译这份评论' })).toBeVisible();
    await next.locator('markdown-toolbar').evaluate((el) => el.setAttribute('for', 'other'));
    await expect(next.locator('[data-sayvia-write-entry]')).toHaveCount(0);
    await next.locator('markdown-toolbar').evaluate((el) => el.setAttribute('for', '_r_new_'));
    await expect(next.locator('[data-sayvia-write-entry]')).toHaveCount(1);
    await next.locator('textarea').evaluate((el: HTMLTextAreaElement) => {
      el.readOnly = true;
    });
    await expect(next.locator('[data-sayvia-write-entry]')).toHaveCount(0);
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
