import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';
import { commentUrl, commentLines, sourceCommentDiff } from '../fixtures/source-comment';
async function fixture(html: string, url = 'https://selection.example.test/page') {
  const f = await workflowFixture();
  await f.context.route(url, (r) =>
    r.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><style>body{font:16px/1.6 system-ui;margin:45px}td{padding:10px;width:46%}.diff-text-inner,pre{white-space:pre-wrap}.diff-text-marker{user-select:none}</style>${html}`,
    }),
  );
  await f.page.goto(url);
  return f;
}
async function select(f: Awaited<ReturnType<typeof fixture>>, selector: string, end = selector) {
  await f.page.evaluate(
    ({ selector, end }) => {
      const a = document.querySelector(selector)!,
        b = document.querySelector(end)!;
      const r = document.createRange();
      r.setStart(a, 0);
      r.setEnd(b, b.childNodes.length);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    },
    { selector, end },
  );
  await f.page.keyboard.press('Shift');
  await f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' }).click();
  return f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
}
test('the same explicitly selected sentence translates in ordinary prose and code containers', async () => {
  for (const html of [
    '<p id=selected>Read first.</p>',
    '<pre id=selected><code>Read first.</code></pre>',
    '<code id=selected>Read first.</code>',
  ]) {
    const f = await fixture(html);
    try {
      const panel = await select(f, '#selected');
      await expect(panel.getByRole('region', { name: '译文预览' })).toHaveText('阅读 优先。');
      expect(f.count()).toBe(1);
      await expect(f.page.locator('#selected')).toHaveText('Read first.');
    } finally {
      await f.close();
    }
  }
});
test('selected comments in any named source diff reach the model without outside cells or controls', async () => {
  for (const name of ['internal/config/driver.go', 'unknown.custom', 'without-extension']) {
    const f = await fixture(sourceCommentDiff(name), commentUrl);
    try {
      const before = await f.page.locator('table').innerHTML();
      const panel = await select(f, '#comment-0', '#comment-2');
      await expect(panel.getByRole('region', { name: '译文预览' })).toContainText('完整认证流程');
      expect(f.count()).toBe(1);
      expect(f.requestBodies[0]).not.toMatch(/UNSELECTED_OPPOSITE|UNSELECTED_CONTROL/);
      await expect(panel.getByLabel('原文', { exact: true })).toHaveValue(commentLines.join('\n'));
      await expect(panel.getByRole('region', { name: '译文预览' })).toContainText('DriverDSN');
      await expect(panel.getByRole('region', { name: '译文预览' })).toContainText('go-ora');
      await expect(panel.getByRole('region', { name: '译文预览' })).toContainText('v3.0.1');
      expect(await f.page.locator('table').innerHTML()).toBe(before);
      if (name.endsWith('.go'))
        await f.page.screenshot({ path: test.info().outputPath('selected-go-comment.png') });
    } finally {
      await f.close();
    }
  }
});
test('an identical model response is shown as unchanged, rather than a skipped request', async () => {
  const f = await fixture('<pre id=selected><code>const n = 1;</code></pre>');
  try {
    const panel = await select(f, '#selected');
    await expect(panel.getByRole('region', { name: '译文预览' })).toHaveText('const n = 1;');
    await expect(panel.getByRole('status')).toHaveText('结果与原文相同，已原样保留。');
    await expect(panel.getByRole('button', { name: '复制译文' })).toBeEnabled();
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
test('clear inline code and link targets remain separate protected pieces inside prose', async () => {
  const f = await fixture(
    '<p id=selected>Read <code>DriverDSN</code> <a href="https://example.test/PRIVATE_URL">guide</a> first.</p>',
  );
  try {
    const panel = await select(f, '#selected');
    await expect(panel.getByRole('region', { name: '译文预览' })).toContainText('阅读');
    expect(f.requestBodies[0]).not.toMatch(/DriverDSN|PRIVATE_URL/);
    await expect(panel.getByRole('region', { name: '译文预览' }).locator('code')).toHaveText(
      'DriverDSN',
    );
    await expect(panel.getByRole('region', { name: '译文预览' }).getByRole('link')).toHaveAttribute(
      'href',
      'https://example.test/PRIVATE_URL',
    );
  } finally {
    await f.close();
  }
});
