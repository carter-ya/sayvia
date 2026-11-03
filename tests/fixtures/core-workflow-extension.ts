import { browserLaunchOptions } from './browser-options';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'vite';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { browser } from 'wxt/browser';

type ChromeGlobal = { chrome: typeof browser };
export async function workflowFixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'sayvia-workflow-'));
  let count = 0;
  let delay = 0;
  let responseMode: 'normal' | 'invalid' | 'rate-limited' = 'normal';
  let held = false;
  let streaming: { gap: number; end: 'normal' | 'truncated' | 'invalid' } | undefined;
  const heldResponses = new Set<() => void>();
  const pending = new Set<object>();
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
              pending.add(response);
              response.on('close', () => pending.delete(response));
              requestBodies.push(raw);
              const finish = () => {
                if (response.destroyed) return;
                if (responseMode === 'rate-limited') {
                  response.writeHead(429, { 'Content-Type': 'application/json' });
                  response.end(
                    JSON.stringify({
                      error: {
                        code: 'rate_limit_exceeded',
                        message: 'FIXTURE_PRIVATE_SERVER_DETAIL',
                      },
                    }),
                  );
                  return;
                }
                if (responseMode === 'invalid') {
                  response.writeHead(200, { 'Content-Type': 'application/json' });
                  response.end(
                    JSON.stringify({
                      choices: [
                        {
                          index: 0,
                          finish_reason: 'stop',
                          message: { role: 'assistant', content: JSON.stringify({ segments: [] }) },
                        },
                      ],
                    }),
                  );
                  return;
                }
                const payload = JSON.parse(JSON.parse(raw).messages[1].content);
                const content = JSON.stringify({
                  segments: payload.segments.map((segment: { id: string; text: string }) => ({
                    id: segment.id,
                    text: segment.text
                      .replace(/中文|你好/g, 'English')
                      .replace('Accept ', '接受 ')
                      .replace(
                        'locates an entry and the files available to its compiler.',
                        '定位入口及其编译器可用的文件。',
                      )
                      .replace(
                        'DriverDSN keeps Oracle reconnections on the full authentication path. go-ora',
                        'DriverDSN 让 Oracle 重连始终走完整认证流程。go-ora',
                      )
                      .replace(
                        "v3.0.1's default fast-login cookie path fails on subsequent Oracle Free logins.",
                        'v3.0.1 默认的快速登录 cookie 流程会在后续 Oracle Free 登录时失败。',
                      )
                      .replace(
                        "An explicit driver option remains the operator's choice.",
                        '显式指定驱动选项仍由操作者决定。',
                      )
                      .replace('Read ', '阅读 ')
                      .replace(' first.', ' 优先。')
                      .replace(
                        'Probably I can use information_schema to find all columns than concat everything to single string for',
                        '也许我可以使用 information_schema 查找所有列，然后把所有内容拼接成一个字符串，传给',
                      )
                      .replace(
                        'JSON_OBJECT, and use prepare/execute inside trigger to get compiled result...',
                        'JSON_OBJECT，再在触发器内使用 prepare/execute 来获得编译后的结果……',
                      ),
                  })),
                });
                if (streaming) {
                  const { gap, end } = streaming;
                  response.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                  });
                  response.flushHeaders();
                  const chunk = (delta: unknown, finish_reason: string | null = null) => ({
                    choices: [{ index: 0, delta, finish_reason }],
                  });
                  const split = Math.max(
                    content.indexOf('"text":"') + 11,
                    Math.floor(content.length * 0.65),
                  );
                  const finishContent =
                    end === 'invalid'
                      ? content.slice(split, -2) + ',{"id":"invalid","text":"x"}]}'
                      : content.slice(split);
                  const parts = [
                    chunk({ reasoning_content: 'FIXTURE_PRIVATE_REASONING' }),
                    chunk({ content: content.slice(0, split) }),
                    chunk({ content: finishContent }),
                    chunk({}, 'stop'),
                    {
                      choices: [],
                      usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
                    },
                  ];
                  const timers = parts.map((part, index) =>
                    setTimeout(() => {
                      if (!response.destroyed)
                        response.write('data: ' + JSON.stringify(part) + '\n\n');
                    }, index * gap),
                  );
                  timers.push(
                    setTimeout(() => {
                      if (!response.destroyed)
                        response.end(end === 'truncated' ? '' : 'data: [DONE]\n\n');
                    }, parts.length * gap),
                  );
                  response.on('close', () => timers.forEach(clearTimeout));
                  return;
                }
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(
                  JSON.stringify({
                    choices: [
                      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content } },
                    ],
                  }),
                );
              };
              if (held) {
                heldResponses.add(finish);
                response.on('close', () => heldResponses.delete(finish));
              } else if (delay) {
                const timer = setTimeout(finish, delay);
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
    async blockSite(origin: string) {
      // Simulate Chrome's site-access decision and its background notification,
      // without pretending required manifest permissions can be removed by the extension.
      await worker.evaluate(async (origin) => {
        const api = (globalThis as unknown as ChromeGlobal).chrome;
        const contains = api.permissions.contains.bind(api.permissions);
        api.permissions.contains = async (request) =>
          request.origins?.includes(`${origin}/*`) ? false : contains(request);
        for (const tab of await api.tabs.query({})) {
          if (tab.id !== undefined && tab.url?.startsWith(origin)) {
            await api.tabs.sendMessage(
              tab.id,
              { protocolVersion: 1, type: 'page.automatic', enabled: false },
              { frameId: 0 },
            );
          }
        }
      }, origin);
    },
    page,
    worker,
    popup,
    settings,
    context,
    open,
    count: () => count,
    requestBodies,
    stream: (gap = 250, end: 'normal' | 'truncated' | 'invalid' = 'normal') => {
      streaming = { gap, end };
    },
    pending: () => pending.size,
    response: (mode: typeof responseMode) => {
      responseMode = mode;
    },
    hold: () => {
      held = true;
      return () => {
        held = false;
        for (const finish of heldResponses) finish();
        heldResponses.clear();
      };
    },
    delay: (milliseconds = 500) => {
      delay = milliseconds;
    },
    async close() {
      await context.close();
      await server.close();
      await rm(temporary, { recursive: true, force: true });
    },
  };
}
