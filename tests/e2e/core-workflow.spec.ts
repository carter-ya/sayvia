import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';

test('real writing flow previews, edits, copies, replaces controlled state and restores without submission', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    await f.page
      .locator('#editor')
      .evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(3, 5));
    const panel = await f.open('write');
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('中文');
    expect(f.count()).toBe(0);
    await panel
      .getByRole('button', { name: '翻译', exact: true })
      .evaluate((button) => (button as HTMLButtonElement).click());
    expect(f.count()).toBe(0);
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English');
    await expect(f.page.locator('#editor')).toHaveValue('前缀 中文 后缀');
    await expect(f.page.getByTestId('submitted')).toHaveText('');
    await panel.getByLabel('译文', { exact: true }).fill('English!');
    const replace = panel.getByRole('button', { name: '替换选区', exact: true });
    await expect(replace).toBeEnabled();
    await replace.evaluate((button) => (button as HTMLButtonElement).click());
    await expect(f.page.locator('#editor')).toHaveValue('前缀 中文 后缀');
    await replace.click();
    await expect(f.page.locator('#editor')).toHaveValue('前缀 English! 后缀');
    await expect(f.page.getByTestId('submitted')).toHaveText('');
    await f.page.getByRole('button', { name: '模拟用户提交' }).click();
    await expect(f.page.getByTestId('submitted')).toHaveText('前缀 English! 后缀');
    await panel.getByRole('button', { name: '恢复原文', exact: true }).click();
    await expect(f.page.locator('#editor')).toHaveValue('前缀 中文 后缀');
    await f.page.getByRole('button', { name: '模拟用户提交' }).click();
    await expect(f.page.getByTestId('submitted')).toHaveText('前缀 中文 后缀');
    await panel.getByRole('button', { name: '复制译文', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('已复制。');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

for (const scope of ['selection', 'full'] as const) {
  test(`restored ${scope} translations can be reapplied repeatedly without another model request`, async () => {
    const f = await workflowFixture();
    try {
      const editor = f.page.locator('#editor');
      await editor.focus();
      await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(3, 5));
      const panel = await f.open('write');
      if (scope === 'full') {
        await panel.getByText('更多选项', { exact: true }).click();
        await panel.getByRole('button', { name: '全文', exact: true }).click();
      }
      await panel.getByRole('button', { name: '翻译', exact: true }).click();
      await expect(panel.getByLabel('译文', { exact: true })).toHaveValue(
        scope === 'selection' ? 'English' : '前缀 English 后缀',
      );
      const replace = panel.getByRole('button', {
        name: scope === 'selection' ? '替换选区' : '替换全文',
        exact: true,
      });
      for (let cycle = 0; cycle < 3; cycle++) {
        await replace.click();
        await expect(editor).toHaveValue('前缀 English 后缀');
        await panel.getByRole('button', { name: '恢复原文', exact: true }).click();
        await expect(editor).toHaveValue('前缀 中文 后缀');
        await expect(replace).toBeEnabled();
        // Reapplying must use the original scope and range, even though restore
        // collapses the caret and scripts can move the live selection afterwards.
        await editor.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 2));
      }
      await editor.fill('用户修改的新草稿');
      await editor.fill('前缀 中文 后缀');
      await expect(replace).toBeDisabled();
      await expect(f.page.locator('#other')).toHaveValue('另一份草稿');
      await expect(f.page.getByTestId('submitted')).toHaveText('');
      expect(f.count()).toBe(1);
    } finally {
      await f.close();
    }
  });
}

test('editing then undoing the source during translation never revives replacement', async () => {
  const f = await workflowFixture();
  try {
    f.delay();
    await f.page.locator('#editor').focus();
    await f.page
      .locator('#editor')
      .evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(3, 5));
    const panel = await f.open('write');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect.poll(() => f.count()).toBe(1);
    await f.page.locator('#editor').fill('changed');
    await f.page.locator('#editor').fill('前缀 中文 后缀');
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English');
    await expect(panel.getByRole('button', { name: '替换选区', exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: '复制译文', exact: true })).toBeEnabled();
    await expect(f.page.locator('#editor')).toHaveValue('前缀 中文 后缀');
  } finally {
    await f.close();
  }
});

test('reading keeps rendered code local, never rewrites the page and rejects duplicate injection', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      const root = document.createElement('p');
      root.id = 'reading-content';
      root.innerHTML = 'Read <code>timeout</code> first.';
      document.body.append(root);
      const range = document.createRange();
      range.selectNodeContents(root);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    const before = await f.page.locator('#reading-content').innerHTML();
    const panel = await f.open('read');
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('Read timeout first.');
    await f.open('read');
    await expect(f.page.getByRole('dialog', { name: 'Sayvia 翻译' })).toHaveCount(1);
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByRole('region', { name: '译文预览' })).toHaveText('阅读 timeout 优先。');
    await expect(panel.getByRole('region', { name: '译文预览' }).locator('code')).toHaveText(
      'timeout',
    );
    expect(f.requestBodies[0]).not.toContain('timeout');
    expect(await f.page.locator('#reading-content').innerHTML()).toBe(before);
    await expect(panel.getByRole('button', { name: /替换/ })).toHaveCount(0);
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

test('full scope preserves the selected range and restoration conflicts keep the new draft', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    await f.page
      .locator('#editor')
      .evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(3, 5));
    const panel = await f.open('write');
    await panel.getByText('更多选项', { exact: true }).click();
    await panel.getByRole('button', { name: '全文', exact: true }).click();
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('前缀 中文 后缀');
    expect(
      await f.page
        .locator('#editor')
        .evaluate((element) => [
          (element as HTMLTextAreaElement).selectionStart,
          (element as HTMLTextAreaElement).selectionEnd,
        ]),
    ).toEqual([3, 5]);
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    await panel.getByRole('button', { name: '替换全文', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('已替换，可恢复原文。');
    await expect(f.page.locator('#editor')).toHaveValue('前缀 English 后缀');
    await f.page.locator('#editor').fill('new user draft');
    await expect(panel.getByRole('button', { name: '恢复原文', exact: true })).toBeDisabled();
    await expect(panel.getByRole('button', { name: '复制替换前原文', exact: true })).toBeEnabled();
    await expect(f.page.locator('#editor')).toHaveValue('new user draft');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

test('edited Markdown candidates protect code and URLs in a simulated GitHub comment form', async () => {
  const f = await workflowFixture();
  try {
    await f.context.route('https://github.com/carter-ya/sayvia/issues/123', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><body><textarea id="new_comment_field" name="comment[body]">你好 `timeout` [说明](https://example.test)</textarea></body></html>',
      }),
    );
    const github = await f.context.newPage();
    await github.goto('https://github.com/carter-ya/sayvia/issues/123');
    await github.locator('#new_comment_field').focus();
    await github
      .locator('textarea')
      .evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(0, 0));
    const panel = await f.open('write', github);
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue(
      'English `timeout` [说明](https://example.test)',
    );
    const replace = panel.getByRole('button', { name: '替换全文', exact: true });
    await panel
      .getByLabel('译文', { exact: true })
      .fill('English `changed` [说明](https://example.test)');
    await expect(replace).toBeDisabled();
    await panel
      .getByLabel('译文', { exact: true })
      .fill('English `timeout` [说明](https://other.test)');
    await expect(replace).toBeDisabled();
    await panel
      .getByLabel('译文', { exact: true })
      .fill('English! `timeout` [说明](https://example.test)');
    await expect(replace).toBeEnabled();
    await replace.click();
    await expect(github.locator('#new_comment_field')).toHaveValue(
      'English! `timeout` [说明](https://example.test)',
    );
    expect(f.requestBodies[0]).not.toMatch(/timeout|example.test/);
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

test('Escape asks before discarding edited text and missing ranges never start requests', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).not.toHaveValue('');
    await panel.getByLabel('译文', { exact: true }).fill('User edit');
    f.page.once('dialog', (dialog) => void dialog.dismiss());
    await panel.getByLabel('译文', { exact: true }).press('Escape');
    await expect(panel).toBeVisible();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('User edit');
    f.page.once('dialog', (dialog) => void dialog.accept());
    await panel.getByLabel('译文', { exact: true }).press('Escape');
    await expect(panel).toBeHidden();
    await f.page.evaluate(() => window.getSelection()!.removeAllRanges());
    const read = await f.open('read');
    await expect(read.getByRole('button', { name: '翻译', exact: true })).toBeDisabled();
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

test('translation sends the previewed snapshot even if scripts later change the native selection', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    await f.page
      .locator('#editor')
      .evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(3, 5));
    const panel = await f.open('write');
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('中文');
    await f.page.locator('#editor').evaluate((element) => {
      const control = element as HTMLTextAreaElement;
      control.setSelectionRange(0, control.value.length);
    });
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English');
    expect(f.requestBodies[0]).not.toMatch(/前缀|后缀/);
    await panel.getByRole('button', { name: '替换选区', exact: true }).click();
    await expect(f.page.locator('#editor')).toHaveValue('前缀 English 后缀');
  } finally {
    await f.close();
  }
});

test('source edits before translation require an explicit refresh and do not spend a request', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await f.page.locator('#editor').fill('你好');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('原稿已修改，请重新读取原文后再翻译。');
    expect(f.count()).toBe(0);
    await panel.getByText('更多选项', { exact: true }).click();
    await panel.getByRole('button', { name: '重新读取原文', exact: true }).click();
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('你好');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

for (const kind of ['rich-text', 'password', 'readonly'] as const) {
  test(`a ${kind} target cannot reuse the previous editor`, async () => {
    const f = await workflowFixture();
    try {
      await f.page.locator('#editor').focus();
      const first = await f.open('write');
      await expect(first.getByLabel('原文', { exact: true })).toHaveValue('前缀 中文 后缀');
      await first.getByRole('button', { name: '关闭翻译面板' }).click();
      await f.page.evaluate((kind) => {
        const element = document.createElement(
          kind === 'readonly' ? 'textarea' : kind === 'password' ? 'input' : 'div',
        );
        element.id = 'unsupported-editor';
        if (element instanceof HTMLInputElement) {
          element.type = 'password';
          element.value = 'do-not-send';
        } else if (element instanceof HTMLTextAreaElement) {
          element.readOnly = true;
          element.value = 'readonly source';
        } else {
          element.contentEditable = 'true';
          element.textContent = 'rich editor source';
        }
        document.body.append(element);
        element.focus();
      }, kind);
      const panel = await f.open('write');
      if (kind === 'rich-text') {
        await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('rich editor source');
        await expect(panel.getByRole('status')).toContainText('预览与复制');
        await expect(panel.getByRole('button', { name: /替换/ })).toHaveCount(0);
        await panel.getByRole('button', { name: '翻译', exact: true }).click();
        await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('rich editor source');
        expect(f.requestBodies[0]).not.toContain('前缀');
        await expect(f.page.locator('#editor')).toHaveValue('前缀 中文 后缀');
        await expect(f.page.locator('#unsupported-editor')).toHaveText('rich editor source');
        return;
      }
      await expect(panel.getByRole('status')).toHaveText(
        '当前编辑框无法安全替换，请通过工具栏手动粘贴翻译。',
      );
      await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('');
      await expect(panel.getByRole('button', { name: '翻译', exact: true })).toBeDisabled();
      await panel.getByText('更多选项', { exact: true }).click();
      await panel.getByRole('button', { name: '全文', exact: true }).click();
      await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('');
      expect(f.count()).toBe(0);
      await expect(f.page.locator('#editor')).toHaveValue('前缀 中文 后缀');
      await panel.getByRole('button', { name: '关闭翻译面板' }).click();
      await f.page.locator('#other').focus();
      const supported = await f.open('write');
      await expect(supported.getByLabel('原文', { exact: true })).toHaveValue('另一份草稿');
      await expect(supported.getByRole('button', { name: '翻译', exact: true })).toBeEnabled();
    } finally {
      await f.close();
    }
  });
}

test('reopening the toolbar preserves an edited candidate when discarding is declined', async () => {
  const f = await workflowFixture();
  try {
    await f.page.locator('#editor').focus();
    const panel = await f.open('write');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    await panel.getByLabel('译文', { exact: true }).fill('Edited English candidate');
    let confirmations = 0;
    f.page.once('dialog', async (dialog) => {
      confirmations++;
      await dialog.dismiss();
    });
    const reopened = await f.open('write');
    await expect(reopened.getByLabel('译文', { exact: true })).toHaveValue(
      'Edited English candidate',
    );
    expect(confirmations).toBe(1);
    expect(f.count()).toBe(1);
    await expect(reopened.getByRole('button', { name: '替换全文', exact: true })).toBeEnabled();
    await reopened.getByRole('button', { name: '替换全文', exact: true }).click();
    await expect(f.page.locator('#editor')).toHaveValue('Edited English candidate');
  } finally {
    await f.close();
  }
});
