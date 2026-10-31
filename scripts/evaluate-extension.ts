import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect } from '@playwright/test';
import { workflowFixture } from '../tests/fixtures/core-workflow-extension';
import { ALGORITHM_VERSION } from '../src/providers/chat-completions';

const providers = [
  {
    id: 'openai',
    model: 'gpt-6-luna',
    baseUrl: 'https://api.openai.com/v1',
    key: process.env.OPENAI_API_KEY,
  },
  {
    id: 'deepseek',
    model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
    key: process.env.DEEPSEEK_API_KEY,
  },
] as const;
const secrets = providers
  .map((provider) => provider.key)
  .filter((key): key is string => Boolean(key));
function redact(text: string) {
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text;
}
function safeWrite(path: string, value: unknown) {
  const encoded = JSON.stringify(value);
  if (secrets.some((secret) => encoded.includes(secret))) throw new Error('CREDENTIAL_IN_REPORT');
  appendFileSync(path, encoded + '\n', { mode: 0o600 });
}
async function main() {
  if (process.env.DEBUG || process.env.PWDEBUG)
    throw new Error('DISABLE_DEBUG_LOGGING_FOR_SECRET_VALIDATION');
  if (providers.some((provider) => !provider.key))
    throw new Error('OPENAI_API_KEY_AND_DEEPSEEK_API_KEY_REQUIRED');
  const outputIndex = process.argv.indexOf('--output');
  const outputArg = outputIndex < 0 ? undefined : process.argv[outputIndex + 1];
  if (!outputArg) throw new Error('OUTPUT_PATH_REQUIRED');
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
    throw new Error('COMMIT_VALIDATED_SOURCE_FIRST');
  const output = resolve(outputArg);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, '', { flag: 'wx', mode: 0o600 });
  safeWrite(output, {
    type: 'metadata',
    version: 1,
    startedAt: new Date().toISOString(),
    codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    algorithmVersion: ALGORITHM_VERSION,
    scenariosPerProvider: 3,
    noAutomaticRetry: true,
    manualReviewPending: true,
    realGitHubSubmissionPending: true,
    m1Passed: false,
  });
  const fixture = await workflowFixture();
  let failed = false;
  try {
    await fixture.context.route('https://github.com/carter-ya/sayvia/issues/987654321', (route) =>
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><html><body><textarea id="new_comment_field" name="comment[body]"></textarea></body></html>',
      }),
    );
    safeWrite(output, {
      type: 'browser',
      version: fixture.context.browser()?.version(),
      websiteValidation: 'public self-authored fixture, not a real GitHub submission',
    });
    for (const provider of providers) {
      await fixture.settings.getByLabel('服务商').selectOption(provider.id);
      await fixture.settings.getByLabel('API Base URL').fill(provider.baseUrl);
      await fixture.settings.getByLabel('模型名称').fill(provider.model);
      await fixture.settings.getByLabel('API Key', { exact: true }).fill(provider.key!);
      await fixture.settings.getByRole('button', { name: '保存配置' }).click();
      await expect(fixture.settings.getByRole('status')).toHaveText('已保存配置。');
      for (const kind of ['plain-text', 'markdown', 'dom-selection'] as const) {
        const source =
          kind === 'plain-text'
            ? '这项修改不会自动提交评论。'
            : kind === 'markdown'
              ? '请先备份 `config.json`，然后查看[说明](https://example.test/docs)。'
              : 'Read timeout before retrying.';
        const target = kind === 'markdown' ? await fixture.context.newPage() : fixture.page;
        let panel: Awaited<ReturnType<typeof fixture.open>> | undefined;
        let startedAt = 0;
        try {
          if (kind === 'markdown')
            await target.goto('https://github.com/carter-ya/sayvia/issues/987654321');
          if (kind === 'dom-selection') {
            await target.evaluate(() => {
              let element = document.getElementById('real-reading');
              if (!element) {
                element = document.createElement('p');
                element.id = 'real-reading';
                document.body.append(element);
              }
              element.innerHTML = 'Read <code>timeout</code> before retrying.';
            });
            await target.locator('#real-reading').click();
            await target.evaluate(() => {
              const range = document.createRange();
              range.selectNodeContents(document.getElementById('real-reading')!);
              const selection = window.getSelection()!;
              selection.removeAllRanges();
              selection.addRange(range);
            });
            panel = await fixture.open('read', target);
          } else {
            const editor = target.locator(kind === 'markdown' ? '#new_comment_field' : '#editor');
            await editor.fill(source);
            await editor.focus();
            await editor.evaluate((element) =>
              (element as HTMLTextAreaElement).setSelectionRange(0, 0),
            );
            panel = await fixture.open('write', target);
          }
          await expect(panel.getByLabel('原文', { exact: true })).toHaveValue(source);
          startedAt = Date.now();
          await panel.getByRole('button', { name: '翻译', exact: true }).click();
          await expect(panel.getByLabel('译文', { exact: true })).not.toHaveValue('', {
            timeout: 65_000,
          });
          const translatedText = await panel.getByLabel('译文', { exact: true }).inputValue();
          const durationMs = Date.now() - startedAt;
          if (secrets.some((secret) => translatedText.includes(secret)))
            throw new Error('CREDENTIAL_IN_RESULT');
          if (
            kind === 'markdown' &&
            (!translatedText.includes('`config.json`') ||
              !translatedText.includes('(https://example.test/docs)'))
          )
            throw new Error('PROTECTED_MARKDOWN_CHANGED');
          if (kind === 'dom-selection' && !translatedText.includes('timeout'))
            throw new Error('PROTECTED_DOM_CODE_CHANGED');
          let replacementAndRestore: boolean | null = null;
          if (kind !== 'dom-selection') {
            const editor = target.locator(kind === 'markdown' ? '#new_comment_field' : '#editor');
            await panel.getByRole('button', { name: '替换全文', exact: true }).click();
            await expect(panel.getByRole('status')).toHaveText('已替换，可恢复原文。');
            await expect(editor).toHaveValue(translatedText);
            await panel.getByRole('button', { name: '恢复原文', exact: true }).click();
            await expect(panel.getByRole('status')).toHaveText('已恢复原文。');
            await expect(editor).toHaveValue(source);
            replacementAndRestore = true;
          } else {
            await expect(target.locator('#real-reading')).toHaveText(source);
            await expect(panel.getByRole('button', { name: /替换/ })).toHaveCount(0);
          }
          safeWrite(output, {
            type: 'sample',
            provider: provider.id,
            model: provider.model,
            sourceKind: kind,
            source,
            translatedText,
            durationMs,
            passed: true,
            formatAndProtectionPassed: true,
            replacementAndRestore,
            manualReviewPending: true,
          });
          console.log(`${provider.id}/${kind}: passed (${durationMs} ms)`);
        } catch {
          failed = true;
          const status = panel
            ? await panel
                .getByRole('status')
                .textContent()
                .catch(() => null)
            : null;
          safeWrite(output, {
            type: 'sample',
            provider: provider.id,
            model: provider.model,
            sourceKind: kind,
            source,
            durationMs: startedAt ? Date.now() - startedAt : 0,
            passed: false,
            error: 'UI_VALIDATION_FAILED',
            status: status ? redact(status) : null,
          });
          console.log(`${provider.id}/${kind}: failed; no retry`);
        } finally {
          if (target !== fixture.page) await target.close();
        }
      }
    }
    safeWrite(output, {
      type: 'summary',
      sampleCount: 6,
      passed: !failed,
      manualReviewPending: true,
      realGitHubSubmissionPending: true,
      m1Passed: false,
    });
    if (failed) process.exitCode = 1;
  } finally {
    await fixture.close();
  }
}
void main().catch((error) => {
  console.error(redact(error instanceof Error ? error.message : 'EXTENSION_EVALUATION_FAILED'));
  process.exitCode = 1;
});
