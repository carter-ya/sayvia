import { z } from 'zod';
import { browser } from 'wxt/browser';
import { normalizeBaseUrl } from '../providers/endpoint';
import type { ConfigRepository } from '../storage/repository';
import type { ExecutorHost } from './executor-host';
import { pageOwner, permissionPattern, type MessageSender } from './task-router';
import type { SiteAccess } from './site-access';

const Request = z
  .object({
    protocolVersion: z.literal(1),
    type: z.literal('model.warmup'),
    providerId: z.uuid().optional(),
  })
  .strict();

export async function handleModelWarmup(
  message: unknown,
  sender: MessageSender,
  repository: Pick<ConfigRepository, 'snapshot'>,
  host: Pick<ExecutorHost, 'warmup'>,
  sites: Pick<SiteAccess, 'permitted'>,
) {
  const parsed = Request.safeParse(message);
  if (!parsed.success) return { ok: false };
  const popup =
    sender.id === browser.runtime.id &&
    sender.origin === new URL(browser.runtime.getURL('/')).origin &&
    sender.url?.split(/[?#]/)[0] === browser.runtime.getURL('/popup.html');
  const owner = pageOwner(sender, crypto.randomUUID(), browser.runtime.id);
  if (!popup && !owner?.siteOrigin) return { ok: false };
  try {
    if (!popup && !(await sites.permitted(owner!.siteOrigin!))) return { ok: false };
    const snapshot = await repository.snapshot();
    const id = parsed.data.providerId ?? snapshot.preferences.defaultProviderId;
    const provider = snapshot.providers.find((p) => p.id === id);
    if (!provider?.hasApiKey) return { ok: false };
    const baseUrl = normalizeBaseUrl(provider.baseUrl);
    if (!(await browser.permissions.contains({ origins: [permissionPattern(baseUrl)] })))
      return { ok: false };
    // Only saved configuration supplies the destination; no URL, Key or source from the page.
    await host.warmup(new URL(baseUrl).origin);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
