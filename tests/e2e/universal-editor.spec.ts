import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';
import { reviewComposer } from '../fixtures/github-review-composer';
import { commitDiff, commitUrl } from '../fixtures/github-commit-diff';
async function fixture(
  url = 'https://ordinary.example.test/discussion',
  body = '<textarea id=one>前缀 中文 后缀</textarea><textarea id=other>另一份草稿</textarea><input id=single type=text value=你好><div id=rich contenteditable=true role=textbox>你好 <code>sql.Scanner</code></div>',
) {
  const f = await workflowFixture();
  await f.context.route(url, (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><style>body{font:16px system-ui;margin:50px}textarea{display:block;box-sizing:border-box;width:100%;height:100px;margin:45px 0;padding:10px}input{margin:35px 0;height:32px}#rich{margin:40px 0;padding:10px;border:1px solid #aaa;min-height:100px}fieldset{margin:20px}markdown-toolbar,[role=toolbar]{display:flex}.diff-text-inner{white-space:pre-wrap}td{width:45%;padding:10px}</style>${body}`,
    }),
  );
  await f.page.goto(url);
  return f;
}
const panelName = { name: 'Sayvia 翻译' };
test('an ordinary textarea has a contextual full-translation action with replace/restore and draft isolation', async () => {
  const f = await fixture();
  try {
    const field = f.page.locator('#one');
    await field.click();
    await field.press('ArrowRight');
    const action = f.page.getByRole('button', { name: '使用 Sayvia 翻译输入内容' });
    await expect(action).toBeVisible();
    expect(f.count()).toBe(0);
    await action.click();
    const panel = f.page.getByRole('dialog', panelName);
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('前缀 English 后缀');
    await panel.getByRole('button', { name: '替换全文', exact: true }).click();
    await expect(field).toHaveValue('前缀 English 后缀');
    await expect(f.page.locator('#other')).toHaveValue('另一份草稿');
    await panel.getByRole('button', { name: '恢复原文', exact: true }).click();
    await expect(field).toHaveValue('前缀 中文 后缀');
  } finally {
    await f.close();
  }
});
test('ordinary textarea and text input selections translate through their own native range', async () => {
  for (const id of ['one', 'single']) {
    const f = await fixture();
    try {
      const field = f.page.locator('#' + id);
      await field.fill('中文');
      await field.click({ clickCount: 3, position: { x: 20, y: 12 } });
      const action = f.page.getByRole('button', { name: '使用 Sayvia 翻译输入选区' });
      await expect(action).toBeVisible();
      expect(f.count()).toBe(0);
      await expect(f.page.getByRole('button', { name: '使用 Sayvia 翻译输入内容' })).toBeHidden();
      await action.click();
      const panel = f.page.getByRole('dialog', panelName);
      await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English');
      await panel.getByRole('button', { name: '替换选区', exact: true }).click();
      await expect(field).toHaveValue('English');
      await expect(f.page.locator('#other')).toHaveValue('另一份草稿');
    } finally {
      await f.close();
    }
  }
});
test('an ordinary single-line input has full translation without submitting its form', async () => {
  const f = await fixture(
    undefined,
    `<form onsubmit="event.preventDefault();document.querySelector('output').textContent='submitted'"><input id=single type=text value=你好><button>Submit</button><output>not submitted</output></form>`,
  );
  try {
    const field = f.page.locator('#single');
    await field.click();
    await field.press('ArrowRight');
    await f.page.getByRole('button', { name: '使用 Sayvia 翻译输入内容' }).click();
    const panel = f.page.getByRole('dialog', panelName);
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English');
    await panel.getByRole('button', { name: '替换全文', exact: true }).click();
    await expect(field).toHaveValue('English');
    await expect(f.page.locator('output')).toHaveText('not submitted');
  } finally {
    await f.close();
  }
});
test('a rich editor provides full translation and copy without presenting a replacement action', async () => {
  const f = await fixture();
  try {
    const rich = f.page.locator('#rich');
    const original = await rich.innerHTML();
    await rich.click();
    await f.page.getByRole('button', { name: '使用 Sayvia 翻译输入内容' }).click();
    const panel = f.page.getByRole('dialog', panelName);
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English `sql.Scanner`');
    await expect(panel.getByRole('button', { name: /替换/ })).toHaveCount(0);
    await expect(panel.getByRole('status')).toContainText('预览与复制');
    await panel.getByRole('button', { name: '复制译文' }).click();
    await expect(panel.getByRole('status')).toHaveText('已复制。');
    expect(await rich.innerHTML()).toBe(original);
    expect(f.requestBodies[0]).not.toContain('sql.Scanner');
  } finally {
    await f.close();
  }
});
test('a rich editor selection uses writing language defaults and translates only the selected text', async () => {
  const f = await fixture();
  try {
    const rich = f.page.locator('#rich');
    await rich.click();
    await f.page.evaluate(() => {
      const text = document.querySelector('#rich')!.firstChild!;
      const r = document.createRange();
      r.setStart(text, 0);
      r.setEnd(text, 2);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
    await rich.press('Shift');
    await f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' }).click();
    const panel = f.page.getByRole('dialog', panelName);
    await expect(panel.getByLabel('目标语言', { exact: true })).toHaveValue('英语');
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('你好');
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English');
    expect(f.requestBodies[0]).not.toContain('sql.Scanner');
    await expect(panel.getByRole('button', { name: /替换/ })).toHaveCount(0);
  } finally {
    await f.close();
  }
});
test('rich editor scope can return to the original selection after translating the full draft', async () => {
  const f = await fixture(
    undefined,
    '<div id=rich contenteditable=true role=textbox><span>你好</span><p>UNSELECTED_DRAFT</p></div>',
  );
  try {
    const rich = f.page.locator('#rich');
    await rich.click();
    await f.page.evaluate(() => {
      const text = document.querySelector('#rich span')!.firstChild!;
      const r = document.createRange();
      r.setStart(text, 0);
      r.setEnd(text, 2);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
    await rich.press('Shift');
    await f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' }).click();
    const panel = f.page.getByRole('dialog', panelName);
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English');
    await panel.getByText('更多选项', { exact: true }).click();
    await panel.getByRole('button', { name: '全文', exact: true }).click();
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue(/UNSELECTED_DRAFT/);
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue(/UNSELECTED_DRAFT/);
    expect(f.requestBodies[1]).toContain('UNSELECTED_DRAFT');
    await panel.getByRole('button', { name: '优先使用选区', exact: true }).click();
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue('你好');
    await panel.getByRole('button', { name: '翻译', exact: true }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English');
    expect(f.requestBodies[2]).not.toContain('UNSELECTED_DRAFT');
    await expect(rich).toHaveText('你好UNSELECTED_DRAFT');
  } finally {
    await f.close();
  }
});
test('the real commit composer contract has a toolbar and input-selection translation', async () => {
  const f = await fixture(commitUrl, commitDiff() + reviewComposer('_r_commit_'));
  try {
    const composer = f.page.locator('#_r_commit_-composer'),
      field = composer.locator('textarea');
    const action = composer.getByRole('button', { name: '使用 Sayvia 翻译这份评论' });
    await expect(action).toBeVisible();
    await action.click();
    const panel = f.page.getByRole('dialog', panelName);
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English `sql.Scanner`');
    await panel.getByRole('button', { name: '替换全文', exact: true }).click();
    await expect(field).toHaveValue('English `sql.Scanner`');
    await expect(composer.locator('output')).toHaveText('not submitted');
    await panel.getByRole('button', { name: '关闭翻译面板' }).click();
    await field.fill('中文');
    await field.click({ clickCount: 3, position: { x: 20, y: 12 } });
    await f.page.getByRole('button', { name: '使用 Sayvia 翻译输入选区' }).click();
    await expect(panel.getByLabel('译文', { exact: true })).toHaveValue('English');
  } finally {
    await f.close();
  }
});
test('the exact CHANGELOG commit selection reaches the model while code and the other side stay local', async () => {
  const f = await fixture(commitUrl, commitDiff());
  try {
    await f.page.evaluate(() => {
      const a = document.querySelector('#commit-line-0')!,
        b = document.querySelector('#commit-line-1')!;
      const r = document.createRange();
      r.setStart(a.childNodes[1]!, 1);
      r.setEnd(b, b.childNodes.length);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
    await f.page.keyboard.press('Shift');
    await f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' }).click();
    const panel = f.page.getByRole('dialog', panelName);
    await expect(panel.getByRole('region', { name: '译文预览' })).toContainText('接受');
    expect(f.count()).toBe(1);
    expect(f.requestBodies[0]).not.toMatch(/UNSELECTED_LEFT|\.mjs|new version --format mjs/);
    await expect(panel.getByRole('region', { name: '译文预览' }).locator('code')).toHaveText([
      '.mjs',
      'new version --format mjs',
    ]);
    await f.page.screenshot({ path: test.info().outputPath('commit-changelog-reading.png') });
  } finally {
    await f.close();
  }
});
test('an opaque selection is explicitly not translated and does not masquerade as a result', async () => {
  const f = await fixture(undefined, '<p><code id=code>const n = 1;</code></p>');
  try {
    await f.page.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.querySelector('#code')!);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
    await f.page.keyboard.press('Shift');
    await f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' }).click();
    const panel = f.page.getByRole('dialog', panelName);
    await expect(panel.getByRole('status')).toContainText('未执行翻译');
    await expect(panel.getByRole('button', { name: '复制译文' })).toBeDisabled();
    await expect(panel.getByRole('region', { name: '译文预览' })).not.toContainText('const n');
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
test('disabled, readonly and sensitive controls do not get contextual actions; dynamic controls do', async () => {
  const f = await fixture(
    undefined,
    '<input id=password type=password value=secret><textarea id=readonly readonly>你好</textarea><textarea disabled>你好</textarea><input id=card autocomplete=cc-number value=1234>',
  );
  try {
    for (const id of ['password', 'readonly', 'card']) {
      await f.page.locator('#' + id).click();
      await expect(f.page.getByRole('button', { name: '使用 Sayvia 翻译输入内容' })).toBeHidden();
    }
    await f.page.evaluate(() => {
      const t = document.createElement('textarea');
      t.id = 'dynamic';
      t.value = '你好';
      document.body.append(t);
    });
    await f.page.locator('#dynamic').click();
    await expect(f.page.getByRole('button', { name: '使用 Sayvia 翻译输入内容' })).toBeVisible();
    await f.page.locator('#dynamic').evaluate((e: HTMLTextAreaElement) => {
      e.readOnly = true;
    });
    await expect(f.page.getByRole('button', { name: '使用 Sayvia 翻译输入内容' })).toBeHidden();
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
