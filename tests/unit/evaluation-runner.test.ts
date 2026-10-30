import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runEvaluation, type EvaluationEntry } from '../../src/evaluation/run-evaluation';
function syntheticTemplate(text: string) {
  return text
    .split(/(⟦SV\d+:\d+⟧)/)
    .map((piece) => (piece.startsWith('⟦SV') || !piece.trim() ? piece : 'Translated text'))
    .join('');
}

it('uses the same 12 public samples with one request each and keeps human review pending', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init!.body));
    const input = JSON.parse(request.messages[1].content);
    const content = JSON.stringify({
      segments: input.segments
        .filter((part: { text?: string }) => part.text !== undefined)
        .map((part: { id: string; text: string }) => ({
          id: part.id,
          text: syntheticTemplate(part.text),
        })),
    });
    return new Response(
      JSON.stringify({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      }),
    );
  });
  const entries: EvaluationEntry[] = [];
  const report = await runEvaluation(
    { baseUrl: 'https://example.test', model: 'explicit-model', apiKey: 'DUMMY_TEST_KEY' },
    (entry) => {
      entries.push(entry);
    },
    fetcher,
  );
  expect(fetcher).toHaveBeenCalledTimes(12);
  expect(entries).toHaveLength(12);
  expect(report.automatedPassed).toBe(true);
  expect(report.manualReviewPending).toBe(true);
  expect(report.m1Passed).toBe(false);
  expect(
    entries.every(
      (entry) => entry.semanticReview === 'pending' && entry.usabilityReview === 'pending',
    ),
  ).toBe(true);
  expect(JSON.stringify(report)).not.toContain('DUMMY_TEST_KEY');
});

it('records sanitized failure codes without retrying or claiming a quality pass', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error('DUMMY_TEST_KEY PRIVATE_RESPONSE'));
  const report = await runEvaluation(
    { baseUrl: 'https://example.test', model: 'explicit-model', apiKey: 'DUMMY_TEST_KEY' },
    () => undefined,
    fetcher,
  );
  expect(fetcher).toHaveBeenCalledTimes(12);
  expect(report.automatedPassed).toBe(false);
  expect(report.entries.every((entry) => entry.errorCode === 'NETWORK_ERROR')).toBe(true);
  expect(JSON.stringify(report)).not.toMatch(/DUMMY_TEST_KEY|PRIVATE_RESPONSE/);
});

it('runs the actual CLI against a local mock, persists each result, and refuses to overwrite a report', async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requests += 1;
      const input = JSON.parse(JSON.parse(body).messages[1].content);
      const content = JSON.stringify({
        segments: input.segments
          .filter((part: { text?: string }) => part.text !== undefined)
          .map((part: { id: string; text: string }) => ({
            id: part.id,
            text: syntheticTemplate(part.text),
          })),
      });
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        }),
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const folder = await mkdtemp(join(tmpdir(), 'sayvia-evaluation-'));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture unavailable');
    const output = join(folder, 'report.jsonl');
    const args = [
      resolve('node_modules/tsx/dist/cli.mjs'),
      'scripts/evaluate.ts',
      '--provider',
      'openai-compatible',
      '--model',
      'fixture-model',
      '--base-url',
      `http://127.0.0.1:${address.port}/prefix`,
      '--out',
      output,
    ];
    const options = {
      env: { ...process.env, SAYVIA_API_KEY: 'DUMMY_CLI_KEY' },
      encoding: 'utf8' as const,
    };
    await promisify(execFile)(process.execPath, args, options);
    const raw = await readFile(output, 'utf8');
    const lines = raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(14);
    expect(lines[0]).toMatchObject({
      type: 'run',
      model: 'fixture-model',
      algorithmVersion: 'segments-v2.1',
    });
    expect(lines[13]).toMatchObject({
      type: 'summary',
      sampleCount: 12,
      automatedPassed: true,
      manualReviewPending: true,
      m1Passed: false,
    });
    expect(raw).not.toContain('DUMMY_CLI_KEY');
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    await expect(promisify(execFile)(process.execPath, args, options)).rejects.toThrow(
      'EVALUATION_FAILED',
    );
    expect(await readFile(output, 'utf8')).toBe(raw);
    expect(requests).toBe(12);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(folder, { recursive: true, force: true });
  }
});
