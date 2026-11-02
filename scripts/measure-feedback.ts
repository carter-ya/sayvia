import { workflowFixture } from '../tests/fixtures/core-workflow-extension';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { out: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  process.stdout.write(
    'Usage: pnpm exec tsx scripts/measure-feedback.ts --out NEW_FILE.json\nUses only an isolated self-authored fixture; no real model calls. Build first. Optional SAYVIA_CHROME_PATH chooses Chrome.\n',
  );
  process.exit(0);
}
if (!values.out) throw new Error('OUTPUT_REQUIRED');
const f = await workflowFixture();
const url = 'https://github.com/sayvia-benchmark/repo/issues/1';
try {
  await f.context.route(url, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset="utf-8"><p id="article">Read <code>timeout</code> first.</p><markdown-toolbar for="benchmark-editor"><button type="button">B</button></markdown-toolbar><textarea id="benchmark-editor" name="comment[body]">你好</textarea>',
    }),
  );
  await f.page.goto(url);

  await f.page.bringToFront();
  await f.page
    .getByRole('button', { name: '使用 Sayvia 翻译这份评论', exact: true })
    .waitFor({ state: 'visible' });
  f.delay(500);
  const samples: { mode: string; clickToObservedDialogMs: number }[] = [];
  for (const mode of ['read', 'write'])
    for (let i = 0; i < 5; i++) {
      console.log('BENCHMARK', mode, i);
      if (mode === 'read') {
        await f.page.locator('#article').click({ clickCount: 3 });
      } else {
        await f.page
          .locator('textarea[name="comment[body]"]')
          .evaluate((field: HTMLTextAreaElement) => {
            field.focus();
            field.setSelectionRange(0, 0);
          });
      }
      const button = f.page.getByRole('button', {
        name: mode === 'read' ? '使用 Sayvia 翻译选中文字' : '使用 Sayvia 翻译这份评论',
        exact: true,
      });
      await button.waitFor({ state: 'visible' });
      await button.evaluate((element) => {
        element.addEventListener(
          'click',
          () => {
            document.documentElement.dataset.sayviaFeedbackStarted = String(performance.now());
          },
          { once: true, capture: true },
        );
      });
      await button.click();
      await f.page.getByRole('dialog', { name: 'Sayvia 翻译' }).waitFor({ state: 'visible' });
      const elapsed = await f.page.evaluate(
        () => performance.now() - Number(document.documentElement.dataset.sayviaFeedbackStarted),
      );
      samples.push({ mode, clickToObservedDialogMs: Math.round(elapsed * 10) / 10 });
      await f.page.locator('[role="dialog"][aria-busy="false"]').waitFor({ state: 'visible' });
      await f.page.getByRole('button', { name: '关闭翻译面板', exact: true }).click();
    }
  const data = {
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    browser: f.context.browser()?.version() ?? 'unavailable',
    bundleSha256: createHash('sha256')
      .update(await readFile('.output/chrome-mv3/content-scripts/translator.js'))
      .digest('hex'),
    headless: true,
    isolatedProfile: true,
    measurement:
      'trusted click capture to automation-confirmed visible dialog; includes observation overhead, excludes deliberately delayed 500ms model response',
    samples,
    within200msInThisRun: samples.every((x) => x.clickToObservedDialogMs <= 200),
    modelRequests: f.count(),
    realModelCalls: 0,
    ordinaryDesktopAcceptancePending: true,
  };
  await writeFile(values.out, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(data));
} finally {
  await f.close();
}
