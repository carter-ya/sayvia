import { chromium, expect, test, type BrowserContext, type Worker } from '@playwright/test';
import { createServer, type ServerResponse } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { browser } from 'wxt/browser';
import { M1_SAMPLES } from '../../src/evaluation/samples';
import type {
  Execution,
  ExecutionView,
  ExecutorCommand,
} from '../../src/runtime/executor-protocol';

type FixtureGlobal = {
  chrome: typeof browser;
  executorFixture?: {
    port: ReturnType<typeof browser.runtime.connect>;
    epoch: string;
    token: string;
    bound: boolean;
  };
};
const KEY = 'EXECUTOR_FIXTURE_KEY_ONLY';
async function command(background: Worker, command: ExecutorCommand['command']) {
  return background.evaluate(async (command) => {
    const fixture = (globalThis as unknown as FixtureGlobal).executorFixture!;
    const requestId = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        fixture.port.onMessage.removeListener(listener);
        reject(new Error('FIXTURE_TIMEOUT'));
      }, 3000);
      const listener = (message: { type?: string; requestId?: string; data?: unknown }) => {
        if (message.type !== 'executor.reply' || message.requestId !== requestId) return;
        clearTimeout(timer);
        fixture.port.onMessage.removeListener(listener);
        resolve(message.data);
      };
      fixture.port.onMessage.addListener(listener);
      fixture.port.postMessage({
        protocolVersion: 1,
        requestId,
        epoch: fixture.epoch,
        token: fixture.token,
        command,
      });
    });
  }, command);
}

test('real offscreen execution uses a bundled Worker, private credentials, cancellation and dedup', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sayvia-executor-'));
  const extension = join(temporary, 'extension');
  await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
  const manifestFile = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  manifest.background.service_worker = 'executor-test-background.js';
  await writeFile(
    join(extension, 'executor-test-background.js'),
    'chrome.runtime.onInstalled.addListener(() => {});',
  );
  await writeFile(manifestFile, JSON.stringify(manifest));
  let count = 0;
  let authorized = 0;
  const held = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      count++;
      if (request.headers.authorization === `Bearer ${KEY}`) authorized++;
      if (request.url?.startsWith('/wait/')) {
        held.add(response);
        response.on('close', () => held.delete(response));
        return;
      }
      const payload = JSON.parse(JSON.parse(body).messages[1].content);
      expect(body).not.toContain('CODE_STAYS_LOCAL');
      const content = JSON.stringify({
        segments: payload.segments.map((segment: { id: string; text: string }) => ({
          id: segment.id,
          text: request.url?.startsWith('/echo/')
            ? segment.text
            : segment.text.replace('你好', 'Hello'),
        })),
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const background = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(background.url()).host;
    const observer = await context.newPage();
    await observer.goto(`chrome-extension://${id}/options.html`);
    await observer.evaluate(() => {
      const api = (globalThis as unknown as FixtureGlobal).chrome;
      const collected: string[] = [];
      (document.body as HTMLElement & { observedMessages?: string[] }).observedMessages = collected;
      api.runtime.onMessage.addListener((message) => {
        collected.push(JSON.stringify(message));
      });
      api.runtime.onConnect.addListener((port) => {
        port.onMessage.addListener((message) => {
          collected.push(JSON.stringify(message));
        });
      });
    });
    await background.evaluate(async () => {
      const global = globalThis as unknown as FixtureGlobal;
      const api = global.chrome;
      api.runtime.onConnect.addListener((port) => {
        if (
          port.name !== 'sayvia.executor.v1' ||
          port.sender?.url !== api.runtime.getURL('/offscreen.html')
        )
          return;
        const fixture = { port, epoch: '', token: crypto.randomUUID(), bound: false };
        global.executorFixture = fixture;
        port.onMessage.addListener((message: { type?: string; epoch?: string }) => {
          if (message.type === 'executor.hello') {
            fixture.epoch = message.epoch!;
            port.postMessage({
              protocolVersion: 1,
              requestId: crypto.randomUUID(),
              epoch: fixture.epoch,
              token: fixture.token,
              command: { type: 'bind' },
            });
          } else if (message.type === 'executor.reply') fixture.bound = true;
        });
      });
      await api.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Validate bundled translation Worker processing.',
      });
    });
    await expect
      .poll(() =>
        background.evaluate(() => (globalThis as unknown as FixtureGlobal).executorFixture?.bound),
      )
      .toBe(true);
    const execution: Execution = {
      taskId: crypto.randomUUID(),
      deadlineAt: Date.now() + 60_000,
      source: { kind: 'markdown', text: '你好 `CODE_STAYS_LOCAL`' },
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      config: { baseUrl, model: 'fixture', apiKey: KEY },
    };
    expect(await command(background, { type: 'start', execution })).toMatchObject({
      state: 'running',
    });
    await expect
      .poll(
        async () =>
          (
            (await command(background, {
              type: 'query',
              taskId: execution.taskId,
            })) as ExecutionView
          ).state,
      )
      .not.toBe('running');
    expect(
      ((await command(background, { type: 'query', taskId: execution.taskId })) as ExecutionView)
        .error,
    ).toBeUndefined();
    expect(await command(background, { type: 'query', taskId: execution.taskId })).toMatchObject({
      state: 'ready',
      result: { text: 'Hello `CODE_STAYS_LOCAL`' },
    });
    expect(await command(background, { type: 'start', execution })).toMatchObject({
      state: 'ready',
    });
    expect(count).toBe(1);
    expect(authorized).toBe(1);
    expect(await command(background, { type: 'ack', taskId: execution.taskId })).toEqual({
      taskId: execution.taskId,
      state: 'delivered',
    });
    for (const sample of M1_SAMPLES) {
      const roundtrip: Execution = {
        ...execution,
        taskId: crypto.randomUUID(),
        deadlineAt: Date.now() + 60_000,
        source: sample.source,
        config: { ...execution.config, baseUrl: `${baseUrl}/echo` },
      };
      await command(background, { type: 'start', execution: roundtrip });
      await expect
        .poll(
          async () =>
            (
              (await command(background, {
                type: 'query',
                taskId: roundtrip.taskId,
              })) as ExecutionView
            ).state,
        )
        .not.toBe('running');
      expect(await command(background, { type: 'query', taskId: roundtrip.taskId })).toMatchObject({
        state: 'ready',
        result: { text: sample.source.text },
      });
      await command(background, { type: 'ack', taskId: roundtrip.taskId });
    }
    expect(count).toBe(13);
    const canceled = {
      ...execution,
      taskId: crypto.randomUUID(),
      deadlineAt: Date.now() + 60_000,
      config: { ...execution.config, baseUrl: `${baseUrl}/wait` },
    };
    await command(background, { type: 'start', execution: canceled });
    await expect.poll(() => held.size).toBe(1);
    expect(await command(background, { type: 'cancel', taskId: canceled.taskId })).toMatchObject({
      state: 'canceled',
    });
    await expect.poll(() => held.size).toBe(0);
    expect(await command(background, { type: 'start', execution: canceled })).toMatchObject({
      state: 'canceled',
    });
    expect(count).toBe(14);
    expect(await command(background, { type: 'inspect' })).toEqual({
      active: 0,
      pendingResults: 0,
    });
    const observed = await observer.evaluate(
      () => (document.body as HTMLElement & { observedMessages?: string[] }).observedMessages,
    );
    expect(JSON.stringify(observed)).not.toContain(KEY);
    await background.evaluate(async () => {
      await (globalThis as unknown as FixtureGlobal).chrome.offscreen.closeDocument();
    });
  } finally {
    held.forEach((response) => response.destroy());
    await context?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(temporary, { recursive: true, force: true });
  }
});
