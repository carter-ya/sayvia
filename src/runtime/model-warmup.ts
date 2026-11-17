import { browser } from 'wxt/browser';

export function warmModel(providerId?: string) {
  // Best effort: opening a panel and starting a translation never depend on warmup succeeding.
  try {
    void browser.runtime
      .sendMessage({
        protocolVersion: 1,
        type: 'model.warmup',
        ...(providerId ? { providerId } : {}),
      })
      .catch(() => undefined);
  } catch {
    // A reloaded extension can synchronously invalidate a content script's context.
  }
}
