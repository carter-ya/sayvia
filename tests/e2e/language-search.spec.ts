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
    await expect(target).toHaveValue('法语');
    await chooseLanguage(target, 'zh_Hant');
    await expect(target).toHaveValue('繁体中文');
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
    await expect(field).toHaveValue('日语');
    await field.fill('English');
    await field.press('Escape');
    await expect(field).toHaveValue('日语');
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
    await expect(field).toHaveValue('祖鲁语');
    await expect(list).toBeHidden();
  } finally {
    await f.close();
  }
});

test('Chinese family search is consistent and primary labels use the interface language', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    const panel = await f.open('write'),
      field = panel.getByRole('combobox', { name: '目标语言', exact: true });
    for (const query of ['中', '中文', 'Chinese', 'zh']) {
      await field.fill(query);
      await expect(f.page.getByRole('option')).toHaveCount(2);
      expect(
        await f.page
          .getByRole('option')
          .evaluateAll((els) => els.map((el) => el.getAttribute('data-language-code'))),
      ).toEqual(['zh-Hans', 'zh-Hant']);
    }
    await field.fill('bo');
    await expect(f.page.getByRole('option')).toContainText('藏语');
    await expect(f.page.getByRole('option')).toContainText('Tibetan');
    await field.press('Enter');
    await expect(field).toHaveValue('藏语');
    await field.fill('日本語');
    await field.press('Enter');
    await expect(field).toHaveValue('日语');
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});

test('language chevrons are centered and busy controls show a disabled cursor while loading becomes streamed text', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    for (const field of await panel.locator('.language-field').all()) {
      const input = (await field.locator('input').boundingBox())!,
        icon = (await field.locator('.language-chevron').boundingBox())!;
      expect(Math.abs(input.y + input.height / 2 - icon.y - icon.height / 2)).toBeLessThan(1);
    }
    const between = (await panel.locator('.language-arrow').boundingBox())!,
      target = (await panel
        .getByRole('combobox', { name: '目标语言', exact: true })
        .boundingBox())!;
    expect(Math.abs(between.y + between.height / 2 - target.y - target.height / 2)).toBeLessThan(1);
    f.stream(600);
    const release = f.hold();
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByRole('progressbar', { name: '正在翻译', exact: true })).toBeVisible();
    await expect(panel).not.toContainText('等待首字');
    const field = panel.getByRole('combobox', { name: '目标语言', exact: true });
    await expect(field).toBeDisabled();
    await field.hover();
    expect(await field.evaluate((el) => getComputedStyle(el).cursor)).toBe('not-allowed');
    await expect(field.locator('..')).toHaveAttribute('title', '暂不可切换语言');
    await f.page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      await panel.locator('.loading-spinner').evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('none');
    release();
    await expect(panel.getByRole('region', { name: '流式译文' })).toContainText('Eng');
    await expect(panel.getByRole('progressbar', { name: '正在翻译', exact: true })).toHaveCount(0);
    await expect(panel).toHaveAttribute('aria-busy', 'true');
    await expect(panel.getByRole('button', { name: '复制译文', exact: true })).toBeDisabled();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    await expect(field).toBeEnabled();
  } finally {
    await f.close();
  }
});

test('manual translation uses the same loading state until content arrives', async () => {
  const f = await workflowFixture();
  try {
    const popup = await f.context.newPage();
    await f.page.bringToFront();
    await popup.goto(f.popup.url());
    await popup.getByRole('tab', { name: '手动翻译', exact: true }).click();
    await popup.getByLabel('待翻译文本', { exact: true }).fill('中文');
    const release = f.hold();
    await popup.getByRole('button', { name: '翻译文本', exact: true }).click();
    await expect(popup.getByRole('progressbar', { name: '正在翻译', exact: true })).toBeVisible();
    await expect(popup.getByLabel('手动译文', { exact: true })).toBeDisabled();
    release();
    await expect(popup.getByLabel('手动译文', { exact: true })).toHaveValue('English');
    await expect(popup.getByRole('progressbar', { name: '正在翻译', exact: true })).toHaveCount(0);
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
