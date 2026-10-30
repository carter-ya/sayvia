import { expect, test } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { resolve } from 'node:path';
import type {} from '../fixtures/selection-harness';

let server: ViteDevServer;
let fixtureUrl: string;
test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    root: resolve('.'),
    appType: 'mpa',
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server unavailable');
  fixtureUrl = `http://127.0.0.1:${address.port}/tests/fixtures/selection.html`;
});
test.afterAll(async () => {
  await server?.close();
});
test.beforeEach(async ({ page }) => {
  await page.goto(fixtureUrl);
  await expect(page.locator('#code')).toBeVisible();
  await page.waitForFunction(() => Boolean(window.selectionHarness));
});

test('partially selected rendered code retains its identity after selection collapse', async ({
  page,
}) => {
  const source = await page.evaluate(() => window.selectionHarness.partialCode());
  expect(source).toEqual({
    kind: 'dom-selection',
    text: 'meo',
    protectedRanges: [{ kind: 'inline-code', start: 0, end: 3 }],
    marks: [],
  });
  await page.locator('#focus').click();
  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  expect(await page.evaluate(() => window.selectionHarness.read())).toEqual(source);
});

test('cross-link selection keeps visible labels without collecting hidden attributes or changing DOM', async ({
  page,
}) => {
  const before = await page.locator('#reading').innerHTML();
  const source = await page.evaluate(() => window.selectionHarness.crossLink());
  expect(source.text).toBe('Read timeout using the');
  expect(source.protectedRanges).toEqual([{ kind: 'inline-code', start: 5, end: 12 }]);
  expect(source.marks).toContainEqual({ kind: 'link-label', start: 19, end: 22 });
  expect(JSON.stringify(source)).not.toContain('HIDDEN_DESTINATION');
  expect(await page.locator('#reading').innerHTML()).toBe(before);
});

test('whole selection preserves code whitespace and omits hidden or form text', async ({
  page,
}) => {
  const source = await page.evaluate(() => window.selectionHarness.element('reading'));
  expect(source.text).toBe(
    'Read timeout using the documentation now.\nconst limit = 1;\n  run(limit);\nvisible end',
  );
  expect(JSON.stringify(source)).not.toMatch(/HIDDEN_|FORM_SECRET/);
  const block = source.protectedRanges.find((span) => span.kind === 'code-block')!;
  expect(source.text.slice(block.start, block.end)).toBe('const limit = 1;\n  run(limit);');
});

test('the same text cannot revive a snapshot after its code semantics change', async ({ page }) => {
  await page.evaluate(() => {
    window.selectionHarness.element('intro');
    const code = document.getElementById('code')!;
    code.replaceWith(document.createTextNode(code.textContent!));
  });
  await expect(page.evaluate(() => window.selectionHarness.read())).rejects.toThrow(
    'SELECTION_LOST',
  );
});

test('a selection across a closed disclosure omits concealed content', async ({ page }) => {
  const source = await page.evaluate(() => {
    const root = document.createElement('section');
    root.id = 'disclosure-case';
    root.innerHTML =
      '<p>Before</p><details><summary>Visible <code>name</code></summary>DIRECT_SECRET<p>BODY_SECRET</p><summary>EXTRA_SECRET</summary></details><p>After</p>';
    document.body.append(root);
    return window.selectionHarness.element(root.id);
  });
  expect(source.text).toBe('Before\nVisible name\nAfter');
  expect(JSON.stringify(source)).not.toContain('SECRET');
  const expanded = await page.evaluate(() => {
    document.querySelector<HTMLDetailsElement>('#disclosure-case details')!.open = true;
    return window.selectionHarness.element('disclosure-case');
  });
  expect(expanded.text).toContain('BODY_SECRET');
});

test('native definition lists and CSS display overrides retain rendered text boundaries', async ({
  page,
}) => {
  const sources = await page.evaluate(() => {
    const result = [];
    for (const html of [
      '<dl><dt>Term</dt><dd>Definition</dd></dl>',
      '<span style="display:block">First</span><span style="display:block">Second</span>',
      '<div style="display:inline">First</div><div style="display:inline">Second</div>',
    ]) {
      const root = document.createElement('section');
      root.id = 'layout-case';
      root.innerHTML = html;
      document.body.append(root);
      result.push(window.selectionHarness.element(root.id).text);
      root.remove();
    }
    return result;
  });
  expect(sources).toEqual(['Term\nDefinition', 'First\nSecond', 'FirstSecond']);
});

test('content visibility stays private and Unicode spacing retains exact code offsets', async ({
  page,
}) => {
  const source = await page.evaluate(() => {
    const root = document.createElement('section');
    root.id = 'visibility-spacing';
    root.innerHTML =
      '<p>Before</p><div style="content-visibility:hidden">CONCEALED</div><p><span>Hello</span>&nbsp;&nbsp;<code>timeout</code></p><p>中文<span>　</span>正文</p>';
    document.body.append(root);
    return window.selectionHarness.element(root.id);
  });
  expect(source.text).toBe('Before\nHello\u00a0\u00a0timeout\n中文\u3000正文');
  expect(source.protectedRanges).toEqual([{ kind: 'inline-code', start: 14, end: 21 }]);
  expect(JSON.stringify(source)).not.toContain('CONCEALED');
});

test('a shadow host inside a document selection cannot expose unrendered light DOM', async ({
  page,
}) => {
  await expect(
    page.evaluate(() => {
      const root = document.createElement('section');
      root.id = 'shadow-selection';
      root.innerHTML = '<p>Before</p><div>UNRENDERED_SECRET</div><p>After</p>';
      root.querySelector('div')!.attachShadow({ mode: 'open' }).textContent =
        'visible shadow content';
      document.body.append(root);
      return window.selectionHarness.element(root.id);
    }),
  ).rejects.toThrow('UNSUPPORTED_SELECTION');
});

test('inherited pre-line collapses cross-node spaces and spaces around preserved newlines', async ({
  page,
}) => {
  const source = await page.evaluate(() => {
    const root = document.createElement('p');
    root.id = 'pre-line-selection';
    root.style.whiteSpace = 'pre-line';
    root.innerHTML = 'Hello <b> world \n </b><i> next</i>';
    document.body.append(root);
    return window.selectionHarness.element(root.id);
  });
  expect(source.text).toBe('Hello world\nnext');
});

test('an explicit break at the next block preserves the blank line and code offset', async ({
  page,
}) => {
  const source = await page.evaluate(() => {
    const root = document.createElement('section');
    root.id = 'explicit-break-selection';
    root.innerHTML = '<div>Before</div><div><br><code>After</code></div>';
    document.body.append(root);
    return window.selectionHarness.element(root.id);
  });
  expect(source.text).toBe('Before\n\nAfter');
  expect(source.protectedRanges).toEqual([{ kind: 'inline-code', start: 8, end: 13 }]);
  expect(source.marks.filter((mark) => mark.kind === 'line-break')).toHaveLength(2);
});
