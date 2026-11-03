import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';
import type { browser } from 'wxt/browser';

test('both palettes and every theme persist and update an open draft without retranslating', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      document.documentElement.style.background = '#fff';
      document.body.style.background = '#fff';
    });
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await expect(panel.getByLabel('译文', { exact: true })).toBeEnabled();
    await panel.getByLabel('译文', { exact: true }).fill('Keep this unsaved translation');
    await f.settings.getByRole('button', { name: '更多设置', exact: true }).click();
    const host = f.page.locator('[data-sayvia-ui]');
    for (const palette of ['crystal', 'pearl']) {
      for (const theme of ['light', 'dark', 'system']) {
        await f.settings.getByLabel('界面配色').selectOption(palette);
        await f.settings.getByLabel('界面主题').selectOption(theme);
        await f.settings.getByRole('button', { name: '保存偏好', exact: true }).click();
        await expect(f.settings.getByRole('status')).toHaveText('已保存偏好。');
        await expect(host).toHaveAttribute('data-palette', palette);
        await expect(f.popup.locator('html')).toHaveAttribute('data-palette', palette);
        await expect
          .poll(() => host.evaluate((el) => el.style.colorScheme))
          .toBe(theme === 'system' ? 'light dark' : theme);
        await expect(panel.getByLabel('译文', { exact: true })).toHaveValue(
          'Keep this unsaved translation',
        );
        if (theme === 'dark') {
          // The dark material must stay legible even over a fully white website.
          const contrast = await panel.evaluate((element) => {
            const css = getComputedStyle(element);
            const context = document.createElement('canvas').getContext('2d')!;
            const pixel = (color: string) => {
              context.clearRect(0, 0, 1, 1);
              context.fillStyle = color;
              context.fillRect(0, 0, 1, 1);
              return [...context.getImageData(0, 0, 1, 1).data];
            };
            const overlay = pixel(
              css.backgroundImage.match(/color\(srgb [^)]+\)|rgba?\([^)]+\)/)![0],
            );
            const alpha = overlay[3]! / 255;
            const background = overlay
              .slice(0, 3)
              .map((value) => (value * alpha + 255 * (1 - alpha)) * 0.93 + 255 * 0.07);
            const luminance = (rgb: number[]) => {
              const c = rgb
                .slice(0, 3)
                .map((v) => v / 255)
                .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
              return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
            };
            const back = luminance(background);
            return Math.min(
              ...[css.color, getComputedStyle(element.querySelector('.mode-badge')!).color].map(
                (color) => {
                  const foreground = luminance(pixel(color));
                  return (Math.max(foreground, back) + 0.05) / (Math.min(foreground, back) + 0.05);
                },
              ),
            );
          });
          expect(contrast).toBeGreaterThanOrEqual(4.5);
          await panel.screenshot({
            path: test.info().outputPath(`dark-over-white-${palette}.png`),
          });
        }
        if (theme === 'system') {
          await f.page.emulateMedia({ colorScheme: 'light' });
          const light = await panel.evaluate((el) => getComputedStyle(el).color);
          await f.page.emulateMedia({ colorScheme: 'dark' });
          await expect
            .poll(() => panel.evaluate((el) => getComputedStyle(el).color))
            .not.toBe(light);
        }
      }
    }
    await f.settings.reload();
    await f.settings.getByRole('button', { name: '更多设置', exact: true }).click();
    await expect(f.settings.getByLabel('界面配色')).toHaveValue('pearl');
    await expect(f.settings.getByLabel('界面主题')).toHaveValue('system');
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});

test('panel appearance saves across reopening and original text stays opaque and readable', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await expect(panel.getByLabel('译文', { exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: '浮窗外观', exact: true }).click();
    await panel.getByRole('button', { name: '实色', exact: true }).click();
    await expect(panel.getByLabel('浮窗背景浓度')).toBeDisabled();
    await panel.getByRole('button', { name: '磨砂', exact: true }).click();
    const slider = panel.getByLabel('浮窗背景浓度');
    await slider.focus();
    await slider.press('Home');
    await slider.press('ArrowRight');
    await panel.getByLabel('阅读保护', { exact: true }).uncheck();
    await panel.getByRole('button', { name: '浮窗外观', exact: true }).click();
    await expect
      .poll(() => f.page.locator('[data-sayvia-ui]').getAttribute('data-reading-protection'))
      .toBe('false');
    await panel.locator('.source-details > summary').click();
    const original = panel.getByLabel('原文', { exact: true });
    const sourceStyle = await original.evaluate((el) => {
      const s = getComputedStyle(el);
      return { opacity: s.opacity, font: s.fontSize, bg: s.backgroundColor, color: s.color };
    });
    expect(sourceStyle.opacity).toBe('1');
    expect(sourceStyle.font).toBe('14px');
    expect(sourceStyle.bg).not.toContain('rgba');
    await panel.screenshot({ path: test.info().outputPath('glass-original-readable.png') });
    await panel.getByRole('button', { name: '关闭翻译面板' }).click();
    await f.page.locator('#editor').focus();
    const reopened = await f.open('write');
    await expect(reopened.getByLabel('译文', { exact: true })).toBeEnabled();
    await reopened.getByRole('button', { name: '浮窗外观', exact: true }).click();
    await expect(reopened.getByRole('button', { name: '磨砂', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(reopened.getByLabel('浮窗背景浓度')).toHaveValue('9');
    await expect(reopened.getByLabel('阅读保护', { exact: true })).not.toBeChecked();
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});

test('dragging, keyboard movement, collapsing and resizing preserve a translated draft', async () => {
  const f = await workflowFixture();
  try {
    await f.page.setViewportSize({ width: 1000, height: 800 });
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    await panel.getByLabel('译文', { exact: true }).fill('Reviewed translation');
    const start = (await panel.boundingBox())!;
    const handle = panel.getByRole('button', { name: '移动翻译面板，方向键微调' });
    const grip = (await handle.boundingBox())!;
    await f.page.mouse.move(grip.x + 8, grip.y + 8);
    await f.page.mouse.down();
    await f.page.mouse.move(grip.x - 92, grip.y + 88, { steps: 8 });
    await f.page.mouse.up();
    await expect.poll(async () => Math.round((await panel.boundingBox())!.x - start.x)).toBe(-100);
    await expect.poll(async () => Math.round((await panel.boundingBox())!.y - start.y)).toBe(80);
    await handle.focus();
    await handle.press('ArrowDown');
    await expect.poll(async () => Math.round((await panel.boundingBox())!.y - start.y)).toBe(96);
    await f.page.evaluate(() => {
      document.body.style.minHeight = '2400px';
      window.scrollTo(0, 300);
    });
    await expect.poll(async () => Math.round((await panel.boundingBox())!.y - start.y)).toBe(96);
    await panel.getByRole('button', { name: '收起翻译面板' }).click();
    expect((await panel.boundingBox())!.height).toBeLessThan(90);
    await panel.getByRole('button', { name: '展开翻译面板' }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('Reviewed translation');
    await panel.getByRole('button', { name: '浮窗外观', exact: true }).click();
    await panel.getByRole('button', { name: '恢复浮窗位置' }).click();
    await expect.poll(async () => Math.round((await panel.boundingBox())!.y)).toBe(12);
    await panel.getByRole('button', { name: '浮窗外观', exact: true }).click();
    await f.page.setViewportSize({ width: 375, height: 280 });
    await expect
      .poll(async () => {
        const r = (await panel.boundingBox())!;
        return r.x >= 0 && r.y >= 0 && r.x + r.width <= 375 && r.y + r.height <= 280;
      })
      .toBe(true);
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('Reviewed translation');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

test('a failed appearance save restores the persisted choice and allows retry without losing a draft', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await expect(panel.getByLabel('译文', { exact: true })).toBeEnabled();
    await panel.getByLabel('译文', { exact: true }).fill('Keep this local draft');
    await panel.getByRole('button', { name: '浮窗外观', exact: true }).click();
    await f.worker.evaluate(() => {
      const api = (globalThis as unknown as { chrome: typeof browser }).chrome;
      const original = api.storage.local.set.bind(api.storage.local);
      api.storage.local.set = async () => {
        api.storage.local.set = original;
        throw new Error('FIXTURE_STORAGE_WRITE_FAILURE');
      };
    });
    await panel.getByRole('button', { name: '实色', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('外观尚未保存，请稍后重试。');
    await expect(panel.getByRole('button', { name: '液态', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await panel.getByRole('button', { name: '实色', exact: true }).click();
    await expect(panel.getByRole('button', { name: '实色', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(panel.getByRole('status')).toHaveCount(0);
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('Keep this local draft');
    await f.settings.reload();
    await f.settings.getByRole('button', { name: '更多设置', exact: true }).click();
    await expect(f.settings.getByLabel('浮窗材质')).toHaveValue('solid');
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
