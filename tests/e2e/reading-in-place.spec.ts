import { expect, test } from '@playwright/test';
import { workflowFixture } from '../fixtures/core-workflow-extension';

async function select(f: Awaited<ReturnType<typeof workflowFixture>>, id: string) {
  await f.page.evaluate((id) => {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById(id)!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  }, id);
  await f.page.keyboard.press('Shift');
  await f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' }).click();
  return f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
}

test('reading applies locally, preserves native elements, toggles freely and keeps a small tail toolbar', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      const root = document.createElement('article');
      root.id = 'reading';
      root.innerHTML =
        '<p>Read <a href="https://example.test/guide">guide</a> first.</p><p>Read <code>CONST</code> first.</p>';
      document.body.prepend(root);
      const link = root.querySelector('a')!,
        code = root.querySelector('code')!;
      Object.assign(window, { readingLink: link, readingCode: code, readingClicks: 0 });
      link.addEventListener('click', (event) => {
        event.preventDefault();
        Object.assign(window, { readingClicks: 1 });
      });
    });
    const original = await f.page.locator('#reading').textContent();
    const panel = await select(f, 'reading');
    await expect(panel.getByRole('button', { name: '在网页中显示', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: '在网页中显示', exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(f.page.locator('#reading')).toContainText('阅读');
    await expect(f.page.locator('#reading code')).toHaveText('CONST');
    expect(
      await f.page
        .locator('#reading a')
        .evaluate(
          (element) => element === (window as unknown as { readingLink: Element }).readingLink,
        ),
    ).toBe(true);
    expect(
      await f.page
        .locator('#reading code')
        .evaluate(
          (element) => element === (window as unknown as { readingCode: Element }).readingCode,
        ),
    ).toBe(true);
    await f.page.locator('#reading a').click();
    expect(
      await f.page.evaluate(() => (window as unknown as { readingClicks: number }).readingClicks),
    ).toBe(1);
    const entry = f.page.getByRole('button', { name: 'Sayvia 翻译操作', exact: true });
    await expect(entry).toContainText('译文');
    await entry.click();
    const toolbar = f.page.getByRole('toolbar', { name: '译文快捷操作' });
    await expect(toolbar).toBeVisible();
    expect((await toolbar.boundingBox())!.height).toBeLessThan(40);
    expect((await toolbar.boundingBox())!.width).toBeLessThan(240);
    await toolbar.screenshot({ path: test.info().outputPath('reading-inline-toolbar.png') });
    const originalButton = toolbar.getByRole('button', { name: '显示原文', exact: true });
    await originalButton.evaluate((element) => (element as HTMLButtonElement).click());
    await expect(entry).toContainText('译文');
    for (let index = 0; index < 3; index++) {
      await originalButton.click();
      expect(await f.page.locator('#reading').textContent()).toBe(original);
      await toolbar.getByRole('button', { name: '显示译文', exact: true }).click();
      await expect(f.page.locator('#reading')).toContainText('阅读');
    }
    await toolbar.getByRole('button', { name: '复制译文', exact: true }).click();
    await expect(toolbar.locator('..').getByRole('status')).toContainText('已复制');
    await toolbar.getByRole('button', { name: '查看译文', exact: true }).click();
    await expect(panel.getByRole('region', { name: '译文预览' })).toContainText('阅读');
    await panel.getByRole('button', { name: '关闭翻译面板' }).click();
    await expect(entry).toBeVisible();
    expect(f.count()).toBe(1);
    await f.page.setViewportSize({ width: 320, height: 600 });
    await entry.click();
    await expect(toolbar).toBeInViewport();
    await f.page.keyboard.press('Escape');
    await expect(toolbar).toBeHidden();
  } finally {
    await f.close();
  }
});

test('existing results reopen without a request and explicit retranslations use the original source', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'reading';
      p.textContent = 'Read first.';
      document.body.prepend(p);
    });
    const panel = await select(f, 'reading');
    await expect(panel.getByRole('button', { name: '在网页中显示' })).toBeEnabled();
    await panel.getByRole('button', { name: '在网页中显示' }).click();
    const reopened = await select(f, 'reading');
    await expect(reopened.getByRole('region', { name: '译文预览' })).toContainText('阅读');
    expect(f.count()).toBe(1);
    await reopened.getByRole('button', { name: '翻译', exact: true }).click();
    await expect.poll(f.count).toBe(2);
    expect(f.requestBodies[1]).toContain('Read first.');
    expect(f.requestBodies[1]).not.toContain('阅读');
    await expect(reopened.getByRole('button', { name: '在网页中显示' })).toBeEnabled();
    await reopened.getByRole('button', { name: '在网页中显示' }).click();
    await expect(f.page.locator('[data-sayvia-reading]')).toHaveCount(1);
  } finally {
    await f.close();
  }
});

test('tail controls share UX09 appearance and access revocation safely restores their original text', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'reading';
      p.textContent = 'Read first.';
      document.body.prepend(p);
    });
    const panel = await select(f, 'reading');
    await expect(panel.getByRole('button', { name: '在网页中显示' })).toBeEnabled();
    await panel.getByRole('button', { name: '在网页中显示' }).click();
    await f.page.getByRole('button', { name: 'Sayvia 翻译操作' }).click();
    const toolbar = f.page.getByRole('toolbar', { name: '译文快捷操作' });
    await f.settings.getByRole('button', { name: '更多设置', exact: true }).click();
    await f.settings.getByLabel('界面配色').selectOption('pearl');
    await f.settings.getByLabel('界面主题').selectOption('dark');
    await f.settings.getByLabel('浮窗材质').selectOption('glass');
    await f.settings.getByRole('button', { name: '保存偏好', exact: true }).click();
    await expect(f.settings.getByRole('status')).toHaveText('已保存偏好。');
    await expect(f.page.locator('[data-sayvia-reading]')).toHaveAttribute('data-palette', 'pearl');
    await expect(f.page.locator('[data-popover]')).toHaveAttribute('data-material', 'glass');
    await expect
      .poll(() => f.page.locator('[data-popover]').evaluate((element) => element.style.colorScheme))
      .toBe('dark');
    expect(
      await toolbar
        .getByRole('button', { name: '显示原文' })
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe('rgba(0, 0, 0, 0)');
    await f.blockSite(new URL(f.page.url()).origin);
    await expect(f.page.locator('[data-sayvia-reading]')).toHaveCount(0);
    await expect(f.page.locator('#reading')).toHaveText('Read first.');
    await expect(toolbar).toBeHidden();
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

test('a partial text selection keeps unselected text and multiple translations remain independent', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      const root = document.createElement('article');
      root.innerHTML =
        '<p id=partial>Before Read first. After</p><p id=second>Read another first.</p>';
      document.body.prepend(root);
      const range = document.createRange(),
        node = document.getElementById('partial')!.firstChild!;
      range.setStart(node, 7);
      range.setEnd(node, 18);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await f.page.keyboard.press('Shift');
    await f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字' }).click();
    const panel = f.page.getByRole('dialog', { name: 'Sayvia 翻译' });
    await expect(panel.getByRole('button', { name: '在网页中显示' })).toBeEnabled();
    await panel.getByRole('button', { name: '在网页中显示' }).click();
    await expect
      .poll(() => f.page.locator('#partial').textContent())
      .toMatch(/^Before 阅读.* After$/);
    const second = await select(f, 'second');
    await expect(second.getByRole('button', { name: '在网页中显示' })).toBeEnabled();
    await second.getByRole('button', { name: '在网页中显示' }).click();
    await expect(f.page.locator('[data-sayvia-reading]')).toHaveCount(2);
    await f.page.locator('#partial').getByRole('button', { name: 'Sayvia 翻译操作' }).click();
    await f.page.getByRole('button', { name: '显示原文', exact: true }).click();
    await expect
      .poll(() => f.page.locator('#partial').textContent())
      .toBe('Before Read first. After');
    await expect(f.page.locator('#second')).toContainText('阅读');
    expect(f.count()).toBe(2);
  } finally {
    await f.close();
  }
});

test('site updates during translation or after application never get overwritten by an old snapshot', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'reading';
      p.textContent = 'Read first.';
      document.body.prepend(p);
    });
    const release = f.hold();
    const panel = await select(f, 'reading');
    await expect.poll(f.count).toBe(1);
    await f.page.evaluate(() => {
      const node = document.getElementById('reading')!.firstChild!;
      node.nodeValue = 'Changed';
      node.nodeValue = 'Read first.';
    });
    release();
    await expect(panel.getByRole('region', { name: '译文预览' })).toContainText('阅读');
    await expect(panel.getByRole('button', { name: '在网页中显示' })).toBeDisabled();
    await panel.getByRole('button', { name: '关闭翻译面板' }).click();
    const second = await select(f, 'reading');
    await expect(second.getByRole('button', { name: '在网页中显示' })).toBeEnabled();
    await second.getByRole('button', { name: '在网页中显示' }).click();
    await f.page.evaluate(() => {
      document.getElementById('reading')!.firstChild!.nodeValue = 'Newest website content';
    });
    await expect(f.page.locator('[data-sayvia-reading]')).toHaveCount(0);
    await expect(f.page.locator('#reading')).toHaveText('Newest website content');
  } finally {
    await f.close();
  }
});

test('ambiguous rich formatting stays in preview and unsafe edited output cannot be applied', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      const root = document.createElement('article');
      root.innerHTML =
        '<p id=complex>Read <strong>important</strong> first.</p><p id=simple>Read first.</p>';
      document.body.prepend(root);
    });
    const complex = await select(f, 'complex');
    await expect(complex.getByRole('region', { name: '译文预览' })).toContainText('阅读');
    await expect(complex.getByRole('button', { name: '在网页中显示' })).toBeDisabled();
    await complex.getByRole('button', { name: '关闭翻译面板' }).click();
    const simple = await select(f, 'simple');
    await expect(simple.getByRole('button', { name: '在网页中显示' })).toBeEnabled();
    await simple.getByRole('button', { name: '编辑译文' }).click();
    await simple.getByLabel('译文', { exact: true }).fill('<img src=x onerror=alert(1)>');
    await expect(simple.getByRole('button', { name: '在网页中显示' })).toBeDisabled();
    await expect(f.page.locator('#simple')).toHaveText('Read first.');
    await expect(f.page.locator('#simple img')).toHaveCount(0);
  } finally {
    await f.close();
  }
});

test('an invalid reading snapshot reports recovery guidance before spending another request', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'reading';
      p.textContent = 'Read first.';
      document.body.prepend(p);
      const range = document.createRange();
      range.selectNodeContents(p);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    const panel = await f.open('read');
    await expect(panel.getByRole('button', { name: '翻译', exact: true })).toBeEnabled();
    await f.page.evaluate(() => document.body.classList.add('theme-changed'));
    for (let index = 0; index < 2; index++) {
      await panel.getByRole('button', { name: '翻译', exact: true }).click();
      await expect(panel.getByRole('status')).toHaveText('选区已变化，请重新选择原文。');
    }
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});

test('tail controls for linked code do not invoke the original link', async () => {
  const f = await workflowFixture();
  try {
    await f.page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'reading';
      p.innerHTML = 'Read <a href="https://example.test/guide"><code>CONST</code></a>';
      document.body.prepend(p);
      Object.assign(window, { readingLinkClicks: 0 });
      p.querySelector('a')!.addEventListener('click', (event) => {
        event.preventDefault();
        const state = window as unknown as { readingLinkClicks: number };
        state.readingLinkClicks += 1;
      });
    });
    const panel = await select(f, 'reading');
    await expect(panel.getByRole('button', { name: '在网页中显示' })).toBeEnabled();
    await panel.getByRole('button', { name: '在网页中显示' }).click();
    await f.page.getByRole('button', { name: 'Sayvia 翻译操作' }).click();
    await expect(f.page.getByRole('toolbar', { name: '译文快捷操作' })).toBeVisible();
    expect(
      await f.page.evaluate(
        () => (window as unknown as { readingLinkClicks: number }).readingLinkClicks,
      ),
    ).toBe(0);
    expect(
      await f.page.locator('[data-sayvia-reading]').evaluate((element) => element.closest('a')),
    ).toBeNull();
  } finally {
    await f.close();
  }
});
