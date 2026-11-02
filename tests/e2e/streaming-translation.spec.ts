import { test, expect } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';

test('streaming previews are visible before completion while copy and replacement remain disabled', async () => {
  const f = await workflowFixture();
  try {
    f.stream(450);
    await f.page.locator('#editor').fill('中文内容');
    const panel = await f.open('write');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    const preview = panel.getByRole('region', { name: '流式译文' });
    await expect(preview).toContainText('Eng');
    await expect(panel.getByRole('button', { name: '复制译文', exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: '替换全文', exact: true })).toBeDisabled();
    await expect(f.page.locator('#editor')).toHaveValue('中文内容');
    const metric = panel.getByLabel('翻译用量');
    await expect(metric).toContainText('估算输入');
    const before = await metric.innerText();
    await expect.poll(() => metric.innerText()).not.toBe(before);
    await expect(preview).not.toContainText('segments');
    await expect(preview).not.toContainText('FIXTURE_PRIVATE_REASONING');
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English内容');
    await expect(metric).toContainText('输入 123 / 输出 45 token');
    await expect(metric).not.toContainText('估算');
    await expect(panel.getByRole('button', { name: '复制译文', exact: true })).toBeEnabled();
    expect(f.count()).toBe(1);
    expect(JSON.parse(f.requestBodies[0]!).stream).toBe(true);
  } finally {
    await f.close();
  }
});

test('canceling an active stream clears partial output and never changes the editor', async () => {
  const f = await workflowFixture();
  try {
    f.stream(500);
    await f.page.locator('#editor').fill('中文内容');
    const panel = await f.open('write');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByRole('region', { name: '流式译文' })).toContainText('Eng');
    await panel.getByRole('button', { name: '取消翻译' }).click();
    await expect(panel.getByRole('region', { name: '流式译文' })).toHaveCount(0);
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('');
    await expect(panel.getByRole('button', { name: '复制译文', exact: true })).toBeDisabled();
    await expect.poll(f.pending).toBe(0);
    await expect(f.page.locator('#editor')).toHaveValue('中文内容');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

for (const mode of ['truncated', 'invalid'] as const)
  test(`a ${mode} stream cannot become an applicable result`, async () => {
    const f = await workflowFixture();
    try {
      f.stream(120, mode);
      await f.page.locator('#editor').fill('中文内容');
      const panel = await f.open('write');
      await panel.getByRole('button', { name: '翻译', exact: true }).click();
      await expect(panel.getByRole('status')).not.toBeEmpty();
      await expect(panel.getByRole('button', { name: '取消翻译' })).toHaveCount(0);
      await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('');
      await expect(panel.getByRole('button', { name: '复制译文', exact: true })).toBeDisabled();
      await expect(f.page.locator('#editor')).toHaveValue('中文内容');
    } finally {
      await f.close();
    }
  });

test('manual popup resumes a stream without reissuing the request and retains final usage', async () => {
  const f = await workflowFixture();
  try {
    f.stream(400);
    await f.page.bringToFront();
    let popup = await f.context.newPage();
    const url = f.popup.url();
    await f.page.bringToFront();
    await popup.goto(url);
    await popup.getByRole('tab', { name: '手动翻译', exact: true }).click();
    await popup.getByLabel('待翻译文本', { exact: true }).fill('中文内容');
    await popup.getByRole('button', { name: '翻译文本', exact: true }).click();
    await expect(popup.getByLabel('手动译文', { exact: true })).toHaveValue(/Eng/);
    await expect(popup.getByRole('button', { name: '复制手动译文', exact: true })).toBeDisabled();
    await popup.close();
    await f.page.bringToFront();
    popup = await f.context.newPage();
    await f.page.bringToFront();
    await popup.goto(url);
    await expect(popup.getByLabel('手动译文', { exact: true })).toHaveValue('English内容');
    await expect(popup.getByLabel('翻译用量')).toContainText('输入 123 / 输出 45 token');
    await expect(popup.getByRole('button', { name: '复制手动译文', exact: true })).toBeEnabled();
    await f.page.bringToFront();
    await popup.reload();
    await expect(popup.getByLabel('翻译用量')).toContainText('输入 123 / 输出 45 token');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
