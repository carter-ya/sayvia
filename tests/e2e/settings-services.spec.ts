import { expect, test, type Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { workflowFixture } from '../fixtures/core-workflow-extension';
import type { ConnectionIdentity, ConnectionView } from '../../src/runtime/connection-test';
type ChromeGlobal = { chrome: typeof browser };
const send = (page: Page, message: unknown) =>
  page.evaluate(
    (message) => (globalThis as unknown as ChromeGlobal).chrome.runtime.sendMessage(message),
    message,
  );
async function identity(page: Page): Promise<ConnectionIdentity> {
  const snapshot = await send(page, { type: 'settings.read' });
  const provider = snapshot.data.providers[0];
  return {
    providerId: provider.id,
    providerRevision: provider.revision,
    clientTaskId: crypto.randomUUID(),
    documentNonce: crypto.randomUUID(),
  };
}
async function state(page: Page, payload: ConnectionIdentity) {
  const result = await send(page, { type: 'settings.test.status', payload });
  return result.data as ConnectionView | undefined;
}
test('real settings connection tests are revision-bound, deduplicated, and isolated from page drafts', async () => {
  const f = await workflowFixture();
  try {
    const payload = await identity(f.settings);
    const request = { type: 'settings.test.start', payload };
    expect(await send(f.popup, request)).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect((await send(f.settings, request)).ok).toBe(true);
    expect((await send(f.settings, request)).ok).toBe(true);
    await expect.poll(async () => (await state(f.settings, payload))?.state).toBe('passed');
    expect(f.count()).toBe(1);
    expect(f.requestBodies[0]).toContain('Hello from Sayvia.');
    expect(f.requestBodies[0]).not.toContain('前缀');
    await expect(f.page.locator('#editor')).toHaveValue('前缀 中文 后缀');
    await f.settings.getByLabel('模型名称').fill('another-fixture-model');
    await f.settings.getByRole('button', { name: '保存配置' }).click();
    await expect(f.settings.getByRole('status')).toHaveText('已保存配置。');
    expect((await state(f.settings, payload))?.state).toBe('stale');
    expect(await send(f.settings, request)).toEqual({ ok: false, error: 'CONFLICT' });
    expect(f.count()).toBe(1);
    const fresh = await identity(f.settings);
    expect((await send(f.settings, { type: 'settings.test.start', payload: fresh })).ok).toBe(true);
    await expect.poll(async () => (await state(f.settings, fresh))?.state).toBe('passed');
    expect(f.count()).toBe(2);
    expect(JSON.parse(f.requestBodies[1]!).model).toBe('another-fixture-model');
  } finally {
    await f.close();
  }
});
test('a connection cancellation arriving before START prevents the model request', async () => {
  const f = await workflowFixture();
  try {
    const payload = await identity(f.settings);
    expect((await send(f.settings, { type: 'settings.test.cancel', payload })).data.state).toBe(
      'canceled',
    );
    expect((await send(f.settings, { type: 'settings.test.start', payload })).data.state).toBe(
      'canceled',
    );
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
