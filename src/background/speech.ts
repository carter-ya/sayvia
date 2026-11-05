import { browser } from 'wxt/browser';
import { matchesHostOrigin } from './permission-revocation';
import { handleSpeechMessage } from './speech-router';
import { SPEECH_STORAGE_KEY, SpeechService } from './speech-service';
import { permissionPattern } from './task-router';

export function installSpeech(sessionReady: Promise<unknown>) {
  const service = new SpeechService({
    async read() {
      await sessionReady;
      return (await browser.storage.session.get(SPEECH_STORAGE_KEY))[SPEECH_STORAGE_KEY];
    },
    save: (lease) => browser.storage.session.set({ [SPEECH_STORAGE_KEY]: lease }),
    remove: () => browser.storage.session.remove(SPEECH_STORAGE_KEY),
    voices: () => browser.tts.getVoices(),
    speak: (text, options) => browser.tts.speak(text, options),
    stop: () => browser.tts.stop(),
    alarm: (name, when) => browser.alarms.create(name, { when }),
    clearAlarm: (name) => browser.alarms.clear(name),
    async permitted(owner) {
      try {
        await browser.tabs.get(owner.tabId);
        if (owner.kind === 'manual') return true;
        if (
          !(await browser.permissions.contains({ origins: [permissionPattern(owner.siteOrigin)] }))
        )
          return false;
        // A queued request from an old document cannot speak after navigation, even at the same URL.
        const documents = await browser.scripting.executeScript({
          target: { tabId: owner.tabId, documentIds: [owner.documentId] },
          func: () => location.origin,
        });
        return (
          documents.length === 1 &&
          documents[0]?.documentId === owner.documentId &&
          documents[0].result === owner.siteOrigin
        );
      } catch {
        return false;
      }
    },
    async notify(owner, ticket, state) {
      const event = {
        protocolVersion: 1,
        type: 'speech.state',
        cardId: owner.cardId,
        documentNonce: owner.documentNonce,
        ticket,
        state,
      };
      if (owner.kind === 'page')
        await browser.tabs.sendMessage(owner.tabId, event, {
          documentId: owner.documentId,
          frameId: 0,
        });
      else await browser.runtime.sendMessage({ ...event, tabId: owner.tabId });
    },
  });
  void service.ready.catch(() => undefined);
  browser.runtime.onMessage.addListener((message, sender, reply) => {
    if (
      typeof message !== 'object' ||
      message === null ||
      typeof message.type !== 'string' ||
      !['speech.ticket', 'speech.start', 'speech.stop'].includes(message.type)
    )
      return;
    void handleSpeechMessage(message, sender, service).then(reply);
    return true;
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    void service.cancelWhere((owner) => owner.tabId === tabId).catch(() => undefined);
  });
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' || info.url)
      void service.cancelWhere((owner) => owner.tabId === tabId).catch(() => undefined);
  });
  browser.permissions.onRemoved.addListener((removed) => {
    void service
      .cancelWhere(
        (owner) =>
          owner.kind === 'page' &&
          (removed.origins ?? []).some((pattern) => matchesHostOrigin(pattern, owner.siteOrigin)),
      )
      .catch(() => undefined);
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    void service.onAlarm(alarm.name).catch(() => undefined);
  });
  return service;
}
