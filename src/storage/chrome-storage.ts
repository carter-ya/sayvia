import { browser } from 'wxt/browser';
import type { ConfigStorage } from './repository';

const ROOT_KEY = 'sayvia.config';

export const chromeConfigStorage: ConfigStorage = {
  async restrictAccess() {
    await browser.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  },
  async read() {
    return (await browser.storage.local.get(ROOT_KEY))[ROOT_KEY] as unknown;
  },
  async write(state) {
    await browser.storage.local.set({ [ROOT_KEY]: state });
  },
};
