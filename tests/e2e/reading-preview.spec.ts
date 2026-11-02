import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';

async function select(page: Awaited<ReturnType<typeof workflowFixture>>['page'], id: string) {
  await page.evaluate((id) => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById(id)!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, id);
  await page.keyboard.press('Shift');
  await page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' }).click();
  return page.getByRole('dialog', { name: 'Sayvia 翻译' });
}
test('a long PR description has scrollable formatted output with visible copy/edit controls and local links', async () => {
  const f = await workflowFixture();
  try {
    const url = 'https://github.com/exc-works/decimal/pull/8';
    await f.context.route(url, (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><style>body{margin:40px}article{max-width:900px}code{background:#eee}</style><article id=description><p>Read <code>%.3g</code> of <code>999.9</code> first.</p>${'<p>Read <code>0.00009999</code> first. Validation: default tests, BSON race tests and vet passed; scientific formatting and normalization retain their exact boundaries.</p>'.repeat(8)}<p>Stack: <a href="/exc-works/decimal/pull/8">#8</a> → <a href="/exc-works/decimal/pull/9">#9</a> → <a href="/exc-works/decimal/pull/10">#10</a> → <a href="/exc-works/decimal/pull/11">#11</a>.</p><p>Layer 1/4; base: <code>main</code>.<br>Next: <a href="/exc-works/decimal/pull/9">#9</a>.</p></article>`,
      }),
    );
    const page = await f.context.newPage();
    await page.goto(url);
    await expect(page.locator('[data-sayvia-entry]')).toHaveCount(1);
    const original = await page.locator('#description').innerHTML();
    const panel = await select(page, 'description');
    const preview = panel.getByRole('region', { name: '译文预览' });
    await expect(preview).toContainText('阅读');
    await expect(preview.locator('code').first()).toHaveText('%.3g');
    await expect(preview.getByRole('link', { name: '#9', exact: true })).toHaveCount(2);
    await expect(preview.getByRole('link', { name: '#8', exact: true })).toHaveAttribute(
      'href',
      url,
    );
    expect(f.requestBodies[0]).not.toMatch(/github.com|%.3g|999.9|0.00009999/);
    const safeLink = preview.getByRole('link', { name: '#8', exact: true });
    const pageCount = f.context.pages().length;
    await safeLink.evaluate((element) => (element as HTMLAnchorElement).click());
    expect(f.context.pages()).toHaveLength(pageCount);
    await f.context.route('https://unwanted.example.test/redirect', (route) =>
      route.fulfill({ contentType: 'text/html', body: 'Unexpected destination' }),
    );
    await safeLink.evaluate((element) =>
      element.setAttribute('href', 'https://unwanted.example.test/redirect'),
    );
    const opened = f.context.waitForEvent('page');
    await safeLink.click();
    const target = await opened;
    await target.waitForLoadState('domcontentloaded');
    expect(target.url()).toBe(url);
    expect(await target.evaluate(() => window.opener === null)).toBe(true);
    await target.close();
    await panel.locator('.source-details > summary').click();
    expect((await panel.getByLabel('原文', { exact: true }).boundingBox())!.height).toBeGreaterThan(
      75,
    );
    await expect(panel.getByRole('button', { name: '复制译文', exact: true })).toBeInViewport();
    await panel.locator('.source-details > summary').click();
    const box = await panel.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    expect(await preview.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expect(panel.getByRole('button', { name: '复制译文', exact: true })).toBeInViewport();
    await expect(panel.getByRole('button', { name: '编辑译文', exact: true })).toBeInViewport();
    await panel.getByRole('button', { name: '编辑译文', exact: true }).click();
    const field = panel.getByLabel('译文', { exact: true });
    await expect(field).toHaveValue(/`%.3g`/);
    await expect(field).toHaveValue(
      /\[#8\]\(<https:\/\/github.com\/exc-works\/decimal\/pull\/8>\)/,
    );
    expect((await field.boundingBox())!.height).toBeGreaterThan(150);
    await field.fill('Reviewed `%.3g` and [#8](https://github.com/exc-works/decimal/pull/8).');
    await panel.getByRole('button', { name: '完成编辑', exact: true }).click();
    await expect(preview.locator('code')).toHaveText('%.3g');
    await expect(preview.getByRole('link', { name: '#8', exact: true })).toHaveAttribute(
      'href',
      url,
    );
    await panel.getByRole('button', { name: '复制译文', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('已复制。');
    await page.evaluate(() => {
      const field = document.createElement('textarea');
      field.id = 'copy-target';
      document.body.append(field);
    });
    await page.locator('#copy-target').focus();
    await page.keyboard.press('ControlOrMeta+V');
    await expect(page.locator('#copy-target')).toHaveValue(
      'Reviewed `%.3g` and [#8](https://github.com/exc-works/decimal/pull/8).',
    );
    expect(await page.locator('#description').innerHTML()).toBe(original);
    expect(f.count()).toBe(1);
    await page.setViewportSize({ width: 375, height: 720 });
    await expect
      .poll(async () => {
        const b = (await panel.boundingBox())!;
        return b.x >= 0 && b.x + b.width <= 375 && b.y >= 0 && b.y + b.height <= 720;
      })
      .toBe(true);
  } finally {
    await f.close();
  }
});

test('edited HTML, remote images and unsafe links remain inert in a reading preview', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'reading';
      p.textContent = 'Read first.';
      document.body.prepend(p);
    });
    const panel = await select(f.page, 'reading');
    await expect(panel.getByRole('region', { name: '译文预览' })).toContainText('阅读');
    await panel.getByRole('button', { name: '编辑译文', exact: true }).click();
    await panel
      .getByLabel('译文', { exact: true })
      .fill(
        '[bad](javascript:alert(1)) ![remote](https://unrequested.example.test/image.png) <img src=x onerror=alert(1)>',
      );
    await panel.getByRole('button', { name: '完成编辑', exact: true }).click();
    const preview = panel.getByRole('region', { name: '译文预览' });
    await expect(preview.locator('a,img,script')).toHaveCount(0);
    await expect(preview).toContainText('bad');
    await expect(preview).toContainText('remote');
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

test('indented preformatted prose translates and keeps entity-like link destinations unchanged', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      const pre = document.createElement('pre');
      pre.id = 'note';
      pre.innerHTML = '    Read <a href="https://example.test/?x=&amp;copy;">guide</a> first.';
      document.body.prepend(pre);
    });
    const panel = await select(f.page, 'note');
    const preview = panel.getByRole('region', { name: '译文预览' });
    await expect(preview).toContainText('阅读');
    await expect(preview.locator('code,pre')).toHaveCount(0);
    await expect(preview.getByRole('link')).toHaveAttribute(
      'href',
      'https://example.test/?x=&copy;',
    );
    expect((await preview.innerText()).startsWith('    ')).toBe(true);
    expect(f.count()).toBe(1);
    expect(f.requestBodies[0]).not.toContain('example.test');
  } finally {
    await f.close();
  }
});
