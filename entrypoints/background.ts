import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { SiteAccess } from '../src/background/site-access';
import { handlePageMessage } from '../src/background/page-router';
import { handleConnectionTest } from '../src/background/connection-test';
import { handleSettings } from '../src/background/settings-router';
import { chromeConfigStorage } from '../src/storage/chrome-storage';
import { ConfigRepository } from '../src/storage/repository';
import { ExecutorHost } from '../src/background/executor-host';
import { TaskBroker } from '../src/background/task-broker';
import { taskStorage } from '../src/background/task-storage';
import {
  handleTaskMessage,
  isOffscreenSender,
  permissionPattern,
} from '../src/background/task-router';

export default defineBackground(() => {
  const repository = new ConfigRepository(chromeConfigStorage);
  const sites = new SiteAccess(repository);
  void sites.reconcile().catch(() => undefined);
  browser.permissions.onAdded.addListener(() => {
    void sites.reconcile().catch(() => undefined);
  });
  const sessionReady = browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  void repository.ready.catch(() => undefined);
  void sessionReady.catch(() => undefined);
  const host = new ExecutorHost(Promise.all([repository.ready, sessionReady]), () => {
    void broker.reconcile().catch(() => undefined);
  });
  const broker = new TaskBroker(taskStorage, repository, host, {
    sitePermitted: (origin) => sites.permitted(origin),
    permitted: (baseUrl) => browser.permissions.contains({ origins: [permissionPattern(baseUrl)] }),
    async notify(route) {
      if (route.mode === 'manual' || !route.documentId) return;
      await browser.tabs
        .sendMessage(
          route.tabId,
          {
            protocolVersion: 1,
            type: 'translation.state',
            taskId: route.taskId,
            clientTaskId: route.clientTaskId,
            documentNonce: route.documentNonce,
            state: route.state,
            error: route.error,
          },
          { documentId: route.documentId, frameId: route.frameId },
        )
        .catch(() => undefined);
    },
    async deliver(route, result, canApply) {
      if (!route.documentId) return false;
      try {
        const receipt = (await browser.tabs.sendMessage(
          route.tabId,
          {
            protocolVersion: 1,
            type: 'translation.result',
            taskId: route.taskId,
            clientTaskId: route.clientTaskId,
            documentNonce: route.documentNonce,
            result,
            canApply: canApply && route.mode === 'write',
            provider: {
              id: route.providerId,
              revision: route.providerRevision,
              model: route.model,
            },
          },
          { documentId: route.documentId, frameId: route.frameId },
        )) as { taskId?: string; documentNonce?: string } | undefined;
        return receipt?.taskId === route.taskId && receipt.documentNonce === route.documentNonce;
      } catch {
        return false;
      }
    },
  });
  void broker.ready.catch(() => undefined);
  browser.runtime.onConnect.addListener((port) => host.accept(port));
  browser.tabs.onRemoved.addListener((tabId) => {
    void broker.cancelWhere((route) => route.tabId === tabId, tabId).catch(() => undefined);
  });
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading' || info.url)
      void broker.cancelWhere((route) => route.tabId === tabId, tabId).catch(() => undefined);
  });
  browser.permissions.onRemoved.addListener((removed) => {
    void sites.reconcile(removed.origins ?? []).catch(() => undefined);
    void broker.cancelRevokedOrigins(removed.origins ?? []).catch(() => undefined);
  });
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (typeof message !== 'object' || message === null) return;
    if (typeof message.type === 'string' && message.type.startsWith('page.')) {
      void handlePageMessage(message, sender, repository, sites).then(sendResponse);
      return true;
    }
    if (typeof message.type === 'string' && message.type.startsWith('translation.')) {
      void handleTaskMessage(message, sender, broker).then(sendResponse, () =>
        sendResponse({ ok: false, error: 'RUNTIME_UNAVAILABLE' }),
      );
      return true;
    }
    if (
      message.protocolVersion === 1 &&
      message.type === 'executor.changed' &&
      isOffscreenSender(sender)
    ) {
      void broker.reconcile().then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    if (
      sender.id !== browser.runtime.id ||
      sender.origin !== new URL(browser.runtime.getURL('/')).origin
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
    if (message.type.startsWith('settings.sites.')) {
      void sites
        .handle(message)
        .then(async (result) => {
          if (result.ok)
            await broker.cancelWhere(
              async (route) =>
                route.entry === 'inline' &&
                Boolean(route.siteOrigin) &&
                !(await sites.permitted(route.siteOrigin!)),
            );
          return result;
        })
        .then(sendResponse, () => sendResponse({ ok: false, error: 'SITE_UNAVAILABLE' }));
      return true;
    }
    if (message.type.startsWith('settings.test.')) {
      void handleConnectionTest(message, sender, repository, broker).then(sendResponse);
      return true;
    }
    void handleSettings(message, repository, broker)
      .then(async (result) => {
        if (result.ok && message.type === 'settings.delete')
          await broker.cancelWhere((route) => route.providerId === message.payload.id);
        if (result.ok && message.type === 'settings.clear') {
          await sites.reconcile();
          const tabs = await browser.tabs.query({});
          await Promise.allSettled(
            tabs
              .filter((tab) => tab.id !== undefined)
              .map((tab) =>
                browser.tabs.sendMessage(
                  tab.id!,
                  { protocolVersion: 1, type: 'page.reset' },
                  { frameId: 0 },
                ),
              ),
          );
          void browser.runtime.sendMessage({ type: 'app.data-cleared' }).catch(() => undefined);
        }
        return result;
      })
      .then(sendResponse, () =>
        sendResponse({
          ok: false,
          error: message.type === 'settings.clear' ? 'CLEAR_INCOMPLETE' : 'CONFIG_UNAVAILABLE',
        }),
      );
    return true;
  });
});
