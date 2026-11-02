import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';

const url = 'https://github.com/exc-works/decimal/pull/10/changes';
async function fixture() {
  const f = await workflowFixture();
  await f.context.route(url, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><style>body{margin:80px;font:18px monospace}td{padding:8px;width:50px}td:has(code){width:400px}.diff-text-inner{white-space:pre-wrap}.diff-text-marker{user-select:none}</style><table role="grid" data-diff-anchor="diff-fixture" aria-label="Diff for: README.md"><tbody>${['Read first.', 'Read <span class="pl-s">`</span><span class="pl-c1">timeout</span><span class="pl-s">`</span> first.', 'Read first.'].map((line, i) => `<tr><td data-diff-side="left" data-line-number="${164 + i}">${164 + i}</td><td data-diff-side="left" data-line-number="${164 + i}"><code class="diff-text"><div class="diff-text-inner">UNSELECTED_LEFT_PRIVATE</div></code></td><td data-diff-side="right" data-line-number="${164 + i}">${164 + i}</td><td data-diff-side="right" data-line-number="${164 + i}"><code class="diff-text syntax-highlighted-line addition"><span class="diff-text-marker">+</span><div id="line-${i}" class="diff-text-inner">${line}</div></code><button hidden>UNSELECTED_CONTROL_PRIVATE</button></td></tr>`).join('')}</tbody></table>`,
    }),
  );
  const page = await f.context.newPage();
  await page.goto(url);
  await expect(page.locator('[data-sayvia-entry]')).toHaveCount(1);
  return { ...f, page };
}
test('a genuine mouse selection of GitHub source-diff prose translates near the release point', async () => {
  const f = await fixture();
  try {
    const line = f.page.locator('#line-0');
    const box = (await line.boundingBox())!;
    await f.page.mouse.move(box.x + 1, box.y + box.height / 2);
    await f.page.mouse.down();
    await f.page.mouse.move(box.x + 119, box.y + box.height / 2, { steps: 12 });
    await f.page.mouse.up();
    expect(await f.page.evaluate(() => window.getSelection()?.toString())).toContain('Read first.');
    await f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' }).click();
    const preview = f.page.getByRole('region', { name: '译文预览' });
    await expect(preview).toHaveText('阅读 优先。');
    expect(f.count()).toBe(1);
    expect(f.requestBodies[0]).not.toMatch(/PRIVATE|164/);
    await expect(line).toHaveText('Read first.');
  } finally {
    await f.close();
  }
});
test('a multi-line diff range excludes the opposite side and retains inline code in the preview', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      const r = document.createRange();
      r.setStart(document.querySelector('#line-1')!, 0);
      r.setEnd(document.querySelector('#line-2')!, 1);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
    await f.page.keyboard.press('Shift');
    await f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' }).click();
    const preview = f.page.getByRole('region', { name: '译文预览' });
    await expect(preview.locator('code')).toHaveText('timeout');
    await expect(preview).toContainText('阅读');
    expect(f.count()).toBe(1);
    expect(f.requestBodies[0]).not.toMatch(/timeout|PRIVATE|165|166/);
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await panel.locator('.source-details > summary').click();
    await expect(panel.getByLabel('原文', { exact: true })).toHaveValue(
      'Read `timeout` first.\nRead first.',
    );
  } finally {
    await f.close();
  }
});

test('closing-fence README prose renders as paragraphs and has a visible editing field', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      const tbody = document.querySelector('tbody')!;
      tbody.innerHTML = [
        '```',
        '',
        '<span class="pl-s">`</span><span class="pl-c1">NullDecimal</span><span class="pl-s">`</span> Read first.',
        'Read first.',
      ]
        .map(
          (line, i) =>
            `<tr><td data-diff-side="right" data-line-number="${450 + i}"><code class="diff-text"><div id="line-${i}" class="diff-text-inner">${line || '<br>'}</div></code></td></tr>`,
        )
        .join('');
      const r = document.createRange();
      r.setStart(document.querySelector('#line-2')!, 0);
      r.setEnd(document.querySelector('#line-3')!, 1);
      const s = window.getSelection()!;
      s.removeAllRanges();
      s.addRange(r);
    });
    await f.page.keyboard.press('Shift');
    await f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' }).click();
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' }),
      preview = panel.getByRole('region', { name: '译文预览' });
    await expect(preview).toContainText('阅读');
    await expect(preview.locator('pre')).toHaveCount(0);
    await expect(preview.locator('code')).toHaveText('NullDecimal');
    expect(await preview.innerText()).not.toContain('\n阅读');
    await panel.getByRole('button', { name: '编辑译文', exact: true }).click();
    const field = panel.getByLabel('译文', { exact: true });
    for (const scheme of ['light', 'dark'] as const) {
      await f.page.emulateMedia({ colorScheme: scheme });
      const style = await field.evaluate((el) => ({
        border: getComputedStyle(el).borderWidth,
        padding: getComputedStyle(el).padding,
        background: getComputedStyle(el).backgroundColor,
      }));
      expect(style.border).toBe('1px');
      expect(style.padding).toBe('10px 12px');
      expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
    }
  } finally {
    await f.close();
  }
});
