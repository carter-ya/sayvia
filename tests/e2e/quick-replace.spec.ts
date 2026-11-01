import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';
async function quick(f: Awaited<ReturnType<typeof workflowFixture>>, enabled: boolean) {
  await f.settings.getByRole('button', { name: '翻译偏好', exact: true }).click();
  await f.settings.getByLabel('开启写作快速替换', { exact: true }).setChecked(enabled);
  await f.settings.getByRole('button', { name: '保存偏好', exact: true }).click();
  await expect(f.settings.getByRole('status')).toHaveText('已保存偏好。');
}
test('opted-in quick replacement uses the controlled editor path and provides one-step restoration', async () => {
  const f = await workflowFixture();
  try {
    await quick(f, true);
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await expect(panel.getByText('本次范围：全文 · 快速替换已开启', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('已替换，可恢复原文。');
    await expect(f.page.locator('#editor')).toHaveValue('前缀 English 后缀');
    await expect(f.page.getByTestId('submitted')).toHaveText('');
    await panel.getByRole('button', { name: '恢复原文', exact: true }).click();
    await expect(f.page.locator('#editor')).toHaveValue('前缀 中文 后缀');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
test('quick mode cannot overwrite a changed draft, even after an edit is undone', async () => {
  const f = await workflowFixture();
  try {
    await quick(f, true);
    f.delay(800);
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect.poll(f.count).toBe(1);
    await f.page.locator('#editor').fill('changed');
    await f.page.locator('#editor').fill('前缀 中文 后缀');
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    await expect(panel.getByRole('button', { name: '替换全文', exact: true })).toBeDisabled();
    await expect(f.page.locator('#editor')).toHaveValue('前缀 中文 后缀');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
test('turning quick replacement off while a request runs prevents its automatic write', async () => {
  const f = await workflowFixture();
  try {
    await quick(f, true);
    f.delay(1500);
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect.poll(f.count).toBe(1);
    await quick(f, false);
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    await expect(panel.getByRole('button', { name: '替换全文', exact: true })).toBeEnabled();
    await expect(f.page.locator('#editor')).toHaveValue('前缀 中文 后缀');
  } finally {
    await f.close();
  }
});
test('ordinary text inputs replace only the recorded selection and keep one-step restoration', async () => {
  const f = await workflowFixture();
  try {
    await quick(f, true);
    await f.page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'generic-write';
      input.type = 'text';
      input.value = '前缀 中文 后缀';
      input.addEventListener('input', () => {
        input.dataset.accepted = input.value;
      });
      document.body.prepend(input);
      input.focus();
      input.setSelectionRange(3, 5);
    });
    const panel = await f.open('write');
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('中文');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(f.page.locator('#generic-write')).toHaveValue('前缀 English 后缀');
    await expect(f.page.locator('#generic-write')).toHaveAttribute(
      'data-accepted',
      '前缀 English 后缀',
    );
    await panel.getByRole('button', { name: '恢复原文', exact: true }).click();
    await expect(f.page.locator('#generic-write')).toHaveValue('前缀 中文 后缀');
  } finally {
    await f.close();
  }
});

for (const enabled of [true, false]) {
  test(`quick replacement uses the preference saved after opening the panel (${enabled})`, async () => {
    const f = await workflowFixture();
    try {
      await quick(f, !enabled);
      await f.page.locator('#editor').focus();
      const panel = await f.open('write');
      await expect(panel.getByRole('button', { name: '翻译', exact: true })).toBeEnabled();
      await quick(f, enabled);
      await panel.getByRole('button', { name: '翻译', exact: true }).click();
      await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
      if (enabled) await expect(panel.getByRole('status')).toHaveText('已替换，可恢复原文。');
      await expect(f.page.locator('#editor')).toHaveValue(
        enabled ? '前缀 English 后缀' : '前缀 中文 后缀',
      );
      await expect(
        panel.getByText(`本次范围：全文 · ${enabled ? '快速替换已开启' : '预览后手动替换'}`, {
          exact: true,
        }),
      ).toBeVisible();
      expect(f.count()).toBe(1);
    } finally {
      await f.close();
    }
  });
}
