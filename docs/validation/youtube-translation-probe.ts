// Bounded real-model timing probe: six calls, self-authored English caption fixtures.
// Run with pnpm exec tsx docs/validation/youtube-translation-probe.ts NEW_OUTPUT.json
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { translate, ProviderError, ALGORITHM_VERSION } from '../../src/providers/chat-completions';

const lines = [
  'Today we will build a small application together.',
  'First, decide which problem you want to solve.',
  'Write down the simplest version of your idea.',
  'You do not need every feature immediately.',
  'Start with one screen and one useful action.',
  'Make the first version easy for someone to understand.',
  'Then ask a friend to try it without instructions.',
  'Watch where they hesitate and listen to their questions.',
  'Their confusion can reveal a problem in your design.',
  'Do not assume that adding more buttons will help.',
  'Sometimes removing a step makes the biggest difference.',
  'Save your changes before trying a different approach.',
  'A small experiment should be easy to undo.',
  'When the connection fails, explain what happened clearly.',
  'Keep the text that the person has already entered.',
  'Let them choose when they want to try again.',
  'Test the result on a slower device as well.',
  'Measure the waiting time instead of guessing about it.',
  'Finally, describe what works and what remains unfinished.',
  'Useful software grows through careful observation and small improvements.',
];

async function main() {
  if (process.env.DEBUG || process.env.PWDEBUG) throw new Error('DEBUG_NOT_ALLOWED');
  const output = process.argv[2];
  if (!output) throw new Error('NEW_OUTPUT_REQUIRED');
  const env = parseEnv(await readFile('.env.local', 'utf8'));
  const providers = [
    {
      name: 'openai',
      model: 'gpt-6-luna',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: env.OPENAI_API_KEY,
    },
    {
      name: 'deepseek',
      model: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com',
      apiKey: env.DEEPSEEK_API_KEY,
    },
  ];
  if (providers.some((p) => !p.apiKey)) throw new Error('KEY_REQUIRED');
  const secrets = providers.map((p) => p.apiKey);
  const results: Record<string, unknown>[] = [];
  const metadata = {
    date: '2026-11-03',
    startedAt: new Date().toISOString(),
    sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    algorithmVersion: ALGORITHM_VERSION,
    corpus: 'self-authored-caption-timing-v1',
    fixtureLines: lines,
    corpusSha256: createHash('sha256').update(JSON.stringify(lines)).digest('hex'),
    realYouTubeCaptions: false,
    productionExtensionEndToEnd: false,
    timingBasis: 'Synthetic cue duration: 3 seconds per line; not measured video speech.',
    maximumCalls: 6,
    automaticRetry: false,
    semanticReview: 'pending',
  };
  await writeFile(output, JSON.stringify({ ...metadata, results }, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  for (const provider of providers) {
    for (const count of [5, 10, 20]) {
      const text = lines.slice(0, count).join('\n');
      const started = performance.now();
      let firstPreviewMs: number | null = null;
      const base = {
        provider: provider.name,
        model: provider.model,
        cueCount: count,
        videoSeconds: count * 3,
        inputWords: text.split(/\s+/).length,
        inputCharacters: text.length,
        intendedPlaybackSecondsAt2x: count * 1.5,
      };
      try {
        const result = await translate({
          config: { baseUrl: provider.baseUrl, model: provider.model, apiKey: provider.apiKey! },
          source: { kind: 'plain-text', text },
          sourceLanguage: 'en',
          targetLanguage: 'zh-CN',
          onProgress(progress) {
            if (progress.text && firstPreviewMs === null)
              firstPreviewMs = Math.round(performance.now() - started);
          },
        });
        const completeMs = Math.round(performance.now() - started);
        results.push({
          ...base,
          status: 'ready',
          firstPreviewMs,
          completeMs,
          lineCountPreserved: result.text.split('\n').length === count,
          translatedText: result.text,
          usage: result.usage,
          remainingPlaybackBudgetAt2xMs: count * 1500 - completeMs,
        });
      } catch (error) {
        results.push({
          ...base,
          status: 'failed',
          firstPreviewMs,
          completeMs: Math.round(performance.now() - started),
          errorCode: error instanceof ProviderError ? error.code : 'PROBE_ERROR',
        });
      }
      const encoded = JSON.stringify({ ...metadata, results }, null, 2) + '\n';
      if (secrets.some((secret) => encoded.includes(secret!)))
        throw new Error('CREDENTIAL_IN_REPORT');
      await writeFile(output, encoded, { mode: 0o600 });
      const last = results.at(-1)!;
      console.log(`${provider.name}/${count} cues: ${last.status}, ${last.completeMs} ms`);
    }
  }
}
main().catch(() => {
  console.error('PROBE_FAILED: check local credentials, network and a new output path.');
  process.exitCode = 1;
});
