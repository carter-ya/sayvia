import { matchesHostOrigin } from './permission-revocation';
import { browser } from 'wxt/browser';
import { SiteRequest, siteOrigin } from '../runtime/site-access';
import type { ConfigRepository } from '../storage/repository';

const SCRIPT_ID = 'sayvia-selection-v1';
const pattern = (origin: string) => `${origin}/*`;
export class SiteAccess {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly repository: ConfigRepository) {}
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const work = this.queue.then(run);
    this.queue = work.catch(() => undefined);
    return work;
  }
  async permitted(origin: string) {
    const canonical = siteOrigin(origin);
    return (
      (await this.repository.siteOrigins()).includes(canonical) &&
      (await browser.permissions.contains({ origins: [pattern(canonical)] }))
    );
  }
  reconcile(removed: string[] = []) {
    return this.serial(async () => {
      const revokedIntent = (await this.repository.siteOrigins()).filter((origin) =>
        removed.some((pattern) => matchesHostOrigin(pattern, origin)),
      );
      if (revokedIntent.length) await this.repository.removeSites(revokedIntent);
      const saved = await this.repository.siteOrigins();
      const matches: string[] = [];
      const revoked: string[] = [];
      for (const origin of saved) {
        if (await browser.permissions.contains({ origins: [pattern(origin)] }))
          matches.push(pattern(origin));
        else revoked.push(origin);
      }
      // Forget revoked intent, so a later API grant cannot silently enable web capture.
      if (revoked.length) await this.repository.removeSites(revoked);
      const registered = await browser.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
      if (!matches.length) {
        if (registered.length)
          await browser.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      } else {
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
      }
      const tabs = await browser.tabs.query({});
      await Promise.allSettled(
        tabs.map(async (tab) => {
          if (tab.id === undefined || !tab.url) return;
          let enabled: boolean;
          try {
            enabled = matches.includes(pattern(siteOrigin(tab.url)));
          } catch {
            return;
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
  async view() {
    const sites = await this.repository.siteOrigins();
    const scripts = await browser.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    return {
      sites: await Promise.all(
        sites.map(async (origin) => ({
          origin,
          active:
            Boolean(scripts[0]?.matches?.includes(pattern(origin))) &&
            (await this.permitted(origin)),
        })),
      ),
    };
  }
  async handle(message: unknown) {
    const parsed = SiteRequest.safeParse(message);
    if (!parsed.success) return { ok: false, error: 'INVALID_REQUEST' };
    try {
      if (parsed.data.type === 'settings.sites.set') {
        const { origin, enabled, expectedRevision } = parsed.data.payload;
        if (enabled && !(await browser.permissions.contains({ origins: [pattern(origin)] })))
          return { ok: false, error: 'PERMISSION_REQUIRED' };
        await this.repository.setSite(origin, enabled, expectedRevision);
      }
      await this.reconcile();
      return { ok: true, data: await this.view(), config: await this.repository.snapshot() };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error && ['CONFLICT', 'SITE_LIMIT'].includes(error.message)
            ? error.message
            : 'SITE_UNAVAILABLE',
      };
    }
  }
}
