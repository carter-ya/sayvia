import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { SnapshotSchema, type ConfigSnapshot } from '../storage/schema';
import type { ManualDraftView } from '../runtime/manual-draft';
import type { TranslationProgress, ResultMetrics } from '../runtime/translation-progress';
import { userError } from '../runtime/user-errors';

type Fields = {
  input: string;
  result: string;
  targetLanguage: string;
  sourceLanguage: string;
  providerId: string;
};
type StartingTask = { clientTaskId: string; documentNonce: string; canceled: boolean };
type Context = {
  tabId: number;
  generation: string;
  revision: number;
  baseRevision: number;
  editSession: string;
  sequence: number;
};
const initial: Fields = {
  input: '',
  result: '',
  targetLanguage: 'en',
  sourceLanguage: 'auto',
  providerId: '',
};
const message = (type: string, payload: unknown) => ({
  protocolVersion: 1,
  requestId: crypto.randomUUID(),
  type,
  payload,
});
async function send(type: string, payload: unknown) {
  const reply = (await browser.runtime.sendMessage(message(type, payload))) as {
    ok?: boolean;
    data?: ManualDraftView | null;
    error?: string;
  };
  if (!reply?.ok) throw new Error(reply?.error ?? 'CONTEXT_LOST');
  return reply.data;
}
const errorText = (error: unknown) =>
  error instanceof Error && error.message === 'CONFLICT'
    ? '草稿已在其他窗口修改或清除。当前文字已保留，请复制后重新打开弹窗。'
    : userError(error);
export function useManualTranslation() {
  const [fields, setFields] = useState<Fields>(initial);
  const [config, setConfig] = useState<ConfigSnapshot>();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<TranslationProgress>();
  const [metrics, setMetrics] = useState<ResultMetrics>();
  const [startedAt, setStartedAt] = useState<number>();
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [hostname, setHostname] = useState('当前标签页');
  const [model, setModel] = useState('');
  const [siteEnabled, setSiteEnabled] = useState(false);
  const values = useRef(fields);
  const context = useRef<Context | undefined>(undefined);
  const targetTab = useRef<number | undefined>(undefined);
  const draft = useRef<ManualDraftView | null>(null);
  const pending = useRef(new Set<Promise<unknown>>());
  const mounted = useRef(false);
  const locked = useRef(false);
  const running = useRef(false);
  const dispatching = useRef(false);
  const startingTask = useRef<StartingTask | null>(null);
  const epoch = useRef(0);
  function accept(next: ManualDraftView | null, resetLease: boolean) {
    draft.current = next;
    const active = ['running', 'ready'].includes(next?.task?.state ?? '');
    running.current = active;
    setBusy(active);
    setProgress(active ? next?.task?.progress : undefined);
    setMetrics(next?.metrics);
    setStartedAt(next?.task?.startedAt);
    if (next && context.current) {
      context.current.revision = next.revision ?? 0;
      if (resetLease) {
        context.current.baseRevision = next.revision ?? 0;
        context.current.editSession = crypto.randomUUID();
        context.current.sequence = 0;
      }
      const value = {
        input: next.input,
        result: next.result ?? '',
        targetLanguage: next.targetLanguage ?? values.current.targetLanguage,
        sourceLanguage: next.sourceLanguage ?? 'auto',
        providerId: next.providerId ?? values.current.providerId,
      };
      values.current = value;
      setFields(value);
      setModel(next.task?.provider?.model ?? '');
      if (next.task?.error) setStatus(userError(next.task.error));
      else if (active) setStatus('正在翻译，可以关闭弹窗，稍后回来查看。');
      else if (next.result) setStatus('译文已就绪，可编辑或复制。');
    }
  }
  useEffect(() => {
    mounted.current = true;
    async function load() {
      const currentEpoch = ++epoch.current;
      context.current = undefined;
      locked.current = false;
      setReady(false);
      setStatus('');
      try {
        const tab =
          targetTab.current === undefined
            ? (await browser.tabs.query({ active: true, currentWindow: true }))[0]
            : await browser.tabs.get(targetTab.current);
        if (tab?.id === undefined) throw new Error('CONTEXT_LOST');
        targetTab.current = tab.id;
        const reply = (await browser.runtime.sendMessage({
          type: 'popup.context',
          tabId: tab.id,
        })) as {
          ok?: boolean;
          data?: unknown;
          generation?: string;
          draft?: ManualDraftView | null;
          siteEnabled?: boolean;
        };
        const saved = reply?.draft;
        if (!mounted.current || currentEpoch !== epoch.current) return;
        if (!reply?.ok || !reply.generation) throw new Error('CONTEXT_LOST');
        const snapshot = SnapshotSchema.parse(reply.data);
        setConfig(snapshot);
        setSiteEnabled(reply.siteEnabled === true);
        document.documentElement.style.colorScheme =
          snapshot.preferences.theme === 'system' ? 'light dark' : snapshot.preferences.theme;
        const defaults = {
          ...initial,
          targetLanguage: snapshot.preferences.writeTarget,
          providerId: snapshot.preferences.defaultProviderId ?? '',
        };
        values.current = defaults;
        setFields(defaults);
        context.current = {
          tabId: tab.id,
          generation: reply.generation,
          revision: saved?.revision ?? 0,
          baseRevision: saved?.revision ?? 0,
          editSession: crypto.randomUUID(),
          sequence: 0,
        };
        try {
          setHostname(new URL(tab.url ?? '').hostname || '当前标签页');
        } catch {
          setHostname('当前标签页');
        }
        accept(saved ?? null, false);
        setReady(true);
      } catch (error) {
        if (mounted.current && currentEpoch === epoch.current) setStatus(errorText(error));
      }
    }
    void load();
    const cleared: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
      message,
      sender,
    ) => {
      if (
        sender.id !== browser.runtime.id ||
        sender.url !== browser.runtime.getURL('/background.js') ||
        message?.type !== 'app.data-cleared'
      )
        return;
      values.current = initial;
      setFields(initial);
      draft.current = null;
      startingTask.current = null;
      dispatching.current = false;
      setModel('');
      setProgress(undefined);
      setMetrics(undefined);
      setStartedAt(undefined);
      running.current = false;
      setBusy(false);
      void load();
    };
    browser.runtime.onMessage.addListener(cleared);
    return () => {
      mounted.current = false;
      ++epoch.current;
      browser.runtime.onMessage.removeListener(cleared);
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const currentEpoch = epoch.current;
    const poll = async () => {
      if (dispatching.current) {
        timer = setTimeout(() => void poll(), 400);
        return;
      }
      try {
        const ctx = context.current;
        if (!ctx) return;
        const next = await send('translation.manual.read', { tabId: ctx.tabId });
        if (!active || currentEpoch !== epoch.current) return;
        accept(next ?? null, true);
        if (running.current) timer = setTimeout(() => void poll(), 400);
      } catch (error) {
        if (active && currentEpoch === epoch.current) {
          locked.current = true;
          running.current = false;
          setBusy(false);
          setStatus(errorText(error));
        }
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [busy]);
  function update(patch: Partial<Fields>) {
    if (!ready || running.current) return;
    const next = { ...values.current, ...patch };
    if (
      patch.input !== undefined ||
      patch.targetLanguage !== undefined ||
      patch.sourceLanguage !== undefined ||
      patch.providerId !== undefined
    )
      next.result = '';
    values.current = next;
    setFields(next);
    setProgress(undefined);
    setMetrics(undefined);
    if (patch.result === undefined) setModel('');
    setStatus('草稿仅保存在本次浏览器会话，可继续翻译或复制。');
    if ([...next.input].length > 12_000) {
      setStatus('原文超过 12,000 字符，超出部分尚未保存，请缩小范围。');
      return;
    }
    const ctx = context.current;
    if (!ctx || locked.current) return;
    const sequence = ++ctx.sequence,
      currentEpoch = epoch.current;
    setSaving(true);
    // Dispatch every change now: popup closure cannot strand a debounce or a JS save queue.
    const operation = browser.runtime
      .sendMessage(
        message('translation.manual.save', {
          generation: ctx.generation,
          tabId: ctx.tabId,
          input: next.input,
          result: next.result,
          targetLanguage: next.targetLanguage,
          sourceLanguage: next.sourceLanguage,
          ...(next.providerId ? { providerId: next.providerId } : {}),
          editSession: ctx.editSession,
          sequence,
          expectedRevision: ctx.baseRevision,
        }),
      )
      .then((reply: { ok?: boolean; data?: { revision: number }; error?: string }) => {
        if (!reply?.ok) throw new Error(reply?.error ?? 'CONTEXT_LOST');
        if (mounted.current && currentEpoch === epoch.current && context.current === ctx)
          ctx.revision = Math.max(ctx.revision, reply.data?.revision ?? 0);
      })
      .catch((error) => {
        if (mounted.current && currentEpoch === epoch.current) {
          locked.current = true;
          setStatus(errorText(error));
        }
      })
      .finally(() => {
        pending.current.delete(operation);
        if (mounted.current && !pending.current.size) setSaving(false);
      });
    pending.current.add(operation);
  }
  async function translate() {
    const ctx = context.current;
    if (!ready || !ctx || running.current || dispatching.current || locked.current) return;
    const attempt: StartingTask = {
      clientTaskId: crypto.randomUUID(),
      documentNonce: crypto.randomUUID(),
      canceled: false,
    };
    startingTask.current = attempt;
    running.current = true;
    dispatching.current = true;
    setBusy(true);
    setStartedAt(Date.now());
    setProgress(undefined);
    setMetrics(undefined);
    setStatus('正在翻译…');
    const currentEpoch = epoch.current;
    let accepted = false;
    try {
      await Promise.all(pending.current);
      if (
        attempt.canceled ||
        locked.current ||
        context.current !== ctx ||
        epoch.current !== currentEpoch
      )
        return;
      const value = values.current;
      await send('translation.start', {
        tabId: ctx.tabId,
        clientTaskId: attempt.clientTaskId,
        documentNonce: attempt.documentNonce,
        mode: 'manual',
        scope: 'full',
        source: { kind: 'plain-text', text: value.input },
        sourceLanguage: value.sourceLanguage,
        targetLanguage: value.targetLanguage,
        ...(value.providerId ? { providerId: value.providerId } : {}),
        manualRevision: ctx.revision,
        manualGeneration: ctx.generation,
      });
      if (attempt.canceled) return;
      const saved = await send('translation.manual.read', { tabId: ctx.tabId });
      if (!attempt.canceled && mounted.current && currentEpoch === epoch.current) {
        accept(saved ?? null, true);
        accepted = true;
      }
    } catch (error) {
      if (!attempt.canceled && mounted.current && currentEpoch === epoch.current) {
        if (error instanceof Error && error.message === 'CONFLICT') locked.current = true;
        running.current = false;
        setBusy(false);
        setStatus(errorText(error));
      }
    } finally {
      if (startingTask.current === attempt) {
        startingTask.current = null;
        dispatching.current = false;
      }
      if (!accepted && currentEpoch === epoch.current && mounted.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function cancel() {
    const ctx = context.current,
      saved = startingTask.current ?? draft.current;
    if (!ctx || !saved) return;
    if (startingTask.current) startingTask.current.canceled = true;
    const currentEpoch = epoch.current;
    try {
      await send('translation.cancel', {
        tabId: ctx.tabId,
        clientTaskId: saved.clientTaskId,
        documentNonce: saved.documentNonce,
      });
      const refreshed = await send('translation.manual.read', { tabId: ctx.tabId });
      if (!mounted.current || currentEpoch !== epoch.current) return;
      accept(refreshed ?? null, true);
      // Keep the form locked until the outstanding start reply settles.
      if (dispatching.current) setBusy(true);
      setStatus(userError('CANCELED'));
    } catch (error) {
      if (mounted.current && currentEpoch === epoch.current) setStatus(errorText(error));
    }
  }
  return {
    fields,
    config,
    ready,
    busy,
    saving,
    progress,
    metrics,
    startedAt,
    status,
    hostname,
    model,
    update,
    translate,
    cancel,
    setStatus,
    tabId: context.current?.tabId,
    siteEnabled,
    blocked: locked.current,
  };
}
