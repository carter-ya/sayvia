// Opt-in local OS speech probe, never part of ordinary CI; may produce audible short samples.
import {chromium} from '@playwright/test';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import type {browser} from 'wxt/browser';
import {selectLocalVoice} from '../../src/core/local-voice';
type Scope = {chrome: typeof browser; speechProbeEvents: Array<{ticket: {speechId: string}; state: string}>};
if (process.env.SAYVIA_RUN_NATIVE_SPEECH !== '1') throw new Error('Set SAYVIA_RUN_NATIVE_SPEECH=1 to play local samples.');
const directory = await mkdtemp(join(tmpdir(), 'sayvia-native-speech-'));
const extension = resolve('.output/chrome-mv3');
const context = await chromium.launchPersistentContext(directory, {channel:'chromium', headless:true, args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage(); await page.goto(`chrome-extension://${id}/popup.html`);
  const tabId = await page.evaluate(async () => {
    const global = globalThis as unknown as Scope;
    global.speechProbeEvents = [];
    global.chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'speech.state') global.speechProbeEvents.push(message);
    });
    return (await global.chrome.tabs.query({})).find((tab) => tab.url === global.chrome.runtime.getURL('/popup.html'))!.id!;
  });
  const voices = await page.evaluate(() => (globalThis as unknown as Scope).chrome.tts.getVoices());
  const samples = [['zh-CN','你好'], ['en-US','hello'], ['ja-JP','こんにちは'], ['ko-KR','안녕하세요'], ['fr-FR','bonjour'], ['de-DE','hallo'], ['es-ES','hola']] as const;
  const results: unknown[] = [];
  const source = {origin:'manual', tabId, cardId:crypto.randomUUID(), documentNonce:crypto.randomUUID()};
  const send = (message: unknown) => page.evaluate((message) => (globalThis as unknown as Scope).chrome.runtime.sendMessage(message), message);
  for (const [language, text] of samples) {
    const envelope = {protocolVersion:1, requestId:crypto.randomUUID()};
    const issued = await send({...envelope, type:'speech.ticket', payload:{source, clientSpeechId:crypto.randomUUID()}}) as {ok:boolean; data?: {speechId:string; epoch:string; expiresAt:number}};
    if (!issued.ok || !issued.data) throw new Error('PROBE_TICKET_FAILED');
    const ticket = issued.data;
    const began = Date.now();
    const reply = await send({...envelope, type:'speech.start', payload:{source, ticket, input:{text, language, languageConfirmed:true, rate:1}}});
    let timedOut = false;
    try {await page.waitForFunction((speechId) => (globalThis as unknown as Scope).speechProbeEvents.some((event) => event.ticket.speechId === speechId && ['ended','failed','canceled','unavailable'].includes(event.state)), ticket.speechId, {timeout:10_000});}
    catch {timedOut = true;}
    const states = await page.evaluate((speechId) => (globalThis as unknown as Scope).speechProbeEvents.filter((event) => event.ticket.speechId === speechId).map((event) => event.state), ticket.speechId);
    const readyVoices = await page.evaluate(() => (globalThis as unknown as Scope).chrome.tts.getVoices());
    const availableMatchingVoiceAfterStart = selectLocalVoice(readyVoices, language);
    results.push({language, text, availableMatchingVoiceAfterStart: availableMatchingVoiceAfterStart ?? null, reply, states, timedOut, elapsedMs:Date.now()-began});
    await send({...envelope, type:'speech.stop', payload:{source, ticket}}).catch(() => undefined);
  }
  const finalVoices = await page.evaluate(() => (globalThis as unknown as Scope).chrome.tts.getVoices());
  const report = {recordedAt:new Date().toISOString(), browser:context.browser()?.version(), mode:'production-speech-service/native-OS-voices/volume-default', acousticReview:false, humanPronunciationReview:false, initialVoiceCount:voices.length, voiceCount:finalVoices.length, localVoiceCount:finalVoices.filter((voice) => voice.remote === false && !voice.extensionId).length, results};
  await writeFile(resolve('docs/validation/speech-native-results.json'), JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({voiceCount:report.voiceCount, localVoiceCount:report.localVoiceCount, results}));
} finally {await context.close(); await rm(directory,{recursive:true,force:true});}
