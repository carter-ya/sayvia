import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { handleSettings } from '../src/background/settings-router';
import { chromeConfigStorage } from '../src/storage/chrome-storage';
import { ConfigRepository } from '../src/storage/repository';

export default defineBackground(() => {
  const repository = new ConfigRepository(chromeConfigStorage);
  void repository.ready.catch(() => undefined);

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      sender.id !== browser.runtime.id ||
      sender.origin !== new URL(browser.runtime.getURL('/')).origin ||
      typeof message !== 'object' ||
      message === null
    )
      return;

    if (message.type === 'app.get-status') {
      sendResponse({ version: browser.runtime.getManifest().version });
      return;
    }

    if (typeof message.type !== 'string' || !message.type.startsWith('settings.')) return;
    if (sender.url?.split(/[?#]/)[0] !== browser.runtime.getURL('/options.html')) {
      sendResponse({ ok: false, error: 'FORBIDDEN' });
      return;
    }

    void handleSettings(message, repository).then(sendResponse);
    return true;
  });
});
