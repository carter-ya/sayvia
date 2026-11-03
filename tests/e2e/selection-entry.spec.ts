import { expect, test } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { workflowFixture } from '../fixtures/core-workflow-extension';
type ChromeGlobal = { chrome: typeof browser };
async function enabled() {
  const f = await workflowFixture();
  await expect(f.page.locator('[data-sayvia-entry]')).toHaveCount(1);
  await f.page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'article';
    p.innerHTML = 'Read <code>timeout</code> first.';
    p.style.cssText = 'font-size:24px; margin:100px 40px; max-width:600px';
    document.body.prepend(p);
  });
  return f;
}
async function select(f: Awaited<ReturnType<typeof enabled>>) {
  // Build a real DOM Range, then use a genuine keyboard selection gesture to capture it.
  await f.page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#article')!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await f.page.keyboard.press('Shift');
  return f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' });
}
test('selecting text shows an icon; its trusted click translates directly without opening the toolbar', async () => {
  const f = await enabled();
  try {
    const icon = await select(f);
    await expect(icon).toBeVisible();
    expect(f.count()).toBe(0);
    await icon.evaluate((button) => (button as HTMLButtonElement).click());
    expect(f.count()).toBe(0);
    await icon.click();
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('region', { name: '译文预览' })).toHaveText('阅读 timeout 优先。');
    await expect(panel.getByLabel('目标语言', { exact: true })).toHaveValue('简体中文');
    await expect(panel.getByText('模型：fixture-model', { exact: true })).toBeHidden();
    expect(f.requestBodies[0]).not.toContain('timeout');
    expect(f.count()).toBe(1);
    await expect(f.page.locator('#article')).toHaveText('Read timeout first.');
    await panel.getByRole('button', { name: '编辑译文', exact: true }).click();
    await panel.getByLabel('译文', { exact: true }).fill('我编辑的译文');
    await panel.getByRole('button', { name: '复制译文' }).click();
    await expect(panel.getByRole('status')).toHaveText('已复制。');
    expect(f.count()).toBe(1);
    await f.page.setViewportSize({ width: 375, height: 720 });
    const rect = await panel.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(375);
  } finally {
    await f.close();
  }
});
test('the icon freezes the captured source instead of silently translating a script-selected range', async () => {
  const f = await enabled();
  try {
    const icon = await select(f);
    await expect(icon).toBeVisible();
    await f.page.evaluate(() => {
      const other = document.createElement('p');
      other.textContent = 'PRIVATE OTHER TEXT';
      document.body.append(other);
      const range = document.createRange();
      range.selectNodeContents(other);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await icon.click();
    await expect(f.page.getByRole('region', { name: '译文预览' })).toHaveText(
      '阅读 timeout 优先。',
    );
    expect(f.requestBodies[0]).not.toContain('PRIVATE OTHER TEXT');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
test('changing the captured DOM before icon activation cannot spend a model request', async () => {
  const f = await enabled();
  try {
    const icon = await select(f);
    await expect(icon).toBeVisible();
    await f.page.locator('#article').evaluate((node) => {
      node.textContent = 'changed';
    });
    await icon.click();
    await expect(
      f.page.getByRole('dialog', { name: 'Sayvia 翻译' }).getByRole('status'),
    ).toHaveText('选区已变化，请重新选择原文。');
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
test('a simulated Chrome site-access restriction cancels pending work and blocks future inline requests', async () => {
  const f = await enabled();
  try {
    f.delay(30_000);
    const icon = await select(f);
    await icon.click();
    await expect.poll(f.pending).toBe(1);
    await f.blockSite('http://127.0.0.1');
    await expect.poll(f.pending).toBe(0);
    await expect(
      f.page.getByRole('dialog', { name: 'Sayvia 翻译' }).getByRole('status'),
    ).toContainText('网站访问');
    await select(f);
    await expect(icon).toBeHidden();
    expect(f.count()).toBe(1);
    // Verify backend enforcement independently of the content UI flag.
    const result = await f.settings.evaluate(async (url) => {
      const api = (globalThis as unknown as ChromeGlobal).chrome;
      const tab = (await api.tabs.query({})).find((item) => item.url === url)!;
      return api.scripting.executeScript({
        target: { tabId: tab.id!, frameIds: [0] },
        func: async () => {
          const runtime = (globalThis as unknown as ChromeGlobal).chrome.runtime;
          return runtime.sendMessage({
            protocolVersion: 1,
            requestId: crypto.randomUUID(),
            type: 'translation.start',
            payload: {
              clientTaskId: crypto.randomUUID(),
              documentNonce: crypto.randomUUID(),
              entry: 'inline',
              mode: 'read',
              scope: 'selection',
              source: { kind: 'dom-selection', text: 'Read', protectedRanges: [], marks: [] },
              sourceLanguage: 'auto',
              targetLanguage: 'zh-Hans',
            },
          });
        },
      });
    }, f.page.url());
    expect(result[0]!.result).toMatchObject({ ok: false, error: 'SITE_DISABLED' });
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
test('explicit code-only selections use the model while editing fields keep their separate writing entry', async () => {
  const f = await enabled();
  try {
    await f.page.locator('#article').evaluate((p) => {
      p.innerHTML = '<code>secret-code-only</code>';
    });
    const icon = await select(f);
    await icon.click();
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await expect(panel.getByRole('region', { name: '译文预览' })).toHaveText('secret-code-only');
    await expect(panel.getByRole('status')).toContainText('结果与原文相同');
    await expect(panel.getByRole('button', { name: '复制译文' })).toBeEnabled();
    expect(f.count()).toBe(1);
    await panel.getByRole('button', { name: '关闭翻译面板' }).click();
    await f.page.locator('#editor').focus();
    await f.page.keyboard.press('ControlOrMeta+A');
    await f.page.keyboard.press('Shift');
    await expect(icon).toBeHidden();
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
test('a native mouse selection shows the entry and Escape dismisses it without a request', async () => {
  const f = await enabled();
  try {
    await f.page.locator('#article').click({ clickCount: 3 });
    const icon = f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' });
    await expect(icon).toBeVisible();
    await f.page.keyboard.press('Escape');
    await expect(icon).toBeHidden();
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
