import { parseArgs } from 'node:util';
import { open } from 'node:fs/promises';
import { runEvaluation } from '../src/evaluation/run-evaluation';
import { ALGORITHM_VERSION } from '../src/providers/chat-completions';
import { PROVIDER_PRESETS } from '../src/providers/presets';
import { normalizeBaseUrl } from '../src/providers/endpoint';

async function main() {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'Usage: pnpm evaluate --provider openai|deepseek|openai-compatible --model MODEL --out NEW_FILE.jsonl [--base-url URL]\nReads SAYVIA_API_KEY from this process environment. Runs the fixed 12 public samples, once each; real calls can incur charges. Results require human semantic/usability review.\n',
    );
    return;
  }
  const provider = values.provider;
  if (provider !== 'openai' && provider !== 'deepseek' && provider !== 'openai-compatible')
    throw new Error('CONFIG_REQUIRED');
  const apiKey = process.env.SAYVIA_API_KEY;
  const model = values.model?.trim();
  if (!apiKey || !model || model.length > 160 || !values.out) throw new Error('CONFIG_REQUIRED');
  const baseUrl = normalizeBaseUrl(values['base-url'] ?? PROVIDER_PRESETS[provider].baseUrl);
  const file = await open(values.out, 'wx', 0o600);
  try {
    await file.appendFile(
      JSON.stringify({
        type: 'run',
        provider,
        model,
        algorithmVersion: ALGORITHM_VERSION,
        sampleVersion: 'm1-12-v1',
        startedAt: new Date().toISOString(),
        manualReviewPending: true,
      }) + '\n',
    );
    const report = await runEvaluation({ baseUrl, model, apiKey }, async (entry) => {
      await file.appendFile(JSON.stringify({ type: 'sample', ...entry }) + '\n');
      process.stdout.write(
        `${entry.id}: ${entry.status}${entry.errorCode ? ` (${entry.errorCode})` : ''}\n`,
      );
    });
    const summary = {
      algorithmVersion: report.algorithmVersion,
      sampleCount: report.sampleCount,
      automatedPassed: report.automatedPassed,
      manualReviewPending: true,
      m1Passed: false,
    };
    await file.appendFile(JSON.stringify({ type: 'summary', ...summary }) + '\n');
    process.stdout.write(
      `Automated checks: ${report.automatedPassed ? 'passed' : 'failed'}. Human review pending; M1 is not approved.\n`,
    );
    if (!report.automatedPassed) process.exitCode = 1;
  } finally {
    await file.close();
  }
}

main().catch(() => {
  // Never print raw exceptions, request headers, server bodies, or configuration.
  process.stderr.write(
    'EVALUATION_FAILED: check arguments, local credentials, endpoint, and a writable new output path.\n',
  );
  process.exitCode = 1;
});
