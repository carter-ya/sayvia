import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';

test('connection tests require a trusted click and saved inputs; editing invalidates success', async () => {
  const f = await workflowFixture();
  try {
    const button = f.settings.getByRole('button', { name: '测试连接', exact: true });
    await button.evaluate((button) => (button as HTMLButtonElement).click());
    expect(f.count()).toBe(0);
    await expect(f.settings.getByTestId('connection-status')).toHaveText('尚未测试连接');
    await button.click();
    await expect(f.settings.getByTestId('connection-status')).toHaveText('连接可用');
    expect(f.count()).toBe(1);
    await f.settings.getByLabel('模型名称').fill('another-fixture-model');
    await expect(button).toBeDisabled();
    await expect(f.settings.getByTestId('connection-status')).toContainText('保存后重新测试');
    await f.settings.getByRole('button', { name: '保存配置' }).click();
    await expect(f.settings.getByRole('status')).toHaveText('已保存配置。');
    await expect(f.settings.getByLabel('API Key', { exact: true })).toHaveValue('');
    await button.click();
    await expect(f.settings.getByTestId('connection-status')).toHaveText('连接可用');
    expect(f.count()).toBe(2);
    expect(JSON.parse(f.requestBodies[1]!).model).toBe('another-fixture-model');
  } finally {
    await f.close();
  }
});
test('switching configurations preserves unsaved fields when discard is declined', async () => {
  const f = await workflowFixture();
  try {
    const picker = f.settings.getByLabel('选择配置');
    const original = await picker.inputValue();
    await f.settings.getByLabel('配置名称').fill('尚未保存的名称');
    f.settings.once('dialog', (dialog) => void dialog.dismiss());
    await picker.selectOption('');
    await expect(picker).toHaveValue(original);
    await expect(f.settings.getByLabel('配置名称')).toHaveValue('尚未保存的名称');
    f.settings.once('dialog', (dialog) => void dialog.accept());
    await picker.selectOption('');
    await expect(f.settings.getByLabel('配置名称')).toHaveValue('');
    await picker.selectOption(original);
    await expect(f.settings.getByLabel('配置名称')).toHaveValue('Workflow fixture');
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
test('a stale save preserves the unsaved key and reloads the latest configuration only after consent', async () => {
  const f = await workflowFixture();
  try {
    const second = await f.context.newPage();
    await second.goto(f.settings.url());
    await expect(second.getByLabel('配置名称')).toHaveValue('Workflow fixture');
    await second.getByLabel('配置名称').fill('Updated in another window');
    await second.getByRole('button', { name: '保存配置' }).click();
    await expect(second.getByRole('status')).toHaveText('已保存配置。');
    await f.settings.getByLabel('API Key', { exact: true }).fill('UNSAVED_FIXTURE_REPLACEMENT');
    await f.settings.getByRole('button', { name: '保存配置' }).click();
    await expect(f.settings.getByRole('status')).toContainText('配置已在其他窗口更新');
    await expect(f.settings.getByLabel('API Key', { exact: true })).toHaveValue(
      'UNSAVED_FIXTURE_REPLACEMENT',
    );
    f.settings.once('dialog', (dialog) => void dialog.accept());
    await f.settings.getByRole('button', { name: '重新载入' }).click();
    await expect(f.settings.getByLabel('配置名称')).toHaveValue('Updated in another window');
    await expect(f.settings.getByLabel('API Key', { exact: true })).toHaveValue('');
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
