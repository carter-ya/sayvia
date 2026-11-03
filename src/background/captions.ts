import { browser } from 'wxt/browser';
import { CaptionAccess, CAPTURE_SETTING_KEY, type CaptionOwner } from './caption-access';
import type { TaskBroker } from './task-broker';
import { pageOwner, type MessageSender } from './task-router';
import { CaptionRequestSchema } from '../runtime/caption-protocol';
import { watchVideoId, YOUTUBE_ORIGIN } from '../captions/player';

const PREFIX = 'sayvia-youtube-';
const MAIN = `${PREFIX}capture-v1`;
const ISOLATED = `${PREFIX}controller-v1`;
const MATCH = `${YOUTUBE_ORIGIN}/*`;
const DEADLINE = 2000;
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('CAPTION_UNREACHABLE')), DEADLINE);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function installCaptions(broker: Pick<TaskBroker, 'cancelWhere'>) {
  const known = new Map<number, string>();
  const ensuring = new Map<string, Promise<boolean>>();
  const injections = new Map<string, number>();
  const permitted = () => bounded(browser.permissions.contains({ origins: [MATCH] }));
  const active = () => {
    const status = access.status();
    return status.desiredEnabled && status.registered && !status.error;
  };
  async function current(owner: CaptionOwner) {
    if (!(await permitted())) return;
    const result = await bounded(
      browser.scripting.executeScript({
        target: { tabId: owner.tabId, documentIds: [owner.documentId] },
        func: () => location.href,
      }),
    );
    const exact = result.find((item) => item.documentId === owner.documentId && item.frameId === 0);
    return typeof exact?.result === 'string' ? watchVideoId(exact.result) : undefined;
  }
  async function stopDocument(tabId: number, documentId: string) {
    // Browser-delivered acknowledgement, not an untrusted page bridge message.
    const stopped = await bounded(
      browser.scripting.executeScript({
        target: { tabId, documentIds: [documentId] },
        world: 'MAIN',
        func: () => {
          const capture = (
            globalThis as typeof globalThis & {
              __sayviaCapture?: { stop(): void; active(): boolean };
            }
          ).__sayviaCapture;
          capture?.stop();
          return !capture?.active();
        },
      }),
    );
    if (!stopped.some((item) => item.documentId === documentId && item.result === true))
      throw new Error('CAPTION_UNREACHABLE');
    const reply = await bounded(
      browser.tabs.sendMessage(
        tabId,
        { protocolVersion: 1, type: 'captions.disabled' },
        { documentId, frameId: 0 },
      ),
    ).catch(() => undefined);
    if (reply?.ok !== true) {
      const checked = await bounded(
        browser.scripting.executeScript({
          target: { tabId, documentIds: [documentId] },
          func: () =>
            !(globalThis as typeof globalThis & { __sayviaCaptionController?: unknown })
              .__sayviaCaptionController,
        }),
      );
      if (!checked.some((item) => item.documentId === documentId && item.result === true))
        throw new Error('CAPTION_UNREACHABLE');
    }
  }
  async function inject(tabId: number, documentId: string, world: 'MAIN' | 'ISOLATED') {
    const key = `${tabId}:${documentId}`;
    if (injections.size >= 68 && !injections.has(key)) throw new Error('CAPTION_LIMIT');
    injections.set(key, (injections.get(key) ?? 0) + 1);
    // The browser's operation can finish after our reply deadline. Keep its real
    // promise alive and compensate when capture was disabled in the meantime.
    const actual = browser.scripting
      .executeScript({
        target: { tabId, documentIds: [documentId] },
        world,
        files:
          world === 'MAIN'
            ? ['/content-scripts/youtube-capture.js']
            : ['/content-scripts/youtube-controller.js'],
      })
      .then(async () => {
        if (!active()) await stopDocument(tabId, documentId);
      })
      .finally(() => {
        const count = (injections.get(key) ?? 1) - 1;
        if (count) injections.set(key, count);
        else injections.delete(key);
      });
    await bounded(actual);
  }
  async function ensureMain(owner: CaptionOwner) {
    const key = `${owner.tabId}:${owner.documentId}`;
    if (ensuring.has(key)) return ensuring.get(key)!;
    if (ensuring.size >= 64) return false;
    const work = (async () => {
      if (!(await access.enabledFor(owner))) return false;
      await inject(owner.tabId, owner.documentId, 'MAIN');
      return access.enabledFor(owner);
    })().finally(() => ensuring.delete(key));
    ensuring.set(key, work);
    return work;
  }
  const access = new CaptionAccess({
    read: async () => (await browser.storage.local.get(CAPTURE_SETTING_KEY))[CAPTURE_SETTING_KEY],
    write: (enabled) => browser.storage.local.set({ [CAPTURE_SETTING_KEY]: enabled }),
    async register(enabled) {
      // Registration mutations stay on CaptionAccess's serial queue until the
      // browser actually finishes. A timeout must never let a late persistent
      // registration run behind a completed unregister.
      const registered = await bounded(browser.scripting.getRegisteredContentScripts());
      const own = registered.filter((script) => script.id.startsWith(PREFIX));
      const obsolete = own.filter((script) => !enabled || ![MAIN, ISOLATED].includes(script.id));
      if (obsolete.length)
        await browser.scripting.unregisterContentScripts({
          ids: obsolete.map((script) => script.id),
        });
      if (!enabled) return;
      if (!(await permitted())) throw new Error('PERMISSION_DENIED');
      for (const [id, world, file] of [
        [MAIN, 'MAIN', 'youtube-capture'],
        [ISOLATED, 'ISOLATED', 'youtube-controller'],
      ] as const) {
        const script = {
          id,
          world,
          js: [`content-scripts/${file}.js`],
          matches: [MATCH],
          allFrames: false,
          runAt: 'document_start' as const,
          persistAcrossSessions: true,
        };
        if (own.some((item) => item.id === id))
          await browser.scripting.updateContentScripts([script]);
        else await browser.scripting.registerContentScripts([script]);
      }
    },
    async cleanup(enabled) {
      const tabs = await bounded(browser.tabs.query({ url: [MATCH] }));
      const targets = new Map(known);
      let unconfirmed = Math.max(0, tabs.length - 256);
      for (const tab of tabs.slice(0, 256))
        if (tab.id !== undefined && !targets.has(tab.id)) targets.set(tab.id, '');
      const entries = [...targets];
      // At most four concurrent browser calls, with a deadline on each document.
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, entries.length) }, async () => {
          while (cursor < entries.length) {
            const [tabId, previous] = entries[cursor++]!;
            try {
              let documentId = previous;
              if (!documentId || enabled) {
                const docs = await bounded(
                  browser.scripting.executeScript({
                    target: { tabId, frameIds: [0] },
                    func: () => location.origin,
                  }),
                );
                const doc = docs.find(
                  (item) => item.frameId === 0 && item.result === YOUTUBE_ORIGIN,
                );
                if (!doc?.documentId) continue;
                documentId = doc.documentId;
              }
              if (known.size < 256 || known.has(tabId)) known.set(tabId, documentId);
              if (enabled && active() && (await permitted())) {
                await inject(tabId, documentId, 'MAIN');
                if (!active()) throw new Error('CAPTION_DISABLED');
                await inject(tabId, documentId, 'ISOLATED');
              } else {
                await stopDocument(tabId, documentId);
                if (injections.has(`${tabId}:${documentId}`))
                  throw new Error('CAPTION_INJECTION_PENDING');
              }
            } catch {
              unconfirmed++;
            }
          }
        }),
      );
      return unconfirmed;
    },
    current,
    cancel: (owner) =>
      broker.cancelWhere(
        (route) =>
          route.purpose === 'captions' &&
          (!owner ||
            (route.tabId === owner.tabId &&
              route.documentId === owner.documentId &&
              route.documentNonce === owner.documentNonce)),
      ),
  });
  async function handle(message: unknown, sender: MessageSender) {
    const parsed = CaptionRequestSchema.safeParse(message);
    if (!parsed.success) return { ok: false, error: 'INVALID_REQUEST' };
    const request = parsed.data;
    if (request.type === 'captions.settings.read' || request.type === 'captions.settings.set') {
      if (
        sender.id !== browser.runtime.id ||
        sender.origin !== new URL(browser.runtime.getURL('/')).origin ||
        sender.url?.split(/[?#]/)[0] !== browser.runtime.getURL('/options.html')
      )
        return { ok: false, error: 'FORBIDDEN' };
      await access.ready;
      return {
        ok: true,
        data:
          request.type === 'captions.settings.set'
            ? await access.setEnabled(request.enabled)
            : access.status(),
      };
    }
    const candidate = pageOwner(sender, request.documentNonce, browser.runtime.id);
    if (!candidate || candidate.siteOrigin !== YOUTUBE_ORIGIN || !candidate.documentId)
      return { ok: false, error: 'FORBIDDEN' };
    const owner = candidate as CaptionOwner;
    if (known.size < 256 || known.has(owner.tabId)) known.set(owner.tabId, owner.documentId);
    if (request.type === 'captions.revoke') {
      await access.revoke(owner);
      return { ok: true };
    }
    await access.ready;
    if (request.type === 'captions.ensure') return { ok: true, enabled: await ensureMain(owner) };
    if (request.type === 'captions.check')
      return {
        ok: true,
        enabled: await access.enabledFor(owner),
        authorized: request.session ? await access.authorized(owner, request.session) : false,
      };
    return {
      ok: true,
      session: await access.grant(
        owner,
        request.track,
        request.captureGeneration,
        request.previousSessionId,
      ),
    };
  }
  browser.runtime.onMessage.addListener((message, sender, respond) => {
    if (typeof message?.type !== 'string' || !message.type.startsWith('captions.')) return;
    void handle(message, sender).then(respond, () =>
      respond({ ok: false, error: 'CAPTION_UNAVAILABLE' }),
    );
    return true;
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    known.delete(tabId);
    void access.revokeTab(tabId).catch(() => undefined);
  });
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' || info.url) {
      known.delete(tabId);
      void access.revokeTab(tabId).catch(() => undefined);
    }
  });
  browser.permissions.onRemoved.addListener(() => {
    void access.revoke().catch(() => undefined);
    void access.reconcile();
  });
  browser.permissions.onAdded.addListener(() => {
    void access.reconcile();
  });
  return access;
}
