import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import type {} from '../fixtures/editor-harness';

let server: ViteDevServer;
let fixtureUrl: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve('.'),
    appType: 'mpa',
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server unavailable');
  fixtureUrl = `http://127.0.0.1:${address.port}/tests/fixtures/editor.html`;
});
test.afterAll(async () => {
  await server?.close();
});
test.beforeEach(async ({ page }) => {
  await page.goto(fixtureUrl);
  await expect(page.locator('#editor')).toBeVisible();
});

test('captured selection updates React submitted state and can restore without auto-submitting', async ({
  page,
}) => {
  await page
    .locator('#editor')
    .evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(3, 5));
  expect(await page.evaluate(() => window.editorHarness.capture())).toMatchObject({
    scope: 'selection',
  });
  await page.locator('#other').focus();
  expect(await page.evaluate(() => window.editorHarness.apply('English'))).toEqual({ ok: true });
  await expect(page.locator('#editor')).toHaveValue('前缀 English 后缀');
  await expect(page.locator('#other')).toHaveValue('另一份草稿');
  await expect(page.getByTestId('submitted')).toHaveText('');
  await page.getByRole('button', { name: '模拟用户提交' }).click();
  await expect(page.getByTestId('submitted')).toHaveText('前缀 English 后缀');
  expect(await page.evaluate(() => window.editorHarness.restore())).toEqual({ ok: true });
  await page.getByRole('button', { name: '模拟用户提交' }).click();
  await expect(page.getByTestId('submitted')).toHaveText('前缀 中文 后缀');
});

test('editing then undoing does not revive the old translation snapshot', async ({ page }) => {
  await page.evaluate(() => window.editorHarness.capture());
  await page.locator('#editor').fill('用户后续修改');
  await page.locator('#editor').fill('前缀 中文 后缀');
  expect(await page.evaluate(() => window.editorHarness.apply('English'))).toEqual({
    ok: false,
    reason: 'SOURCE_CHANGED',
  });
  await expect(page.locator('#editor')).toHaveValue('前缀 中文 后缀');
});

test('removed or hidden editors cannot receive a late replacement', async ({ page }) => {
  await page.evaluate(() => {
    window.editorHarness.capture();
    window.editorHarness.removeAndReinsert();
  });
  expect(await page.evaluate(() => window.editorHarness.apply('English'))).toEqual({
    ok: false,
    reason: 'CONTEXT_LOST',
  });
  await page.reload();
  await expect(page.locator('#editor')).toBeVisible();
  await page.evaluate(() => {
    window.editorHarness.capture();
    document.getElementById('editor')!.parentElement!.style.display = 'none';
  });
  expect(await page.evaluate(() => window.editorHarness.apply('English'))).toEqual({
    ok: false,
    reason: 'UNSUPPORTED',
  });
});

test('SPA navigation away and back does not revive a captured draft', async ({ page }) => {
  await page.evaluate(() => {
    window.editorHarness.capture();
    const previous = location.href;
    history.pushState({}, '', '/another-route');
    history.pushState({}, '', previous);
  });
  expect(await page.evaluate(() => window.editorHarness.apply('English'))).toEqual({
    ok: false,
    reason: 'CONTEXT_LOST',
  });
  await expect(page.locator('#editor')).toHaveValue('前缀 中文 后缀');
});

for (const id of ['single-line', 'search-line']) {
  test(`native line sanitization preserves the original ${id} draft`, async ({ page }) => {
    await page.evaluate((id) => window.editorHarness.capture(id), id);
    expect(await page.evaluate(() => window.editorHarness.apply('First\r\nSecond'))).toEqual({
      ok: false,
      reason: 'WRITE_REJECTED',
    });
    await expect(page.locator('#' + id)).toHaveValue('原始单行草稿');
    expect(await page.evaluate(() => window.editorHarness.apply('English'))).toEqual({ ok: true });
    expect(await page.evaluate(() => window.editorHarness.restore())).toEqual({ ok: true });
    await expect(page.locator('#' + id)).toHaveValue('原始单行草稿');
  });
}

test('a pending blur change does not invalidate the already captured user edits', async ({
  page,
}) => {
  await page.locator('#editor').fill('用户刚刚输入的草稿');
  await expect(page.locator('#editor')).toBeFocused();
  await page.locator('#editor').evaluate((element) => {
    element.addEventListener('change', () => {
      element.setAttribute('data-change-fired', 'true');
    });
  });
  await page.evaluate(() => window.editorHarness.capture());
  await page.locator('#other').focus();
  await expect(page.locator('#editor')).toHaveAttribute('data-change-fired', 'true');
  expect(await page.evaluate(() => window.editorHarness.apply('English'))).toEqual({ ok: true });
  expect(await page.evaluate(() => window.editorHarness.restore())).toEqual({ ok: true });
  await expect(page.locator('#editor')).toHaveValue('用户刚刚输入的草稿');
});
