import { browser } from 'wxt/browser';
import { appearanceOf, type Appearance } from '../ui/appearance';

// Only this public projection reaches page controllers; never broadcast config snapshots.
export async function notifyAppearance(preferences: Appearance, revision: number) {
  const message = {
    protocolVersion: 1,
    type: 'app.appearance-changed',
    appearance: appearanceOf(preferences),
    revision,
  };
  const tabs = await browser.tabs.query({});
  await Promise.allSettled([
    browser.runtime.sendMessage(message),
    ...tabs
      .filter((tab) => tab.id !== undefined)
      .map((tab) => browser.tabs.sendMessage(tab.id!, message, { frameId: 0 })),
  ]);
}
