import type { ConfigRepository } from '../storage/repository';
import type { Execution, ExecutionView } from '../runtime/executor-protocol';
import type { StartPayload, TaskMessage, TaskRoute, TaskSession } from '../runtime/task-protocol';
import type { ExecutorHost } from './executor-host';
import type { TaskStorage } from './task-storage';

const DEDUP_MS = 300_000;
const ACTIVE = new Set(['running', 'ready']);
export interface TaskOwner {
  tabId: number;
  frameId: 0;
  documentId?: string;
  documentNonce: string;
  kind: 'page' | 'manual';
}
export interface TaskPlatform {
  notify?(route: TaskRoute): Promise<void>;
  permitted(baseUrl: string): Promise<boolean>;
  deliver(
    route: TaskRoute,
    result: NonNullable<ExecutionView['result']>,
    canApply: boolean,
  ): Promise<boolean>;
}
type Host = Pick<ExecutorHost, 'start' | 'task' | 'closeIfIdle'>;
const ERRORS = new Set([
  'CONFIG_REQUIRED',
  'PERMISSION_DENIED',
  'TASK_BUSY',
  'FORBIDDEN',
  'EXECUTOR_UNAVAILABLE',
]);

export class TaskBroker {
  readonly ready: Promise<void>;
  private state!: TaskSession;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly storage: TaskStorage,
    private readonly repository: Pick<ConfigRepository, 'completionConfig' | 'snapshot'>,
    private readonly host: Host,
    private readonly platform: TaskPlatform,
  ) {
    this.ready = this.initialize();
  }

  private async initialize() {
    this.state = await this.storage.read();
    for (const route of this.state.routes) route.recovered = true;
    this.prune();
    await this.reconcileRoutes();
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      await this.ready;
      this.prune();
      return work();
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  private persist() {
    return this.storage.write(structuredClone(this.state));
  }
  private prune() {
    this.state.routes = this.state.routes.filter(
      (route) => ACTIVE.has(route.state) || route.expiresAt > Date.now(),
    );
    this.state.canceled = this.state.canceled.filter((entry) => entry.expiresAt > Date.now());
  }
  private key(owner: TaskOwner, clientTaskId: string) {
    return `${owner.kind}:${owner.tabId}:${owner.documentId ?? ''}:${owner.documentNonce}:${clientTaskId}`;
  }
  private owns(route: TaskRoute, owner: TaskOwner) {
    return (
      route.tabId === owner.tabId &&
      route.frameId === owner.frameId &&
      route.documentNonce === owner.documentNonce &&
      (owner.kind === 'manual'
        ? route.mode === 'manual'
        : route.mode !== 'manual' && route.documentId === owner.documentId)
    );
  }
  private view(route: TaskRoute) {
    return {
      taskId: route.taskId,
      clientTaskId: route.clientTaskId,
      documentNonce: route.documentNonce,
      state: route.state,
      canApply: route.mode === 'write' && !route.recovered && route.state === 'delivered',
      provider: { id: route.providerId, revision: route.providerRevision, model: route.model },
      ...(route.error ? { error: route.error } : {}),
    };
  }
  async handle(
    request: Exclude<TaskMessage, { type: 'translation.manual.read' }>,
    owner: TaskOwner,
  ) {
    try {
      return await this.serial(async () => {
        const { clientTaskId } = request.payload;
        let route = this.state.routes.find(
          (route) => route.clientTaskId === clientTaskId && this.owns(route, owner),
        );
        if (request.type === 'translation.cancel') {
          if (route) await this.cancelRoute(route);
          else {
            const key = this.key(owner, clientTaskId);
            if (!this.state.canceled.some((entry) => entry.key === key)) {
              if (this.state.canceled.length >= 256) throw new Error('TASK_BUSY');
              this.state.canceled.push({ key, expiresAt: Date.now() + DEDUP_MS });
            }
          }
          await this.persist();
          await this.closeIdle();
          return {
            ok: true,
            data: route ? this.view(route) : { clientTaskId, state: 'canceled', canApply: false },
          };
        }
        if (request.type === 'translation.start') {
          if (route) return { ok: true, data: this.view(route) };
          if (this.state.canceled.some((entry) => entry.key === this.key(owner, clientTaskId)))
            return { ok: true, data: { clientTaskId, state: 'canceled', canApply: false } };
          route = await this.start(request.payload, owner);
        } else if (route && ACTIVE.has(route.state)) await this.refresh(route);
        if (!route) return { ok: false, error: 'NOT_FOUND' };
        await this.persist();
        await this.closeIdle();
        return { ok: true, data: this.view(route) };
      });
    } catch (error) {
      await this.closeIdle();
      return {
        ok: false,
        error:
          error instanceof Error && ERRORS.has(error.message)
            ? error.message
            : 'RUNTIME_UNAVAILABLE',
      };
    }
  }
  private async start(payload: StartPayload, owner: TaskOwner) {
    if ((owner.kind === 'manual') !== (payload.mode === 'manual')) throw new Error('FORBIDDEN');
    const active = this.state.routes.filter((route) => ACTIVE.has(route.state));
    if (
      this.state.routes.length >= 256 ||
      active.some((route) => route.tabId === owner.tabId) ||
      active.length >= 4
    )
      throw new Error('TASK_BUSY');
    const provider = await this.repository.completionConfig(payload.providerId);
    if (!(await this.platform.permitted(provider.config.baseUrl)))
      throw new Error('PERMISSION_DENIED');
    let route: TaskRoute | undefined;
    try {
      const outcome = await this.host.start(async (epoch) => {
        if (
          !(await this.repository.snapshot()).providers.some(
            (value) => value.id === provider.providerId,
          )
        )
          throw new Error('CONFIG_REQUIRED');
        if (!(await this.platform.permitted(provider.config.baseUrl)))
          throw new Error('PERMISSION_DENIED');
        const startedAt = Date.now();
        route = {
          taskId: crypto.randomUUID(),
          clientTaskId: payload.clientTaskId,
          documentNonce: owner.documentNonce,
          tabId: owner.tabId,
          frameId: 0,
          ...(owner.documentId ? { documentId: owner.documentId } : {}),
          mode: payload.mode,
          epoch,
          providerId: provider.providerId,
          providerRevision: provider.providerRevision,
          model: provider.model,
          startedAt,
          deadlineAt: startedAt + 60_000,
          expiresAt: startedAt + DEDUP_MS,
          state: 'running',
          recovered: false,
        };
        this.state.routes.push(route);
        if (payload.mode === 'manual') {
          this.state.manual = this.state.manual.filter((value) => value.tabId !== owner.tabId);
          this.state.manual.push({
            tabId: owner.tabId,
            clientTaskId: payload.clientTaskId,
            documentNonce: owner.documentNonce,
            input: payload.source.text,
          });
        }
        await this.persist();
        return {
          taskId: route.taskId,
          deadlineAt: route.deadlineAt,
          config: provider.config,
          source: payload.source,
          sourceLanguage: payload.sourceLanguage,
          targetLanguage: payload.targetLanguage,
        } satisfies Execution;
      });
      if (!route) throw new Error('EXECUTOR_UNAVAILABLE');
      await this.applyOutcome(route, outcome);
    } catch (error) {
      if (!route) throw error;
      // Dispatch may have succeeded even if ACK was lost: query only, never replay START.
      route.recovered = true;
      await this.refresh(route);
    }
    return route;
  }
  private async refresh(route: TaskRoute) {
    try {
      const outcome = await this.host.task('query', route.taskId, route.epoch);
      await this.applyOutcome(route, outcome);
    } catch {
      route.state = 'interrupted';
      route.recovered = true;
      route.error = 'CONTEXT_LOST';
      await this.notify(route);
    }
  }
  private async applyOutcome(route: TaskRoute, outcome: ExecutionView) {
    if (!ACTIVE.has(route.state)) return;
    if (outcome.state === 'missing') {
      route.state = 'interrupted';
      route.error = 'CONTEXT_LOST';
      await this.notify(route);
      return;
    }
    if (outcome.state === 'running' && Date.now() >= route.deadlineAt) {
      await this.host.task('cancel', route.taskId, route.epoch).catch(() => undefined);
      route.state = 'timedOut';
      route.error = 'TIMEOUT';
      await this.notify(route);
      return;
    }
    route.state = outcome.state;
    if (outcome.error) route.error = outcome.error;
    if (outcome.state !== 'ready') {
      if (outcome.state !== 'running') await this.notify(route);
      return;
    }
    if (!outcome.result) {
      route.state = 'interrupted';
      route.error = 'CONTEXT_LOST';
      return;
    }
    await this.persist();
    if (route.mode === 'manual') {
      const draft = this.state.manual.find(
        (value) => value.tabId === route.tabId && value.clientTaskId === route.clientTaskId,
      );
      if (!draft) {
        await this.cancelRoute(route);
        return;
      }
      draft.result = outcome.result.text;
    } else if (
      !(await this.platform.deliver(
        route,
        outcome.result,
        route.mode === 'write' && !route.recovered,
      ))
    ) {
      await this.cancelRoute(route);
      route.state = 'interrupted';
      route.error = 'CONTEXT_LOST';
      return;
    }
    route.state = 'delivered';
    await this.persist();
    await this.host.task('ack', route.taskId, route.epoch).catch(() => undefined);
  }
  private notify(route: TaskRoute) {
    return (this.platform.notify?.(route) ?? Promise.resolve()).catch(() => undefined);
  }
  private async cancelRoute(route: TaskRoute) {
    const wasActive = ACTIVE.has(route.state);
    route.state = 'canceled';
    route.error = 'CANCELED';
    route.recovered = true;
    try {
      await this.persist();
    } finally {
      if (wasActive)
        await this.host.task('cancel', route.taskId, route.epoch).catch(() => undefined);
    }
    const draft = this.state.manual.find(
      (value) => value.clientTaskId === route.clientTaskId && value.tabId === route.tabId,
    );
    if (draft) delete draft.result;
    await this.notify(route);
  }
  private async reconcileRoutes() {
    for (const route of this.state.routes) if (ACTIVE.has(route.state)) await this.refresh(route);
    await this.persist();
    await this.closeIdle();
  }
  reconcile() {
    return this.serial(() => this.reconcileRoutes());
  }
  private closeIdle() {
    return this.host.closeIfIdle().catch(() => undefined);
  }
  cancelWhere(predicate: (route: TaskRoute) => boolean, removedTab?: number) {
    return this.serial(async () => {
      for (const route of this.state.routes) if (predicate(route)) await this.cancelRoute(route);
      if (removedTab !== undefined)
        this.state.manual = this.state.manual.filter((value) => value.tabId !== removedTab);
      await this.persist();
      await this.closeIdle();
    });
  }
  readManual(tabId: number) {
    return this.serial(async () => {
      const draft = this.state.manual.find((value) => value.tabId === tabId);
      const route =
        draft &&
        this.state.routes.find(
          (value) => value.clientTaskId === draft.clientTaskId && value.tabId === tabId,
        );
      if (route && ACTIVE.has(route.state)) {
        await this.refresh(route);
        await this.persist();
        await this.closeIdle();
      }
      return draft
        ? { ...structuredClone(draft), ...(route ? { task: this.view(route) } : {}) }
        : null;
    });
  }
}
