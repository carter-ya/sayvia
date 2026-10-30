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
