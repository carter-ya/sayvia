import { expect, test } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { workflowFixture } from '../fixtures/core-workflow-extension';

type ChromeGlobal = { chrome: typeof browser };

for (const [contentType, body] of [
  [
    'application/xml',
    '<Error><Code>AuthenticationFailed</Code><Message>Download expired.</Message></Error>',
  ],
  ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><text>Read first.</text></svg>'],
] as const) {
  test(`the production content script skips ${contentType} without initialization errors`, async () => {
    const f = await workflowFixture();
    try {
      const url = 'https://download.example.test/artifact';
      await f.context.route(url, (route) => route.fulfill({ contentType, body }));
      const page = await f.context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(url);
      expect(await page.evaluate(() => document.contentType)).toBe(contentType);
      // Exercise the exact shipped bundle in its real isolated extension world,
      // including reinjection after the automatic site registration has run.
      await f.settings.evaluate(async (url) => {
        const api = (globalThis as unknown as ChromeGlobal).chrome;
        const tab = (await api.tabs.query({})).find((tab) => tab.url === url)!;
        await api.scripting.executeScript({
          target: { tabId: tab.id!, frameIds: [0] },
          files: ['/content-scripts/translator.js'],
        });
      }, url);
      expect(errors).toEqual([]);
      await expect(page.locator('[data-sayvia-ui], [data-sayvia-entry]')).toHaveCount(0);
      const response = await f.popup.evaluate(async (url) => {
        const api = (globalThis as unknown as ChromeGlobal).chrome;
        const tab = (await api.tabs.query({})).find((tab) => tab.url === url)!;
        return api.runtime.sendMessage({
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          type: 'page.open',
          payload: { tabId: tab.id!, mode: 'read' },
        });
      }, url);
      expect(response).toEqual({ ok: false, error: 'UNSUPPORTED' });
      expect(errors).toEqual([]);
      expect(f.count()).toBe(0);
    } finally {
      await f.close();
    }
  });
}

for (const [contentType, body] of [
  ['text/html', '<!doctype html><p>Read first.</p>'],
  [
    'application/xhtml+xml',
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Read first.</p></body></html>',
  ],
  ['text/plain', 'Read first.'],
] as const) {
  test(`the production content script still mounts on ${contentType}`, async () => {
    const f = await workflowFixture();
    try {
      const url = 'https://download.example.test/readable';
      await f.context.route(url, (route) => route.fulfill({ contentType, body }));
      const page = await f.context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(url);
      await expect(page.locator('[data-sayvia-ui]')).toHaveCount(1);
      expect(errors).toEqual([]);
      expect(f.count()).toBe(0);
    } finally {
      await f.close();
    }
  });
}
