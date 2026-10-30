import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type ChromeRuntime = { runtime: { sendMessage(message: unknown): Promise<unknown> } };
const KEY = 'fixture-persistent-secret-not-a-real-key';

async function openSettings(context: BrowserContext) {
  const background = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(background.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await expect(page.getByLabel('选择配置')).toBeVisible();
  return { page, id };
}

async function assertNoSecretResponse(page: Page) {
  const response = await page.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: ChromeRuntime }).chrome;
    return api.runtime.sendMessage({ type: 'settings.read' });
  });
  expect(JSON.stringify(response)).not.toContain(KEY);
  expect(JSON.stringify(response)).not.toContain('secretRef');
}

test('keys survive browser restarts and same-id updates while page scripts cannot read them', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sayvia-persistence-'));
  const extension = join(temporary, 'extension');
  const profile = join(temporary, 'profile');
  await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
  const manifestFile = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  manifest.content_scripts = [{ matches: ['http://127.0.0.1/*'], js: ['storage-probe.js'] }];
  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(
    join(extension, 'storage-probe.js'),
    `
    chrome.storage.local.get('sayvia.config').then(
      () => { document.documentElement.dataset.storageAccess = 'readable'; },
      () => { document.documentElement.dataset.storageAccess = 'blocked'; }
    );
  `,
  );
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><html><body>Storage isolation fixture</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server unavailable');
  const url = `http://127.0.0.1:${address.port}`;
  let context: BrowserContext | undefined;
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
  try {
    context = await launch();
    const first = await openSettings(context);
    await first.page.getByLabel('配置名称').fill('持久配置');
    await first.page.getByLabel('模型名称').fill('fixture-model');
    await first.page.getByLabel('API Key', { exact: true }).fill(KEY);
    await first.page.getByRole('button', { name: '保存配置' }).click();
    await expect(first.page.getByRole('status')).toHaveText('已保存配置。');
    await expect(first.page.getByLabel('API Key', { exact: true })).toHaveValue('');
    await assertNoSecretResponse(first.page);
    const probe = await context.newPage();
    await probe.goto(url);
    await expect(probe.locator('html')).toHaveAttribute('data-storage-access', 'blocked');
    await context.close();
    context = undefined;

    context = await launch();
    const restarted = await openSettings(context);
    expect(restarted.id).toBe(first.id);
    await restarted.page.getByLabel('选择配置').selectOption({ label: '持久配置' });
    await expect(
      restarted.page.getByText('已保存 Key，留空保留原值。', { exact: false }),
    ).toBeVisible();
    await assertNoSecretResponse(restarted.page);
    await context.close();
    context = undefined;

    manifest.version = '0.1.1';
    await writeFile(manifestFile, JSON.stringify(manifest));
    context = await launch();
    const updated = await openSettings(context);
    expect(updated.id).toBe(first.id);
    await updated.page.getByLabel('选择配置').selectOption({ label: '持久配置' });
    await expect(
      updated.page.getByText('已保存 Key，留空保留原值。', { exact: false }),
    ).toBeVisible();
    await assertNoSecretResponse(updated.page);
    updated.page.on('dialog', (dialog) => void dialog.accept());
    await updated.page.getByRole('button', { name: '删除配置' }).click();
    await expect(updated.page.getByRole('status')).toHaveText('已删除配置及其 Key。');
    const afterDelete = await updated.page.evaluate(async () => {
      const api = (
        globalThis as unknown as {
          chrome: {
            storage: { local: { get(key: string): Promise<Record<string, { secrets: object }>> } };
          };
        }
      ).chrome;
      const state = await api.storage.local.get('sayvia.config');
      return Object.keys(state['sayvia.config']?.secrets ?? {}).length;
    });
    expect(afterDelete).toBe(0);
  } finally {
    await context?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(temporary, { recursive: true, force: true });
  }
});
