import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  ConnectionTestView,
  type ConnectionIdentity,
  type ConnectionView,
} from '../runtime/connection-test';
import { userError } from '../runtime/user-errors';
import type { ConfigSnapshot } from '../storage/schema';

export function useConnectionTest(provider?: ConfigSnapshot['providers'][number]) {
  const [status, setStatus] = useState('尚未测试连接');
  const [running, setRunning] = useState(false);
  const active = useRef<ConnectionIdentity | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = () => {
    clearTimeout(timer.current);
    const identity = active.current;
    active.current = undefined;
    if (identity)
      void browser.runtime
        .sendMessage({ type: 'settings.test.cancel', payload: identity })
        .catch(() => undefined);
  };
  useEffect(() => cancel, []);
  function invalidate() {
    cancel();
    setRunning(false);
    setStatus('配置已修改，保存后重新测试');
  }
  async function run() {
    if (!provider || active.current) return;
    const identity: ConnectionIdentity = {
      providerId: provider.id,
      providerRevision: provider.revision,
      clientTaskId: crypto.randomUUID(),
      documentNonce: crypto.randomUUID(),
    };
    active.current = identity;
    setRunning(true);
    setStatus('正在测试连接…');
    async function step(action: 'start' | 'status') {
      if (active.current !== identity) return;
      try {
        const response = await browser.runtime.sendMessage({
          type: `settings.test.${action}`,
          payload: identity,
        });
        if (active.current !== identity) return;
        if (!response?.ok) throw new Error(response?.error ?? 'CONTEXT_LOST');
        const result = ConnectionTestView.parse(response.data);
        if (
          result.providerId !== identity.providerId ||
          result.providerRevision !== identity.providerRevision ||
          result.clientTaskId !== identity.clientTaskId
        )
          throw new Error('CONTEXT_LOST');
        if (result.state === 'running') {
          timer.current = setTimeout(() => void step('status'), 400);
          return;
        }
        active.current = undefined;
        setRunning(false);
        const labels: Partial<Record<ConnectionView['state'], string>> = {
          passed: '连接可用',
          canceled: '测试已取消',
          stale: '配置已变化，请重新测试',
        };
        setStatus(labels[result.state] ?? userError(result.error));
      } catch (error) {
        if (active.current !== identity) return;
        cancel();
        setRunning(false);
        setStatus(
          error instanceof Error && error.message === 'CONFLICT'
            ? '配置已变化，请重新载入后测试'
            : userError(error),
        );
      }
    }
    await step('start');
  }
  return {
    status,
    running,
    run,
    invalidate,
    stop() {
      cancel();
      setRunning(false);
      setStatus('测试已取消');
    },
  };
}
