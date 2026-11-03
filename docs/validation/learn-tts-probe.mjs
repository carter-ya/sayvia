// Standalone capability probe; never loads Sayvia or a personal browser profile.
/* global chrome */
// Usage: node docs/validation/learn-tts-probe.mjs > /tmp/sayvia-tts-result.json
// Add --headed to compare with a visible, temporary browser.
import { chromium } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporary = await mkdtemp(join(tmpdir(), 'sayvia-tts-probe-'));
const extension = join(temporary, 'extension');
let context;
try {
  await mkdir(extension);
  await writeFile(
    join(extension, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Sayvia isolated TTS probe',
      version: '0.0.1',
      permissions: ['tts'],
      background: { service_worker: 'background.js' },
    }),
  );
  await writeFile(
    join(extension, 'background.js'),
    'chrome.runtime.onMessage.addListener(() => {});',
  );
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    channel: 'chromium',
    headless: !process.argv.includes('--headed'),
    ...(process.env.SAYVIA_CHROME_PATH ? { executablePath: process.env.SAYVIA_CHROME_PATH } : {}),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const background = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const result = await background.evaluate(async () => {
    let voices = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      voices = await new Promise((resolve) => chrome.tts.getVoices(resolve));
      if (voices.length) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const local = voices.filter((voice) => voice.remote === false && !voice.extensionId);
    const samples = [
      ['zh-CN', '你好'],
      ['en-US', 'hello'],
      ['ja-JP', 'こんにちは'],
      ['ko-KR', '안녕하세요'],
      ['fr-FR', 'bonjour'],
      ['de-DE', 'hallo'],
      ['es-ES', 'hola'],
    ];
    const results = [];
    async function speak(text, voice, rate, stopOnStart = false) {
      return new Promise((resolve) => {
        const events = [];
        const started = performance.now();
        let settled = false;
        const finish = (outcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve({ outcome, events, durationMs: Math.round(performance.now() - started) });
        };
        const timeout = setTimeout(() => {
          finish('timeout');
          chrome.tts.stop();
        }, 6000);
        chrome.tts.speak(
          text,
          {
            voiceName: voice.voiceName,
            lang: voice.lang,
            rate,
            volume: 0,
            enqueue: false,
            onEvent(event) {
              events.push({
                type: event.type,
                elapsedMs: Math.round(performance.now() - started),
                ...(event.errorMessage ? { error: event.errorMessage } : {}),
              });
              if (event.type === 'start' && stopOnStart) chrome.tts.stop();
              if (['end', 'error', 'interrupted', 'cancelled'].includes(event.type))
                finish(event.type);
            },
          },
          () => {
            if (chrome.runtime.lastError)
              finish(`callback-error: ${chrome.runtime.lastError.message}`);
          },
        );
      });
    }
    for (const [lang, word] of samples) {
      // Mandarin must not silently select a Cantonese voice.
      const voice =
        local.find((v) => v.lang === lang) ??
        (lang.startsWith('zh')
          ? undefined
          : local.find((v) => v.lang?.split('-')[0] === lang.split('-')[0]));
      if (!voice) {
        results.push({ lang, available: false });
        continue;
      }
      results.push({
        lang,
        available: true,
        voice: voice.voiceName,
        voiceLanguage: voice.lang,
        normal: await speak(word, voice, 1),
        slow: await speak(word, voice, 0.75),
      });
    }
    const english = local.find((v) => v.lang === 'en-US');
    const stop = english
      ? await speak('This is a longer sample to verify stopping speech.', english, 1, true)
      : null;
    return {
      userAgent: navigator.userAgent,
      ttsAvailable: typeof chrome.tts.speak === 'function',
      voiceCount: voices.length,
      localVoiceCount: local.length,
      results,
      stop,
      volume: 0,
      verifiesAudibleQuality: false,
    };
  });
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        headed: process.argv.includes('--headed'),
        ...result,
      },
      null,
      2,
    ),
  );
} finally {
  await context?.close();
  await rm(temporary, { recursive: true, force: true });
}
