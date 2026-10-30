import { chromium, expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('built extension connects popup and options, and executes its bundled worker', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'sayvia-smoke-'));
  const extension = resolve('.output/chrome-mv3');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const background = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(background.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByRole('heading')).toHaveText('用自己的语言，参与世界的讨论。');
    await expect(popup.getByRole('status')).toHaveText('版本 0.1.0');
    const closedRoot = await popup.evaluate(() => {
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'closed' });
      const extensionDom = (
        globalThis as unknown as {
          chrome: { dom: { openOrClosedShadowRoot: (element: HTMLElement) => unknown } };
        }
      ).chrome.dom;
      return {
        hiddenFromPage: host.shadowRoot === null,
        visibleToExtension: extensionDom.openOrClosedShadowRoot(host) === root,
      };
    });
    expect(closedRoot).toEqual({ hiddenFromPage: true, visibleToExtension: true });
    const optionsPromise = context.waitForEvent('page');
    await popup.getByRole('button', { name: '打开设置' }).click();
    const options = await optionsPromise;
    await expect(options.getByRole('heading', { name: '模型设置' })).toBeVisible();
    const workerPage = await context.newPage();
    await workerPage.goto(`chrome-extension://${extensionId}/offscreen.html`);
    await expect(workerPage.locator('body')).toHaveAttribute('data-worker-ready', 'true');
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
