import { expect, test } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { StateSchema } from '../../src/storage/schema';
import { SessionSchema } from '../../src/runtime/task-protocol';
import { workflowFixture } from '../fixtures/core-workflow-extension';
type ChromeGlobal = { chrome: typeof browser };

test('language and theme preferences persist while unsaved changes are discarded on explicit reload', async () => {
  const f = await workflowFixture();
  try {
    await f.settings.getByRole('button', { name: '翻译偏好', exact: true }).click();
    await f.settings.getByLabel('阅读目标语言', { exact: true }).selectOption('ja');
    await f.settings.getByLabel('写作目标语言', { exact: true }).selectOption('fr');
    await f.settings.getByLabel('界面主题').selectOption('dark');
    expect(await f.settings.evaluate(() => document.documentElement.style.colorScheme)).toBe(
      'dark',
    );
    await f.settings.getByRole('button', { name: '保存偏好' }).click();
    await expect(f.settings.getByRole('status')).toHaveText('已保存偏好。');
    await f.settings.reload();
    await f.settings.getByRole('button', { name: '翻译偏好', exact: true }).click();
    await expect(f.settings.getByLabel('阅读目标语言', { exact: true })).toHaveValue('ja');
    await expect(f.settings.getByLabel('写作目标语言', { exact: true })).toHaveValue('fr');
    await expect(f.settings.getByLabel('界面主题')).toHaveValue('dark');
    await f.settings.getByLabel('阅读目标语言', { exact: true }).selectOption('en');
    await f.settings.getByLabel('界面主题').selectOption('light');
    f.settings.once('dialog', (dialog) => void dialog.accept());
    await f.settings.getByRole('button', { name: '重新载入' }).click();
    await expect(f.settings.getByLabel('阅读目标语言', { exact: true })).toHaveValue('ja');
    await expect(f.settings.getByLabel('界面主题')).toHaveValue('dark');
    expect(await f.settings.evaluate(() => document.documentElement.style.colorScheme)).toBe(
      'dark',
    );
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
test('clearing data removes keys, results and restore points while aborting an active model request', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    await panel.getByRole('button', { name: '替换全文', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('已替换，可恢复原文。');
    await expect(panel.getByRole('button', { name: '恢复原文', exact: true })).toBeEnabled();
    f.delay(30_000);
    const current = await f.open('write');
    await current.getByRole('button', { name: '翻译', exact: true }).click();
    await expect.poll(f.count).toBe(2);
    await expect.poll(f.pending).toBe(1);
    await f.settings.getByRole('button', { name: '权限与数据', exact: true }).click();
    await f.settings.getByLabel('同时撤销已授权主机').uncheck();
    f.settings.once('dialog', (dialog) => void dialog.accept());
    await f.settings.getByRole('button', { name: '清除全部本地数据' }).click();
    await expect(f.settings.getByRole('status')).toHaveText('已清除本地配置、Key 和会话数据。');
    await expect.poll(f.pending).toBe(0);
    await expect(f.page.getByRole('dialog', { name: 'Sayvia 翻译' })).toHaveCount(0);
    const stored = await f.settings.evaluate(async () => {
      const api = (globalThis as unknown as ChromeGlobal).chrome;
      return {
        local: await api.storage.local.get(null),
        session: await api.storage.session.get(null),
      };
    });
    expect(JSON.stringify(stored)).not.toContain('WORKFLOW_FIXTURE_KEY');
    expect(JSON.stringify(stored)).not.toContain('前缀');
    expect(StateSchema.parse(stored.local['sayvia.config']).providers).toEqual({});
    expect(SessionSchema.parse(stored.session['sayvia.tasks']).manual).toEqual([]);
    expect(SessionSchema.parse(stored.session['sayvia.tasks']).routes).toEqual([]);
    await expect(f.page.locator('#editor')).toHaveValue('前缀 English 后缀');
    await f.page.locator('#editor').focus();
    const reopened = await f.open('write');
    await expect(reopened.getByRole('button', { name: '恢复原文', exact: true })).toHaveCount(0);
    await reopened.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(reopened.getByRole('status')).toHaveText('请先在插件设置中保存模型和 API Key。');
    expect(f.count()).toBe(2);
    await f.settings.reload();
    await expect(f.settings.getByLabel('配置名称')).toHaveValue('');
    await expect(f.settings.getByLabel('API Key', { exact: true })).toHaveValue('');
  } finally {
    await f.close();
  }
});
test('site authorization requires an explicit click and handles a declined prompt without model calls', async () => {
  const f = await workflowFixture();
  try {
    await f.settings.getByRole('button', { name: '权限与数据', exact: true }).click();
    // Test-only refusal response: the real native Allow/Revoke flow is recorded separately.
    await f.settings.evaluate(() => {
      const api = (globalThis as unknown as ChromeGlobal).chrome;
      const state = globalThis as typeof globalThis & { requestedHosts?: string[][] };
      state.requestedHosts = [];
      api.permissions.request = async (request) => {
        state.requestedHosts!.push(request.origins ?? []);
        return false;
      };
    });
    await f.settings.getByLabel('网站地址').fill('https://docs.example.test/guide');
    const requests = () =>
      f.settings.evaluate(
        () => (globalThis as typeof globalThis & { requestedHosts?: string[][] }).requestedHosts,
      );
    await f.settings
      .getByRole('button', { name: '授权此网站', exact: true })
      .evaluate((button) => (button as HTMLButtonElement).click());
    expect(await requests()).toEqual([]);
    await f.settings.getByRole('button', { name: '授权此网站', exact: true }).click();
    await expect(f.settings.getByRole('note')).toHaveText('未获得授权，该网站的自动入口暂不可用。');
    expect(await requests()).toEqual([['https://docs.example.test/*']]);
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
