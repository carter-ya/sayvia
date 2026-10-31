import { browser } from 'wxt/browser';
import { z } from 'zod';
import {
  EXECUTOR_PORT,
  type Execution,
  type ExecutionView,
  type ExecutorCommand,
} from '../runtime/executor-protocol';

type Port = ReturnType<typeof browser.runtime.connect>;
const Identity = z.object({ epoch: z.uuid(), token: z.uuid() }).strict();
type Identity = z.infer<typeof Identity>;
const ROOT = 'sayvia.executor';
const CONNECTION_MS = 3000;
const unavailable = () => new Error('EXECUTOR_UNAVAILABLE');

export class ExecutorHost {
  private connection: { port: Port; identity: Identity } | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<
    string,
    {
      resolve(data: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private waiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  constructor(
    private readonly ready: Promise<unknown>,
    private readonly changed: (epoch: string, taskId?: string) => void,
    private readonly api: typeof browser = browser,
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(work);
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  private async contexts() {
    return this.api.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [this.api.runtime.getURL('/offscreen.html')],
    });
  }
  accept(port: Port) {
    if (
      port.name !== EXECUTOR_PORT ||
      port.sender?.id !== this.api.runtime.id ||
      port.sender.tab ||
      port.sender.url !== this.api.runtime.getURL('/offscreen.html')
    )
      return;
    port.onDisconnect.addListener(() => {
      if (this.connection?.port !== port) return;
      const epoch = this.connection.identity.epoch;
      this.connection = undefined;
      this.changed(epoch);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(unavailable());
      }
      this.pending.clear();
    });
    port.onMessage.addListener((message: unknown) => {
      const parsed = z
        .object({
          protocolVersion: z.literal(1),
          type: z.enum(['executor.hello', 'executor.reply', 'executor.changed']),
          epoch: z.uuid(),
          requestId: z.uuid().optional(),
          taskId: z.uuid().optional(),
          data: z.unknown().optional(),
        })
        .strict()
        .safeParse(message);
      if (!parsed.success) return;
      const value = parsed.data;
      if (value.type === 'executor.hello') {
        void this.bind(port, value.epoch).catch(() => port.disconnect());
        return;
      }
      if (this.connection?.port !== port || this.connection.identity.epoch !== value.epoch) return;
      if (value.type === 'executor.changed') {
        this.changed(value.epoch, value.taskId);
        return;
      }
      const pending = value.requestId ? this.pending.get(value.requestId) : undefined;
      if (!pending) return;
      this.pending.delete(value.requestId!);
      clearTimeout(pending.timer);
      pending.resolve(value.data);
    });
  }
  private async bind(port: Port, epoch: string) {
    await this.ready;
    const contexts = await this.contexts();
    if (
      contexts.length !== 1 ||
      (port.sender?.documentId !== undefined && contexts[0]!.documentId !== port.sender.documentId)
    )
      throw unavailable();
    const stored = Identity.safeParse((await this.api.storage.session.get(ROOT))[ROOT]);
    const identity =
      stored.success && stored.data.epoch === epoch
        ? stored.data
        : { epoch, token: crypto.randomUUID() };
    await this.api.storage.session.set({ [ROOT]: identity });
    this.connection = { port, identity };
    await this.send({ type: 'bind' });
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
  }
  private async connect(create: boolean) {
    await this.ready;
    const contexts = await this.contexts();
    if (!contexts.length && !create) throw unavailable();
    if (contexts.length && this.connection) return this.connection.identity;
    const connected = new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject,
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(unavailable());
      }, CONNECTION_MS);
      this.waiters.add(waiter);
    });
    // Attach rejection handling before createDocument/sendMessage can fail.
    void connected.catch(() => undefined);
    if (!contexts.length) {
      await this.api.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Parse translation source and validate model output in dedicated Workers.',
      });
    } else {
      await this.api.runtime.sendMessage({ protocolVersion: 1, type: 'executor.connect' });
    }
    await connected;
    if (!this.connection) throw unavailable();
    return this.connection.identity;
  }
  private send(command: ExecutorCommand['command']) {
    const connection = this.connection;
    if (!connection) return Promise.reject(unavailable());
    const requestId = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(unavailable());
      }, CONNECTION_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        connection.port.postMessage({
          protocolVersion: 1,
          requestId,
          ...connection.identity,
          command,
        });
      } catch {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(unavailable());
      }
    });
  }
  start(prepare: (epoch: string) => Promise<Execution>) {
    return this.serial(async () => {
      const identity = await this.connect(true);
      const execution = await prepare(identity.epoch);
      // A lost START ACK is never retried. Recovery uses query only.
      return (await this.send({ type: 'start', execution })) as ExecutionView;
    });
  }
  task(type: 'query' | 'cancel' | 'ack', taskId: string, epoch: string) {
    return this.serial(async () => {
      const identity = await this.connect(false);
      if (identity.epoch !== epoch) throw unavailable();
      return (await this.send({ type, taskId })) as ExecutionView;
    });
  }
  closeIfIdle() {
    return this.serial(async () => {
      if (!(await this.contexts()).length) return;
      await this.connect(false);
      const state = (await this.send({ type: 'inspect' })) as {
        active: number;
        pendingResults: number;
      };
      if (state.active || state.pendingResults) return;
      await this.api.offscreen.closeDocument();
      this.connection = undefined;
      await this.api.storage.session.remove(ROOT);
    });
  }
}
