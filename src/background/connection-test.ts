import { browser } from 'wxt/browser';
import {
  ConnectionTestRequest,
  type ConnectionIdentity,
  type ConnectionView,
} from '../runtime/connection-test';
import type { ConfigRepository } from '../storage/repository';
import type { TaskBroker, TaskOwner } from './task-broker';
import type { MessageSender } from './task-router';

// A fixed public sample, never the user's page, editor or draft.
const SAMPLE = { kind: 'plain-text' as const, text: 'Hello from Sayvia.' };
const view = (identity: ConnectionIdentity, state: ConnectionView['state'], error?: string) => ({
  ok: true as const,
  data: {
    providerId: identity.providerId,
    providerRevision: identity.providerRevision,
    clientTaskId: identity.clientTaskId,
    state,
    ...(error ? { error } : {}),
  },
});
export async function handleConnectionTest(
  message: unknown,
  sender: MessageSender,
  repository: Pick<ConfigRepository, 'snapshot'>,
  broker: Pick<TaskBroker, 'handle' | 'readManual'>,
) {
  if (
    sender.id !== browser.runtime.id ||
    sender.origin !== new URL(browser.runtime.getURL('/')).origin ||
    sender.url?.split(/[?#]/)[0] !== browser.runtime.getURL('/options.html') ||
    sender.tab?.id === undefined
  )
    return { ok: false, error: 'FORBIDDEN' };
  const parsed = ConnectionTestRequest.safeParse(message);
  if (!parsed.success) return { ok: false, error: 'INVALID_REQUEST' };
  const { type, payload } = parsed.data;
  const owner: TaskOwner = {
    tabId: sender.tab.id,
    frameId: 0,
    documentNonce: payload.documentNonce,
    kind: 'manual',
  };
  const cancel = () =>
    broker.handle(
      {
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        type: 'translation.cancel',
        payload: { clientTaskId: payload.clientTaskId, documentNonce: payload.documentNonce },
      },
      owner,
    );
  try {
    if (type === 'settings.test.cancel') {
      const result = await cancel();
      return result.ok ? view(payload, 'canceled') : { ok: false, error: result.error };
    }
    const provider = (await repository.snapshot()).providers.find(
      (p) => p.id === payload.providerId,
    );
    if (!provider || provider.revision !== payload.providerRevision) {
      if (type === 'settings.test.start') return { ok: false, error: 'CONFLICT' };
      await cancel();
      return view(payload, 'stale');
    }
    if (type === 'settings.test.start') {
      const result = await broker.handle(
        {
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          type: 'translation.start',
          payload: {
            clientTaskId: payload.clientTaskId,
            documentNonce: payload.documentNonce,
            providerId: payload.providerId,
            mode: 'manual',
            scope: 'full',
            source: SAMPLE,
            sourceLanguage: 'auto',
            targetLanguage: 'zh-Hans',
          },
        },
        owner,
        payload.providerRevision,
      );
      if (!result.ok) return { ok: false, error: result.error };
      // A cancel-before-start tombstone may have won the race.
      if (result.data?.state === 'canceled') return view(payload, 'canceled');
    }
    const draft = await broker.readManual(sender.tab.id);
    if (
      !draft ||
      draft.clientTaskId !== payload.clientTaskId ||
      draft.documentNonce !== payload.documentNonce ||
      !draft.task ||
      draft.task.provider.id !== payload.providerId ||
      draft.task.provider.revision !== payload.providerRevision
    )
      return { ok: false, error: 'NOT_FOUND' };
    // A save during dispatch invalidates the old conclusion without replacing its key snapshot.
    const latest = (await repository.snapshot()).providers.find((p) => p.id === payload.providerId);
    if (!latest || latest.revision !== payload.providerRevision) {
      await cancel();
      return view(payload, 'stale');
    }
    if (draft.task.state === 'delivered' && draft.result?.trim()) return view(payload, 'passed');
    if (['running', 'ready'].includes(draft.task.state)) return view(payload, 'running');
    if (draft.task.state === 'canceled') return view(payload, 'canceled');
    return view(payload, 'failed', draft.task.error ?? 'CONTEXT_LOST');
  } catch {
    return { ok: false, error: 'RUNTIME_UNAVAILABLE' };
  }
}
