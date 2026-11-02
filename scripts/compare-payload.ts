import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { M1_SAMPLES, type EvaluationSample } from '../src/evaluation/samples';
import { translate, ALGORITHM_VERSION } from '../src/providers/chat-completions';
import { PROVIDER_PRESETS } from '../src/providers/presets';

// Public, fixed inputs; both variants see the same corpus and language settings.
const url = 'https://dev.mysql.com/doc/refman/8.4/en/json-function-reference.html';
const extra = (
  id: string,
  text: string,
  protectedText: string[],
  source: EvaluationSample['source'] = { kind: 'plain-text', text },
): EvaluationSample => ({
  id,
  title: id,
  source,
  protectedText,
  targetLanguage: 'zh-CN',
  referenceMeaning: 'Preserve the source meaning and every protected value.',
  reviewFocus: 'Compare semantics and formatting between both variants.',
});
export const COMPARISON_SAMPLES: readonly EvaluationSample[] = [
  ...M1_SAMPLES,
  extra('mysql-url', `To which function JSON_* you are referring to? ${url}`, [url]),
  extra(
    'multiple-urls',
    `Compare https://example.test/reference/installation?version=8.4&platform=linux with https://example.test/reference/configuration?version=8.4&mode=basic before changing settings.`,
    [
      'https://example.test/reference/installation?version=8.4&platform=linux',
      'https://example.test/reference/configuration?version=8.4&mode=basic',
    ],
  ),
  extra('literal-marker', 'Keep ⟦SV0:1⟧ as written and see https://example.test/guide.', [
    '⟦SV0:1⟧',
    'https://example.test/guide.',
  ]),
  extra('code-whitespace', 'Read \tlimit\t only if the request fails.', ['\tlimit\t'], {
    kind: 'dom-selection',
    text: 'Read \tlimit\t only if the request fails.',
    protectedRanges: [{ kind: 'inline-code', start: 5, end: 12 }],
    marks: [],
  }),
  extra('protected-only', url, [url]),
];
const Usage = z.object({
  prompt_tokens: z.int().nonnegative(),
  completion_tokens: z.int().nonnegative(),
  total_tokens: z.int().nonnegative(),
});

async function main() {
  const { values } = parseArgs({
    options: {
      'baseline-dir': { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      out: { type: 'string' },
      sample: { type: 'string', multiple: true },
      rounds: { type: 'string', default: '1' },
    },
  });
  const provider = values.provider;
  if (
    (provider !== 'openai' && provider !== 'deepseek') ||
    !values['baseline-dir'] ||
    !values.model ||
    !values.out ||
    !process.env.SAYVIA_API_KEY
  )
    throw Error('CONFIG_REQUIRED');
  const rounds = Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw Error('INVALID_ROUNDS');
  const samples = values.sample
    ? COMPARISON_SAMPLES.filter((sample) => values.sample!.includes(sample.id))
    : COMPARISON_SAMPLES;
  if (!samples.length || (values.sample && samples.length !== new Set(values.sample).size))
    throw Error('INVALID_SAMPLES');
  const key = process.env.SAYVIA_API_KEY;
  const baselineRoot = resolve(values['baseline-dir']);
  const baseline = (await import(
    pathToFileURL(resolve(baselineRoot, 'src/providers/chat-completions.ts')).href
  )) as typeof import('../src/providers/chat-completions');
  const fingerprint = async (root: string) =>
    createHash('sha256')
      .update(await readFile(resolve(root, 'src/core/translation-plan.ts')))
      .update(await readFile(resolve(root, 'src/providers/chat-completions.ts')))
      .digest('hex');
  const file = await open(values.out, 'wx', 0o600);
  const append = async (value: unknown) => {
    const line = JSON.stringify(value);
    if (line.includes(key)) throw Error('PRIVATE_DATA');
    await file.appendFile(line + '\n');
  };
  try {
    await append({
      type: 'run',
      provider,
      model: values.model,
      startedAt: new Date().toISOString(),
      baselineAlgorithm: baseline.ALGORITHM_VERSION,
      candidateAlgorithm: ALGORITHM_VERSION,
      baselineFingerprint: await fingerprint(baselineRoot),
      candidateFingerprint: await fingerprint('.'),
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      corpusSha256: createHash('sha256').update(JSON.stringify(samples)).digest('hex'),
      sampleCount: samples.length,
      rounds,
      order: 'alternate-baseline-first-candidate-first',
      manualReleaseAcceptancePending: true,
    });
    for (let round = 0; round < rounds; round++) {
      for (const [index, sample] of samples.entries()) {
        const variants =
          (index + round) % 2
            ? (['candidate', 'baseline'] as const)
            : (['baseline', 'candidate'] as const);
        for (const variant of variants) {
          let usage: z.infer<typeof Usage> | null = null;
          let requestBody: unknown;
          const fetcher: typeof fetch = async (input, init) => {
            requestBody = JSON.parse(String(init?.body));
            const response = await fetch(input, init);
            if (response.ok) {
              const data: unknown = await response.clone().json();
              const parsed = z.object({ usage: Usage }).safeParse(data);
              if (parsed.success) usage = parsed.data.usage;
            }
            return response;
          };
          const start = Date.now();
          try {
            const result = await (variant === 'baseline' ? baseline.translate : translate)(
              {
                config: {
                  baseUrl: PROVIDER_PRESETS[provider].baseUrl,
                  model: values.model,
                  apiKey: key,
                },
                source: sample.source,
                sourceLanguage: 'auto',
                targetLanguage: sample.targetLanguage,
              },
              fetcher,
            );
            if (!result.requested)
              usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
            const protectionPassed = sample.protectedText.every((text) =>
              result.text.includes(text),
            );
            await append({
              type: 'sample',
              id: sample.id,
              round,
              variant,
              status: 'ready',
              requested: result.requested,
              usage,
              requestBody,
              source: sample.source,
              translatedText: result.text,
              protectionPassed,
              durationMs: Date.now() - start,
            });
            process.stdout.write(`${sample.id} round=${round} ${variant}: ready\n`);
            if (!usage || !protectionPassed) {
              process.exitCode = 1;
              return;
            }
          } catch {
            await append({
              type: 'sample',
              id: sample.id,
              round,
              variant,
              status: 'failed',
              usage,
              durationMs: Date.now() - start,
            });
            process.stdout.write(`${sample.id} round=${round} ${variant}: failed\n`);
            // Do not silently spend on retries or produce a partial success summary.
            process.exitCode = 1;
            return;
          }
        }
      }
    }
    await append({ type: 'finished', completedAt: new Date().toISOString() });
  } finally {
    await file.close();
  }
}

main().catch(() => {
  process.stderr.write('COMPARISON_FAILED: check local configuration and the new report path.\n');
  process.exitCode = 1;
});
