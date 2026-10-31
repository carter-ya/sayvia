import { browserLaunchOptions } from './browser-options';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'vite';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { browser } from 'wxt/browser';

type ChromeGlobal = { chrome: typeof browser };
export async function workflowFixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'sayvia-workflow-'));
  let count = 0;
  let delay = false;
  const requestBodies: string[] = [];
  const server = await createServer({
    configFile: false,
    cacheDir: join(temporary, 'vite-cache'),
    root: resolve('.'),
    appType: 'mpa',
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client'] },
    server: { host: '127.0.0.1', port: 0 },
    plugins: [
      {
        name: 'sayvia-model-fixture',
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.method !== 'POST' || !request.url?.startsWith('/model/')) {
              next();
              return;
            }
            let raw = '';
            request.setEncoding('utf8');
            request.on('data', (chunk) => {
              raw += chunk;
            });
            request.on('end', () => {
              count++;
              requestBodies.push(raw);
              const finish = () => {
                if (response.destroyed) return;
                const payload = JSON.parse(JSON.parse(raw).messages[1].content);
                const content = JSON.stringify({
                  segments: payload.segments.map((segment: { id: string; text: string }) => ({
                    id: segment.id,
                    text: segment.text
                      .replace(/中文|你好/g, 'English')
                      .replace('Read ', '阅读 ')
                      .replace(' first.', ' 优先。'),
                  })),
                });
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(
                  JSON.stringify({
                    choices: [
                      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content } },
                    ],
                  }),
                );
              };
              if (delay) {
                const timer = setTimeout(finish, 500);
                response.on('close', () => clearTimeout(timer));
              } else finish();
            });
          });
        },
      },
    ],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const extension = join(temporary, 'extension');
  await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
  const manifestFile = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.host_permissions = [
    'http://127.0.0.1/*',
    'https://github.com/*',
    'https://api.openai.com/*',
    'https://api.deepseek.com/*',
  ];
  await writeFile(manifestFile, JSON.stringify(manifest));
  const context: BrowserContext = await chromium.launchPersistentContext(
    join(temporary, 'profile'),
    {
      ...browserLaunchOptions(),
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    },
  );
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${id}/options.html`);
  await expect(settings.getByLabel('配置名称')).toBeVisible();
  await settings.getByLabel('配置名称').fill('Workflow fixture');
  await settings.getByLabel('模型名称').fill('fixture-model');
  await settings.getByLabel('API Base URL').fill(`${baseUrl}/model`);
  await settings.getByLabel('API Key', { exact: true }).fill('WORKFLOW_FIXTURE_KEY');
  await settings.getByRole('button', { name: '保存配置' }).click();
  await expect(settings.getByRole('status')).toHaveText('已保存配置。');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const page = await context.newPage();
  await page.goto(`${baseUrl}/tests/fixtures/editor.html`);
  await expect(page.locator('#editor')).toBeVisible();
  const open = async (mode: 'read' | 'write', target: Page = page) => {
    const tabId = await popup.evaluate(
      async (url) =>
        (await (globalThis as unknown as ChromeGlobal).chrome.tabs.query({})).find(
          (tab) => tab.url === url,
        )!.id!,
      target.url(),
    );
    const response = await popup.evaluate(
      (payload) =>
        (globalThis as unknown as ChromeGlobal).chrome.runtime.sendMessage({
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          type: 'page.open',
          payload,
        }),
      { mode, tabId },
    );
    expect(response).toMatchObject({ ok: true });
    return target.getByRole('dialog', { name: 'Sayvia 翻译' });
  };
  return {
    page,
    popup,
    settings,
    context,
    open,
    count: () => count,
    requestBodies,
    delay: () => {
      delay = true;
    },
    async close() {
      await context.close();
      await server.close();
      await rm(temporary, { recursive: true, force: true });
    },
  };
}
