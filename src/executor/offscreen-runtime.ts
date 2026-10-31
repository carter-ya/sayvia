import { browser } from 'wxt/browser';
import { EXECUTOR_PORT, ExecutorCommandSchema } from '../runtime/executor-protocol';
import { TaskRunner } from './task-runner';

export function startOffscreenRuntime() {
  const epoch = crypto.randomUUID();
  let token: string | undefined;
  let port: ReturnType<typeof browser.runtime.connect> | undefined;
  const wake = () => {
    void browser.runtime
      .sendMessage({ protocolVersion: 1, type: 'executor.changed', epoch })
      .catch(() => undefined);
  };
  const notify = (taskId: string) => {
    if (!token) return;
    try {
      if (!port) {
        wake();
        return;
      }
      port.postMessage({ protocolVersion: 1, type: 'executor.changed', epoch, taskId });
    } catch {
      port = undefined;
      wake();
    }
  };
  const runner = new TaskRunner(notify);
  const connect = () => {
    if (port) return;
    const current = browser.runtime.connect({ name: EXECUTOR_PORT });
    port = current;
    current.onDisconnect.addListener(() => {
      if (port === current) port = undefined;
    });
    current.onMessage.addListener((message: unknown) => {
      const parsed = ExecutorCommandSchema.safeParse(message);
      if (!parsed.success) return;
      const request = parsed.data;
      if (request.epoch !== epoch || (token && request.token !== token)) return;
      if (!token && request.command.type !== 'bind') return;
      token ??= request.token;
      const command = request.command;
      const data =
        command.type === 'start'
          ? runner.start(command.execution)
          : command.type === 'query'
            ? runner.query(command.taskId)
            : command.type === 'cancel'
              ? runner.cancel(command.taskId)
              : command.type === 'ack'
                ? runner.acknowledge(command.taskId)
                : runner.inspect();
      current.postMessage({
        protocolVersion: 1,
        type: 'executor.reply',
        epoch,
        requestId: request.requestId,
        data,
      });
    });
    current.postMessage({ protocolVersion: 1, type: 'executor.hello', epoch });
  };
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      sender.id !== browser.runtime.id ||
      sender.tab ||
      sender.url !== browser.runtime.getURL('/background.js')
    )
      return;
    if (message?.protocolVersion !== 1 || message?.type !== 'executor.connect') return;
    connect();
    sendResponse({ ok: true, epoch });
  });
  window.addEventListener(
    'pagehide',
    () => {
      runner.dispose();
      port?.disconnect();
    },
    { once: true },
  );
  connect();
  return { epoch };
}
