import { browserLaunchOptions } from '../fixtures/browser-options';
import { chromium, expect, test, type Page } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { browser } from 'wxt/browser';

type ChromeGlobal = { chrome: typeof browser };
const KEY = 'TASK_RUNTIME_FIXTURE_KEY';
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), 'sayvia-tasks-'));
  const extension = join(temporary, 'extension');
  await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
  const manifestFile = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  manifest.content_scripts = [{ matches: ['http://127.0.0.1/*'], js: ['runtime-probe.js'] }];
  await writeFile(manifestFile, JSON.stringify(manifest));
  await cp(resolve('tests/fixtures/runtime-probe.js'), join(extension, 'runtime-probe.js'));
  let count = 0;
  const held = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html><body><textarea>你好</textarea><button id="start">Start</button><button id="retry">Retry</button><button id="cancel">Cancel</button></body></html>',
      );
      return;
    }
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      count++;
      expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
      held.add(response);
      response.on('close', () => held.delete(response));
      const finish = () => {
        if (response.destroyed) return;
        const payload = JSON.parse(JSON.parse(raw).messages[1].content);
        const content = JSON.stringify({
          segments: payload.segments.map((segment: { id: string; text: string }) => ({
            id: segment.id,
            text: segment.text.replace('你好', 'Hello'),
          })),
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
          }),
        );
      };
      if (request.url?.startsWith('/wait/')) return;
      if (request.url?.startsWith('/slow/')) {
        const timer = setTimeout(finish, 35_000);
        response.on('close', () => clearTimeout(timer));
      } else finish();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    ...browserLaunchOptions(),
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${id}/options.html`);
  await expect(settings.getByLabel('选择配置')).toBeVisible();
  await settings.getByLabel('配置名称').fill('Runtime fixture');
  await settings.getByLabel('模型名称').fill('fixture-model');
  await settings.getByLabel('API Key', { exact: true }).fill(KEY);
  const configure = async (path = '') => {
    await settings.getByLabel('API Base URL').fill(baseUrl + path);
    await settings.getByRole('button', { name: '保存配置' }).click();
    await expect(settings.getByRole('status')).toHaveText('已保存配置。');
  };
  await configure();
  const page = await context.newPage();
  await page.goto(`${baseUrl}/page`);
  await expect(page.locator('body')).toHaveAttribute('data-session-access', 'blocked');
  return {
    context,
    page,
    settings,
    worker,
    id,
    configure,
    count: () => count,
    held,
    async close() {
      held.forEach((response) => response.destroy());
      await context.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(temporary, { recursive: true, force: true });
    },
  };
}
async function idle(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (
            await (globalThis as unknown as ChromeGlobal).chrome.runtime.getContexts({
              contextTypes: ['OFFSCREEN_DOCUMENT'],
            })
          ).length,
      ),
    )
    .toBe(0);
}

test('production broker isolates page tasks, deduplicates retries, cancels fetches and closes idle offscreen', async () => {
  const f = await fixture();
  try {
    await f.page.locator('#start').click();
    await expect(f.page.locator('body')).toHaveAttribute('data-result', 'Hello');
    expect(f.count()).toBe(1);
    await f.page.locator('#retry').click();
    await expect(f.page.locator('body')).toHaveAttribute('data-reply', /delivered/);
    expect(f.count()).toBe(1);
    await idle(f.settings);
    const stored = await f.settings.evaluate(async () =>
      (globalThis as unknown as ChromeGlobal).chrome.storage.session.get('sayvia.tasks'),
    );
    expect(JSON.stringify(stored)).not.toMatch(/你好|Hello|TASK_RUNTIME_FIXTURE_KEY/);
    await f.configure('/wait');
    await f.page.locator('#start').click();
    await expect.poll(() => f.held.size).toBe(1);
    await f.page.locator('#retry').click();
    await expect(f.page.locator('body')).toHaveAttribute('data-reply', /running/);
    expect(f.count()).toBe(2);
    await f.page.locator('#cancel').click();
    await expect(f.page.locator('body')).toHaveAttribute('data-reply', /canceled/);
    await expect.poll(() => f.held.size).toBe(0);
    await idle(f.settings);
    expect(f.count()).toBe(2);
  } finally {
    await f.close();
  }
});

test('a 35 second response survives background termination and returns preview-only without replay', async () => {
  test.setTimeout(55_000);
  const f = await fixture();
  try {
    await f.configure('/slow');
    const cdp = await f.context.newCDPSession(f.page);
    let versionId: string | undefined;
    cdp.on(
      'ServiceWorker.workerVersionUpdated',
      (event: { versions: Array<{ scriptURL: string; versionId: string; status: string }> }) => {
        for (const version of event.versions)
          if (version.scriptURL === f.worker.url() && version.status === 'activated')
            versionId = version.versionId;
      },
    );
    await cdp.send('ServiceWorker.enable');
    await expect.poll(() => versionId).toBeDefined();
    await f.page.locator('#start').click();
    await expect.poll(() => f.held.size).toBe(1);
    await cdp.send('ServiceWorker.stopWorker', { versionId: versionId! });
    await cdp.detach();
    await expect(f.page.locator('body')).toHaveAttribute('data-result', 'Hello', {
      timeout: 45_000,
    });
    await expect(f.page.locator('body')).toHaveAttribute('data-can-apply', 'false');
    expect(f.count()).toBe(1);
    await idle(f.settings);
  } finally {
    await f.close();
  }
});

test('an unresponsive API is aborted at the real 60 second deadline with no retry', async () => {
  test.setTimeout(75_000);
  const f = await fixture();
  try {
    await f.configure('/wait');
    const started = Date.now();
    await f.page.locator('#start').click();
    await expect.poll(() => f.held.size).toBe(1);
    await expect(f.page.locator('body')).toHaveAttribute('data-state', 'timedOut', {
      timeout: 67_000,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(59_000);
    expect(Date.now() - started).toBeLessThan(67_000);
    await expect(f.page.locator('body')).toHaveAttribute('data-error', 'TIMEOUT');
    await expect.poll(() => f.held.size).toBe(0);
    expect(f.count()).toBe(1);
    await idle(f.settings);
  } finally {
    await f.close();
  }
});

test('popup drafts and results survive popup closure and share the target tab mutex', async () => {
  const f = await fixture();
  try {
    const popup = await f.context.newPage();
    await popup.goto(`chrome-extension://${f.id}/popup.html`);
    const tabId = await popup.evaluate(
      async (target) =>
        (await (globalThis as unknown as ChromeGlobal).chrome.tabs.query({})).find(
          (tab) => tab.url === target,
        )!.id!,
      f.page.url(),
    );
    const message = {
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      type: 'translation.start',
      payload: {
        clientTaskId: crypto.randomUUID(),
        documentNonce: crypto.randomUUID(),
        tabId,
        mode: 'manual',
        scope: 'full',
        source: { kind: 'plain-text', text: '你好' },
        sourceLanguage: 'auto',
        targetLanguage: 'en',
      },
    };
    await f.configure('/wait');
    await f.page.locator('#start').click();
    await expect.poll(() => f.held.size).toBe(1);
    const busy = await popup.evaluate(
      (message) => (globalThis as unknown as ChromeGlobal).chrome.runtime.sendMessage(message),
      message,
    );
    expect(busy).toEqual({ ok: false, error: 'TASK_BUSY' });
    await f.page.locator('#cancel').click();
    await expect.poll(() => f.held.size).toBe(0);
    await f.configure();
    expect(
      await popup.evaluate(
        (message) => (globalThis as unknown as ChromeGlobal).chrome.runtime.sendMessage(message),
        message,
      ),
    ).toMatchObject({ ok: true });
    await popup.close();
    const reopened = await f.context.newPage();
    await reopened.goto(`chrome-extension://${f.id}/popup.html`);
    await expect
      .poll(() =>
        reopened.evaluate(async (tabId) => {
          const reply = (await (globalThis as unknown as ChromeGlobal).chrome.runtime.sendMessage({
            protocolVersion: 1,
            requestId: crypto.randomUUID(),
            type: 'translation.manual.read',
            payload: { tabId },
          })) as { data?: { result?: string } };
          return reply.data?.result;
        }, tabId),
      )
      .toBe('Hello');
    expect(f.count()).toBe(2);
    await idle(f.settings);
  } finally {
    await f.close();
  }
});

test('missing API host permission rejects before executor creation or network', async () => {
  const f = await fixture();
  try {
    const base = await f.settings.getByLabel('API Base URL').inputValue();
    await f.settings.getByLabel('API Base URL').fill(base.replace('127.0.0.1', 'localhost'));
    await f.settings.getByRole('button', { name: '保存配置' }).click();
    await expect(f.settings.getByRole('status')).toHaveText('已保存配置。');
    await f.page.locator('#start').click();
    await expect(f.page.locator('body')).toHaveAttribute('data-reply', /PERMISSION_DENIED/);
    expect(f.count()).toBe(0);
    await idle(f.settings);
  } finally {
    await f.close();
  }
});

test('deleting a configuration aborts its in-flight request and removes the credential', async () => {
  const f = await fixture();
  try {
    await f.configure('/wait');
    await f.page.locator('#start').click();
    await expect.poll(() => f.held.size).toBe(1);
    f.settings.on('dialog', (dialog) => void dialog.accept());
    await f.settings.getByRole('button', { name: '删除配置' }).click();
    await expect(f.settings.getByRole('status')).toHaveText('已删除配置及其 Key。');
    await expect.poll(() => f.held.size).toBe(0);
    await idle(f.settings);
    await f.page.locator('#start').click();
    await expect(f.page.locator('body')).toHaveAttribute('data-reply', /CONFIG_REQUIRED/);
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

test('closing the owning tab cancels its request and releases the executor', async () => {
  const f = await fixture();
  try {
    await f.configure('/wait');
    await f.page.locator('#start').click();
    await expect.poll(() => f.held.size).toBe(1);
    await f.page.close();
    await expect.poll(() => f.held.size).toBe(0);
    await idle(f.settings);
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

test('losing the offscreen executor interrupts the task without replay', async () => {
  const f = await fixture();
  try {
    await f.configure('/wait');
    await f.page.locator('#start').click();
    await expect.poll(() => f.held.size).toBe(1);
    await f.worker.evaluate(() =>
      (globalThis as unknown as ChromeGlobal).chrome.offscreen.closeDocument(),
    );
    await expect(f.page.locator('body')).toHaveAttribute('data-state', 'interrupted');
    await expect.poll(() => f.held.size).toBe(0);
    expect(f.count()).toBe(1);
    await idle(f.settings);
  } finally {
    await f.close();
  }
});

test('navigating the owning tab cancels the old document before any late result', async () => {
  const f = await fixture();
  try {
    await f.configure('/wait');
    await f.page.locator('#start').click();
    await expect.poll(() => f.held.size).toBe(1);
    await f.page.goto(new URL('/next-page', f.page.url()).href);
    await expect.poll(() => f.held.size).toBe(0);
    expect(await f.page.locator('body').getAttribute('data-result')).toBeNull();
    expect(f.count()).toBe(1);
    await idle(f.settings);
  } finally {
    await f.close();
  }
});
