import { browser } from 'wxt/browser';
import { siteOrigin } from '../runtime/site-access';

const SCRIPT_ID = 'sayvia-selection-v1';
const pattern = (origin: string) => `${origin}/*`;
export class SiteAccess {
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const work = this.queue.then(run);
    this.queue = work.catch(() => undefined);
    return work;
  }
  async permitted(origin: string) {
    const canonical = siteOrigin(origin);
    return browser.permissions.contains({ origins: [pattern(canonical)] });
  }
  reconcile() {
    return this.serial(async () => {
      // Chrome controls site access. No second per-site allowlist in the extension.
      const matches = ['https://*/*', 'http://*/*'];
      const registered = await browser.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
      const script = {
        id: SCRIPT_ID,
        matches,
        js: ['content-scripts/translator.js'],
        allFrames: false,
        runAt: 'document_idle' as const,
        persistAcrossSessions: true,
      };
      if (registered.length) await browser.scripting.updateContentScripts([script]);
      else await browser.scripting.registerContentScripts([script]);
      const tabs = await browser.tabs.query({});
      await Promise.allSettled(
        tabs.map(async (tab) => {
          if (tab.id === undefined) return;
          let enabled = false;
          if (tab.url) {
            try {
              enabled = await this.permitted(tab.url);
            } catch {
              /* Treat inaccessible documents as disabled. */
            }
          }
          if (!enabled) {
            await browser.tabs
              .sendMessage(
                tab.id,
                { protocolVersion: 1, type: 'page.automatic', enabled: false },
                { frameId: 0 },
              )
              .catch(() => undefined);
            return;
          }
          // Verify the current document and reuse a live controller before injection.
          const documents = await browser.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [0] },
            func: () => undefined,
          });
          const documentId = documents[0]?.documentId;
          if (!documentId) return;
          let ready = false;
          try {
            const reply = await browser.tabs.sendMessage(
              tab.id,
              { protocolVersion: 1, type: 'page.probe' },
              { documentId, frameId: 0 },
            );
            ready = reply?.ok === true && reply?.type === 'page.ready';
          } catch {
            /* New document. */
          }
          if (!ready)
            await browser.scripting.executeScript({
              target: { tabId: tab.id, documentIds: [documentId] },
              files: ['/content-scripts/translator.js'],
            });
          await browser.tabs.sendMessage(
            tab.id,
            { protocolVersion: 1, type: 'page.automatic', enabled: true },
            { documentId, frameId: 0 },
          );
        }),
      );
    });
  }
}
