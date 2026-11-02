import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';
import { chooseLanguage } from '../fixtures/choose-language';

test('language search accepts native names, English names and BCP-47 tags without changing value until committed', async () => {
  const f = await workflowFixture();
  await f.page.locator('#editor').focus();
  try {
    const panel = await f.open('write');
    const source = panel.getByRole('combobox', { name: '源语言', exact: true });
    const target = panel.getByRole('combobox', { name: '目标语言', exact: true });
    await target.fill('francais');
    await expect(f.page.getByRole('option')).toHaveCount(2);
    await target.press('Enter');
    await expect(target).toHaveValue('français');
    await chooseLanguage(target, 'zh_Hant');
    await expect(target).toHaveValue('繁體中文');
    await source.fill('no such language?');
    await expect(f.page.getByText('未找到语言，可输入 BCP-47 标签')).toBeVisible();
    await source.press('Escape');
    await expect(source).toHaveValue('自动识别');
    await expect(panel).toBeVisible();
    await chooseLanguage(source, 'de-CH-1996');
    await expect(source).toHaveValue('de-CH-1996');
    expect(f.count()).toBe(0);
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    expect(JSON.parse(JSON.parse(f.requestBodies[0]!).messages[1].content).sourceLanguage).toBe(
      'de-CH-1996',
    );
  } finally {
    await f.close();
  }
});
test('keyboard selection and cancelling a query preserve the selected language', async () => {
  const f = await workflowFixture();
  await f.page.locator('#editor').focus();
  try {
    const panel = await f.open('write'),
      field = panel.getByRole('combobox', { name: '目标语言', exact: true });
    await field.fill('ja');
    await field.press('ArrowDown');
    await field.press('Enter');
    await expect(field).toHaveValue('日本語');
    await field.fill('English');
    await field.press('Escape');
    await expect(field).toHaveValue('日本語');
    await expect(panel).toBeVisible();
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
test('language menu escapes the panel scroll container and fits a narrow viewport', async () => {
  const f = await workflowFixture();
  await f.page.locator('#editor').focus();
  try {
    await f.page.setViewportSize({ width: 375, height: 620 });
    const panel = await f.open('write');
    const field = panel.getByRole('combobox', { name: '目标语言', exact: true });
    await field.click();
    const list = f.page.getByRole('listbox', { name: '目标语言选项' });
    await expect(list).toBeVisible();
    const box = (await list.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.y + box.height).toBeLessThanOrEqual(620);
    await field.fill('zu');
    await field.press('Enter');
    await expect(field).toHaveValue('isiZulu');
    await expect(list).toBeHidden();
  } finally {
    await f.close();
  }
});
