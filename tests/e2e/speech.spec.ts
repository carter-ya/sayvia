import { chromium, expect, test } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { browser } from 'wxt/browser';
import { browserLaunchOptions } from '../fixtures/browser-options';
type Chrome = { chrome: typeof browser };

test('production speech routing pins local voices, deduplicates, cleans navigation and rejects settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sayvia-speech-'));
  const extension = join(directory, 'extension');
  await cp(resolve('.output/chrome-mv3'), extension, { recursive: true });
  const backgroundPath = join(extension, 'background.js');
  const original = await readFile(backgroundPath, 'utf8');
  // Only the temporary fixture replaces OS voices. The real router/storage/alarm/service run.
  const shim = `
    const speechFixture = {spoken: [], stops: 0, events: []};
    chrome.tts.getVoices = async () => [{voiceName:'Fixture local', lang:'en-US', remote:false}, {voiceName:'Cloud', lang:'fr-FR', remote:true}];
    chrome.tts.speak = async (text, options) => {speechFixture.spoken.push({text, voiceName:options.voiceName, lang:options.lang, rate:options.rate}); speechFixture.events.push(options.onEvent);};
    chrome.tts.stop = () => {speechFixture.stops++;};
    chrome.runtime.onMessage.addListener((message, sender, reply) => {
      if(message?.type === 'fixture.speech.inspect') reply({spoken:speechFixture.spoken, stops:speechFixture.stops});
      if(message?.type === 'fixture.speech.end') {speechFixture.events[message.index]?.({type:'end'}); reply({ok:true});}
    });
  `;
  await writeFile(backgroundPath, shim + original);
  const context = await chromium.launchPersistentContext(join(directory, 'profile'), {
    ...browserLaunchOptions(),
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const target = await context.newPage();
    await target.goto(`chrome-extension://${id}/options.html`);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const tabId = await popup.evaluate(
      async () =>
        (await (globalThis as unknown as Chrome).chrome.tabs.query({})).find(
          (tab) =>
            tab.url === (globalThis as unknown as Chrome).chrome.runtime.getURL('/options.html'),
        )!.id!,
    );
    const send = (message: unknown) =>
      popup.evaluate(
        (message) => (globalThis as unknown as Chrome).chrome.runtime.sendMessage(message),
        message,
      );
    const source = {
      origin: 'manual',
      tabId,
      documentNonce: crypto.randomUUID(),
      cardId: crypto.randomUUID(),
    };
    const envelope = { protocolVersion: 1, requestId: crypto.randomUUID() };
    const ticketMessage = {
      ...envelope,
      type: 'speech.ticket',
      payload: { source, clientSpeechId: crypto.randomUUID() },
    };
    const issued = (await send(ticketMessage)) as {
      ok: boolean;
      data: { speechId: string; epoch: string; expiresAt: number };
    };
    expect(issued.ok).toBe(true);
    expect(await send({ type: 'fixture.speech.inspect' })).toEqual({ spoken: [], stops: 0 });
    const start = {
      ...envelope,
      type: 'speech.start',
      payload: {
        source,
        ticket: issued.data,
        input: { text: 'bank', language: 'en-US', languageConfirmed: true, rate: 0.75 },
      },
    };
    expect(await send(start)).toMatchObject({ ok: true, data: { state: 'speaking' } });
    expect(await send(start)).toMatchObject({ ok: true, data: { state: 'speaking' } });
    expect(await send({ type: 'fixture.speech.inspect' })).toMatchObject({
      spoken: [{ text: 'bank', voiceName: 'Fixture local', lang: 'en-US', rate: 0.75 }],
    });
    const stored = await popup.evaluate(async () =>
      (globalThis as unknown as Chrome).chrome.storage.session.get('sayvia.speech'),
    );
    expect(JSON.stringify(stored)).not.toContain('bank');
    const alarms = await popup.evaluate(async () =>
      (globalThis as unknown as Chrome).chrome.alarms.getAll(),
    );
    expect(alarms.some((alarm) => alarm.name.includes(issued.data.speechId))).toBe(true);
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${id}/options.html`);
    expect(
      await settings.evaluate(
        (message) => (globalThis as unknown as Chrome).chrome.runtime.sendMessage(message),
        start,
      ),
    ).toEqual({ ok: false, error: 'FORBIDDEN' });
    await send({ type: 'fixture.speech.end', index: 0 });
    await expect
      .poll(async () => ((await send(start)) as { data?: { state?: string } }).data?.state)
      .toBe('ended');
    expect(await send(ticketMessage)).toEqual(issued);
    expect(await send({ type: 'fixture.speech.inspect' })).toMatchObject({
      spoken: [{ text: 'bank' }],
      stops: 0,
    });
    const second = (await send({
      ...ticketMessage,
      payload: { source, clientSpeechId: crypto.randomUUID() },
    })) as typeof issued;
    expect(
      await send({ ...start, payload: { ...start.payload, ticket: second.data } }),
    ).toMatchObject({ ok: true });
    const cdp = await context.newCDPSession(settings);
    let versionId: string | undefined;
    cdp.on(
      'ServiceWorker.workerVersionUpdated',
      (event: { versions: Array<{ scriptURL: string; versionId: string; status: string }> }) => {
        for (const version of event.versions)
          if (version.scriptURL === worker.url() && version.status === 'activated')
            versionId = version.versionId;
      },
    );
    await cdp.send('ServiceWorker.enable');
    await expect.poll(() => versionId).toBeDefined();
    await cdp.send('ServiceWorker.stopWorker', { versionId: versionId! });
    await cdp.detach();
    const third = (await send({
      ...ticketMessage,
      payload: { source, clientSpeechId: crypto.randomUUID() },
    })) as typeof issued;
    expect(third.data.epoch).not.toBe(second.data.epoch);
    expect(await send({ type: 'fixture.speech.inspect' })).toEqual({ spoken: [], stops: 1 });
    expect(await send({ ...start, payload: { ...start.payload, ticket: second.data } })).toEqual({
      ok: false,
      error: 'SPEECH_EXPIRED',
    });
    expect(
      await send({ ...start, payload: { ...start.payload, ticket: third.data } }),
    ).toMatchObject({ ok: true });
    await context
      .pages()
      .find((page) => page === target)
      ?.close();
    await expect
      .poll(
        async () => ((await send({ type: 'fixture.speech.inspect' })) as { stops: number }).stops,
      )
      .toBe(2);
    await expect
      .poll(() =>
        popup.evaluate(async () =>
          (globalThis as unknown as Chrome).chrome.storage.session.get('sayvia.speech'),
        ),
      )
      .toEqual({});
  } finally {
    await context.close();
    await rm(directory, { recursive: true, force: true });
  }
});
