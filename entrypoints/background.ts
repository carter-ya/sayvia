import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      sender.id !== browser.runtime.id ||
      sender.origin !== new URL(browser.runtime.getURL('/')).origin ||
      typeof message !== 'object' ||
      message === null ||
      message.type !== 'app.get-status'
    ) {
      return;
    }

    sendResponse({ version: browser.runtime.getManifest().version });
  });
});
