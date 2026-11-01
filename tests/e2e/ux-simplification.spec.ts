import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';

test('setup needs only a model connection and ordinary pages work immediately', async () => {
  const f = await workflowFixture();
  try {
    await expect(f.settings.getByRole('button', { name: '授权此 API 主机' })).toHaveCount(0);
    await expect(f.settings.getByRole('button', { name: '权限与数据', exact: true })).toHaveCount(
      0,
    );
    await expect(f.settings.getByLabel('网站地址')).toHaveCount(0);
    await expect(f.page.locator('[data-sayvia-entry]')).toHaveCount(1);
    await f.page.reload();
    await expect(f.page.locator('[data-sayvia-entry]')).toHaveCount(1);
    await f.settings.getByLabel('配置名称').fill('');
    await f.settings.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(f.settings.getByLabel('配置名称')).toHaveValue('fixture-model');
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});

test('multiline selection follows the mouse release and opens a compact translation', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'multiline';
      p.style.cssText =
        'position:absolute;left:40px;top:100px;width:650px;font:18px/28px system-ui';
      p.innerHTML =
        '<span>Read this long first line before continuing to the next line.</span><br><span id="last-line">Read first.</span>';
      document.body.append(p);
    });
    const end = await f.page.locator('#last-line').boundingBox();
    const point = { x: end!.x + end!.width - 2, y: end!.y + end!.height / 2 };
    await f.page.mouse.move(point.x, point.y);
    await f.page.mouse.down();
    await f.page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#multiline')!);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await f.page.mouse.up();
    const icon = f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' });
    await expect(icon).toBeVisible();
    const rect = (await icon.boundingBox())!;
    expect(Math.abs(rect.x - point.x)).toBeLessThanOrEqual(18);
    expect(Math.abs(rect.y - point.y)).toBeLessThanOrEqual(18);
    expect(rect.width).toBeLessThanOrEqual(28);
    expect(f.count()).toBe(0);
    await f.page.screenshot({
      path: test.info().outputPath('selection-near-pointer.png'),
      clip: { x: 20, y: 80, width: 720, height: 200 },
    });
    await icon.click();
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await expect(panel.getByLabel('译文', { exact: true })).not.toHaveValue('');
    await expect(panel.getByText('跨过语言，读懂原意')).toHaveCount(0);
    expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(350);
    await panel
      .getByLabel('译文', { exact: true })
      .fill('开始前请先阅读项目文档，并保留原始草稿。');
    await panel.screenshot({ path: test.info().outputPath('reading-compact-light.png') });
    await f.page.emulateMedia({ colorScheme: 'dark' });
    await panel.screenshot({ path: test.info().outputPath('reading-compact-dark.png') });
    await f.settings.screenshot({
      path: test.info().outputPath('settings-simple.png'),
      fullPage: true,
    });
  } finally {
    await f.close();
  }
});

test('selection icon stays inside the viewport and keyboard selection uses its own final line', async () => {
  const f = await workflowFixture();
  try {
    await f.page.setViewportSize({ width: 375, height: 600 });
    await f.page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'keyboard-source';
      p.textContent = 'Read first.';
      p.style.cssText = 'position:absolute;left:20px;top:100px;font:16px/24px system-ui';
      document.body.append(p);
    });
    await expect(f.page.locator('[data-sayvia-entry]')).toHaveCount(1);
    await f.page.mouse.move(373, 598);
    await f.page.mouse.down();
    await f.page.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.querySelector('#keyboard-source')!);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(r);
    });
    await f.page.mouse.up();
    const icon = f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' });
    await expect(icon).toBeVisible();
    let box = (await icon.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(box.y + box.height).toBeLessThanOrEqual(600);
    await f.page.keyboard.press('Shift');
    box = (await icon.boundingBox())!;
    expect(box.y).toBeLessThan(180);
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
