import {
  ProgressSchema,
  ResultMetricsSchema,
  TranslationResultSchema,
  type TranslationProgress,
} from '../runtime/translation-progress';
import type { ConfigRepository } from '../storage/repository';
import type { Execution, ExecutionView } from '../runtime/executor-protocol';
import type { StartPayload, TaskMessage, TaskRoute, TaskSession } from '../runtime/task-protocol';
import type { ExecutorHost } from './executor-host';
import type { TaskStorage } from './task-storage';
import type { ManualSavePayload } from '../runtime/manual-draft';
import { matchesHostOrigin } from './permission-revocation';
import { LearningResultSchema, type LearningStart } from '../runtime/learning-protocol';
import { CaptionIdentitySchema } from '../core/learning-contract';
import type { z } from 'zod';

const DEDUP_MS = 300_000;
const ACTIVE = new Set(['running', 'ready']);
const occupiesSlot = (route: TaskRoute) => ACTIVE.has(route.state) || route.cancelPending === true;
export interface TaskOwner {
  tabId: number;
  frameId: 0;
  documentId?: string;
  documentNonce: string;
  kind: 'page' | 'manual';
  siteOrigin?: string;
}
export interface TaskPlatform {
  notify?(route: TaskRoute): Promise<void>;
  progress?(route: TaskRoute, progress: TranslationProgress): Promise<void>;
  sitePermitted?(origin: string): Promise<boolean>;
  permitted(baseUrl: string): Promise<boolean>;
  captionAuthorized?(
    owner: TaskOwner,
    identity: z.infer<typeof CaptionIdentitySchema>,
  ): Promise<boolean>;
  deliver(
    route: TaskRoute,
    result: NonNullable<ExecutionView['result']>,
    canApply: boolean,
  ): Promise<boolean>;
}
type Host = Pick<ExecutorHost, 'start' | 'task' | 'closeIfIdle'>;
const ERRORS = new Set([
  'SITE_DISABLED',
  'CONFIG_REQUIRED',
  'CONFLICT',
  'PERMISSION_DENIED',
  'TASK_BUSY',
  'FORBIDDEN',
  'EXECUTOR_UNAVAILABLE',
]);

export class TaskBroker {
  readonly ready: Promise<void>;
  private state!: TaskSession;
  private progress = new Map<string, TranslationProgress>();
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
    this.state.manualGeneration ??= crypto.randomUUID();
    for (const route of this.state.routes) {
      route.recovered = true;
      // A recovered background must not resume a page's continuous paid caption session.
      if (route.purpose === 'captions' && occupiesSlot(route)) await this.cancelRoute(route);
    }
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
    for (const id of this.progress.keys())
      if (!this.state.routes.some((r) => r.taskId === id && r.state === 'running'))
        this.progress.delete(id);
    this.state.routes = this.state.routes.filter(
      (route) => occupiesSlot(route) || route.expiresAt > Date.now(),
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
      ...(route.purpose ? { purpose: route.purpose } : {}),
      startedAt: route.startedAt,
      ...(route.state === 'running' && this.progress.has(route.taskId)
        ? { progress: this.progress.get(route.taskId) }
        : {}),
      canApply:
        (route.purpose ?? 'translate') === 'translate' &&
        route.mode === 'write' &&
        !route.recovered &&
        route.state === 'delivered',
      provider: { id: route.providerId, revision: route.providerRevision, model: route.model },
      ...(route.error ? { error: route.error } : {}),
    };
  }
  async handle(
    request: Exclude<TaskMessage, { type: 'translation.manual.read' }>,
    owner: TaskOwner,
    expectedProviderRevision?: number,
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
        if (request.type === 'translation.start' || request.type === 'learning.start') {
          if (route) return { ok: true, data: this.view(route) };
          if (this.state.canceled.some((entry) => entry.key === this.key(owner, clientTaskId)))
            return { ok: true, data: { clientTaskId, state: 'canceled', canApply: false } };
          route = await this.start(request.payload, owner, expectedProviderRevision);
        } else if (route && occupiesSlot(route)) await this.refresh(route);
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
  private async start(
    payload: StartPayload | LearningStart,
    owner: TaskOwner,
    expectedProviderRevision?: number,
  ) {
    const learning = 'purpose' in payload ? payload : undefined;
    const legacy = 'mode' in payload ? payload : undefined;
    const purpose = learning?.purpose ?? 'translate';
    const mode = legacy?.mode ?? (learning?.origin === 'manual' ? 'manual' : 'read');
    const entry = legacy?.entry ?? (learning?.origin === 'page' ? 'inline' : undefined);
    const manualRevision = 'manualRevision' in payload ? payload.manualRevision : undefined;
    const manualGeneration = 'manualGeneration' in payload ? payload.manualGeneration : undefined;
    const captionIdentity =
      learning?.purpose === 'captions'
        ? CaptionIdentitySchema.parse({
            sessionId: learning.input.sessionId,
            generation: learning.input.generation,
            videoId: learning.input.videoId,
            trackKey: learning.input.trackKey,
            batchId: learning.input.batchId,
          })
        : undefined;
    if ((owner.kind === 'manual') !== (mode === 'manual')) throw new Error('FORBIDDEN');
    const checkSite = async () => {
      if (
        entry === 'inline' &&
        (!owner.siteOrigin || !(await this.platform.sitePermitted?.(owner.siteOrigin)))
      )
        throw new Error('SITE_DISABLED');
      if (
        captionIdentity &&
        (owner.kind !== 'page' ||
          owner.siteOrigin !== 'https://www.youtube.com' ||
          !(await this.platform.captionAuthorized?.(owner, captionIdentity)))
      )
        throw new Error('FORBIDDEN');
    };
    await checkSite();
    if (purpose !== 'captions') {
      for (const route of this.state.routes.filter(
        (route) =>
          route.tabId === owner.tabId && route.purpose === 'captions' && occupiesSlot(route),
      )) {
        // Do not open a second paid request if cancel acknowledgement is lost.
        const stopped = await this.host.task('cancel', route.taskId, route.epoch);
        if (
          stopped.taskId !== route.taskId ||
          stopped.state === 'running' ||
          stopped.state === 'ready'
        )
          throw new Error('EXECUTOR_UNAVAILABLE');
        await this.cancelRoute(route, false);
      }
    }
    const active = this.state.routes.filter(occupiesSlot);
    if (
      this.state.routes.length >= 256 ||
      active.some((route) => route.tabId === owner.tabId) ||
      active.length >= 4
    )
      throw new Error('TASK_BUSY');
    const priorManual = this.state.manual.find((draft) => draft.tabId === owner.tabId);
    if (
      mode === 'manual' &&
      manualRevision !== undefined &&
      (manualRevision !== (priorManual?.revision ?? 0) ||
        manualGeneration !== this.state.manualGeneration)
    )
      throw new Error('CONFLICT');
    const provider = await this.repository.completionConfig(payload.providerId);
    if (
      expectedProviderRevision !== undefined &&
      provider.providerRevision !== expectedProviderRevision
    )
      throw new Error('CONFLICT');
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
        await checkSite();
        const startedAt = Date.now();
        route = {
          taskId: crypto.randomUUID(),
          clientTaskId: payload.clientTaskId,
          documentNonce: owner.documentNonce,
          tabId: owner.tabId,
          frameId: 0,
          ...(owner.documentId ? { documentId: owner.documentId } : {}),
          mode,
          ...(learning ? { purpose: learning.purpose } : {}),
          ...(captionIdentity ? { captionIdentity } : {}),
          ...(entry ? { entry: entry } : {}),
          apiOrigin: new URL(provider.config.baseUrl).origin,
          ...(owner.siteOrigin ? { siteOrigin: owner.siteOrigin } : {}),
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
        if (mode === 'manual') {
          this.state.manual = this.state.manual.filter((value) => value.tabId !== owner.tabId);
          this.state.manual.push({
            tabId: owner.tabId,
            clientTaskId: payload.clientTaskId,
            documentNonce: owner.documentNonce,
            input:
              legacy?.source.text ?? (learning?.purpose === 'lookup' ? learning.input.text : ''),
            ...(purpose === 'lookup' ? { purpose: 'lookup' as const } : {}),
            targetLanguage:
              legacy?.targetLanguage ??
              (learning?.purpose === 'lookup' ? learning.input.explanationLanguage : ''),
            sourceLanguage: legacy?.sourceLanguage ?? learning?.input.sourceLanguage ?? 'auto',
            ...(payload.providerId ? { providerId: payload.providerId } : {}),
            revision: (priorManual?.revision ?? 0) + 1,
          });
        }
        await this.persist();
        const base = {
          taskId: route.taskId,
          deadlineAt: route.deadlineAt,
          config: provider.config,
        };
        if (learning)
          return learning.purpose === 'lookup'
            ? ({ ...base, purpose: 'lookup', input: learning.input } satisfies Execution)
            : ({ ...base, purpose: 'captions', input: learning.input } satisfies Execution);
        if (!legacy) throw new Error('FORBIDDEN');
        return {
          ...base,
          source: legacy.source,
          sourceLanguage: legacy.sourceLanguage,
          targetLanguage: legacy.targetLanguage,
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
    if (route.cancelPending) {
      await this.cancelRoute(route);
      return;
    }
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
    if (outcome.state === 'running') {
      const parsed = ProgressSchema.safeParse(outcome.progress);
      if (parsed.success) {
        const previous = this.progress.get(route.taskId);
        if (!previous || parsed.data.elapsedMs > previous.elapsedMs) {
          this.progress.set(route.taskId, parsed.data);
          if (route.mode !== 'manual')
            await this.platform.progress?.(route, parsed.data).catch(() => undefined);
        }
      }
      return;
    }
    this.progress.delete(route.taskId);
    if (outcome.error) route.error = outcome.error;
    if (outcome.state !== 'ready') {
      await this.notify(route);
      return;
    }
    if (!outcome.result) {
      route.state = 'interrupted';
      route.error = 'CONTEXT_LOST';
      return;
    }
    const learningResult = LearningResultSchema.safeParse(outcome.result);
    const translationResult = TranslationResultSchema.safeParse(outcome.result);
    const purpose = route.purpose ?? 'translate';
    const result =
      purpose === 'translate'
        ? translationResult.success
          ? translationResult.data
          : undefined
        : learningResult.success && learningResult.data.data.purpose === purpose
          ? learningResult.data
          : undefined;
    if (!result) {
      route.state = 'failed';
      route.error = 'FORMAT_INVALID';
      await this.notify(route);
      return;
    }
    if (purpose === 'captions') {
      const identity = route.captionIdentity;
      const owner: TaskOwner = {
        tabId: route.tabId,
        frameId: route.frameId,
        documentNonce: route.documentNonce,
        kind: 'page',
        ...(route.documentId ? { documentId: route.documentId } : {}),
        ...(route.siteOrigin ? { siteOrigin: route.siteOrigin } : {}),
      };
      if (
        !identity ||
        !learningResult.success ||
        learningResult.data.data.purpose !== 'captions' ||
        Object.entries(identity).some(
          ([key, value]) =>
            learningResult.data.data.purpose === 'captions' &&
            learningResult.data.data.value[key as keyof typeof identity] !== value,
        ) ||
        !(await this.platform.captionAuthorized?.(owner, identity))
      ) {
        await this.cancelRoute(route);
        return;
      }
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
      if (
        purpose === 'lookup' &&
        learningResult.success &&
        learningResult.data.data.purpose === 'lookup' &&
        draft.purpose === 'lookup'
      ) {
        draft.lookupResult = learningResult.data.data.value;
        delete draft.result;
      } else if (
        purpose === 'translate' &&
        translationResult.success &&
        draft.purpose !== 'lookup'
      ) {
        draft.result = translationResult.data.text;
        delete draft.lookupResult;
      } else {
        await this.cancelRoute(route);
        return;
      }
      draft.metrics = ResultMetricsSchema.parse({
        requested: result.requested,
        durationMs: result.durationMs,
        streamed: result.streamed,
        usage: result.usage,
        estimates: result.estimates,
      });
      draft.revision = (draft.revision ?? 0) + 1;
    } else if (
      !(await this.platform.deliver(
        route,
        result,
        (route.purpose ?? 'translate') === 'translate' &&
          route.mode === 'write' &&
          !route.recovered,
      ))
    ) {
      await this.cancelRoute(route);
      if (!route.cancelPending) {
        route.state = 'interrupted';
        route.error = 'CONTEXT_LOST';
      }
      return;
    }
    route.state = 'delivered';
    await this.persist();
    await this.host.task('ack', route.taskId, route.epoch).catch(() => undefined);
  }
  private notify(route: TaskRoute) {
    return (this.platform.notify?.(route) ?? Promise.resolve()).catch(() => undefined);
  }
  private async cancelRoute(route: TaskRoute, cancelExecution = true) {
    const wasActive = occupiesSlot(route);
    this.progress.delete(route.taskId);
    route.state = 'canceled';
    route.error = 'CANCELED';
    route.recovered = true;
    if (route.purpose === 'captions' && wasActive && cancelExecution) route.cancelPending = true;
    else delete route.cancelPending;
    try {
      await this.persist();
    } finally {
      if (wasActive && cancelExecution) {
        const stopped = await this.host
          .task('cancel', route.taskId, route.epoch)
          .catch(() => undefined);
        if (stopped && stopped.taskId === route.taskId && !ACTIVE.has(stopped.state)) {
          delete route.cancelPending;
          await this.persist();
        }
      }
    }
    const draft = this.state.manual.find(
      (value) => value.clientTaskId === route.clientTaskId && value.tabId === route.tabId,
    );
    if (draft) {
      delete draft.result;
      delete draft.lookupResult;
    }
    await this.notify(route);
  }
  private async reconcileRoutes(progressOnly = false) {
    const before = JSON.stringify(this.state);
    for (const route of this.state.routes) if (occupiesSlot(route)) await this.refresh(route);
    if (!progressOnly || JSON.stringify(this.state) !== before) await this.persist();
    if (!this.state.routes.some(occupiesSlot)) await this.closeIdle();
  }
  reconcile(progressOnly = false) {
    return this.serial(() => this.reconcileRoutes(progressOnly));
  }
  private closeIdle() {
    return this.host.closeIfIdle().catch(() => undefined);
  }
  cancelWhere(predicate: (route: TaskRoute) => boolean | Promise<boolean>, removedTab?: number) {
    return this.serial(async () => {
      for (const route of this.state.routes)
        if (await predicate(route)) await this.cancelRoute(route);
      if (removedTab !== undefined)
        this.state.manual = this.state.manual.filter((value) => value.tabId !== removedTab);
      await this.persist();
      await this.closeIdle();
    });
  }
  cancelRevokedOrigins(origins: readonly string[]) {
    return this.cancelWhere(async (route) => {
      if (!occupiesSlot(route)) return false;
      const siteRevoked =
        route.mode !== 'manual' &&
        route.siteOrigin &&
        origins.some((pattern) => matchesHostOrigin(pattern, route.siteOrigin!));
      if (siteRevoked) return true;
      if (!origins.some((pattern) => matchesHostOrigin(pattern, route.apiOrigin))) return false;
      return !(await this.platform.permitted(route.apiOrigin).catch(() => false));
    });
  }
  clearAll<T>(clearConfiguration: () => Promise<T>) {
    return this.serial(async () => {
      // Hold the dispatch lock while deleting keys and canceling their captured tasks.
      const result = await clearConfiguration();
      for (const route of this.state.routes) {
        await this.cancelRoute(route).catch(() => undefined);
      }
      this.state = {
        version: 1,
        // Keep only body-free cancellation fences until their old executor has stopped.
        routes: this.state.routes.filter((route) => route.cancelPending),
        canceled: [],
        manual: [],
        manualGeneration: crypto.randomUUID(),
      };
      // A failed final write must surface as a failure, never a successful clear.
      try {
        await this.persist();
      } finally {
        await this.closeIdle();
      }
      return result;
    });
  }

  manualGeneration() {
    return this.serial(async () => this.state.manualGeneration!);
  }

  saveManual(value: ManualSavePayload) {
    return this.serial(async () => {
      if (value.generation !== this.state.manualGeneration) throw new Error('CONFLICT');
      const current = this.state.manual.find((draft) => draft.tabId === value.tabId);
      if (
        this.state.routes.some(
          (route) =>
            route.tabId === value.tabId && route.mode === 'manual' && ACTIVE.has(route.state),
        )
      )
        throw new Error('TASK_BUSY');
      const sameLease =
        current?.editSession === value.editSession &&
        current.editBaseRevision === value.expectedRevision;
      if (!sameLease && (current?.revision ?? 0) !== value.expectedRevision)
        throw new Error('CONFLICT');
      if (sameLease && value.sequence <= (current?.editSequence ?? -1))
        return { revision: current!.revision ?? 0 };
      if (!current && this.state.manual.length >= 256) throw new Error('TASK_BUSY');
      const purpose = value.purpose ?? 'translate';
      const purposeChanged = (current?.purpose ?? 'translate') !== purpose;
      const sameLookupInput =
        purpose === 'lookup' &&
        !purposeChanged &&
        current?.input === value.input &&
        current.sourceLanguage === (value.sourceLanguage ?? 'auto') &&
        current.targetLanguage === value.targetLanguage &&
        current.providerId === value.providerId;
      const next = {
        tabId: value.tabId,
        clientTaskId: (!purposeChanged && current?.clientTaskId) || crypto.randomUUID(),
        documentNonce: current?.documentNonce ?? crypto.randomUUID(),
        input: value.input,
        ...(value.purpose === 'lookup'
          ? {
              purpose: 'lookup' as const,
              ...(sameLookupInput && current?.lookupResult
                ? { lookupResult: current.lookupResult }
                : {}),
            }
          : { result: value.result }),
        targetLanguage: value.targetLanguage,
        sourceLanguage: value.sourceLanguage ?? 'auto',
        ...(value.providerId ? { providerId: value.providerId } : {}),
        revision: (current?.revision ?? 0) + 1,
        editSession: value.editSession,
        editSequence: value.sequence,
        editBaseRevision: value.expectedRevision,
      };
      const before = this.state.manual;
      this.state.manual = [...before.filter((draft) => draft.tabId !== value.tabId), next];
      try {
        await this.persist();
      } catch (error) {
        this.state.manual = before;
        throw error;
      }
      return { revision: next.revision };
    });
  }

  readPopup(tabId: number) {
    return this.serial(async () => ({
      data: await this.repository.snapshot(),
      generation: this.state.manualGeneration!,
      draft: await this.manualView(tabId),
    }));
  }

  readManual(tabId: number) {
    return this.serial(() => this.manualView(tabId));
  }
  private async manualView(tabId: number) {
    const draft = this.state.manual.find((value) => value.tabId === tabId);
    const route =
      draft &&
      this.state.routes.find(
        (value) => value.clientTaskId === draft.clientTaskId && value.tabId === tabId,
      );
    if (route && ACTIVE.has(route.state)) {
      const before = JSON.stringify(this.state);
      await this.refresh(route);
      if (JSON.stringify(this.state) !== before) await this.persist();
      if (!ACTIVE.has(route.state)) await this.closeIdle();
    }
    if (!draft) return null;
    const view = structuredClone(draft);
    delete view.editSession;
    delete view.editSequence;
    delete view.editBaseRevision;
    return {
      ...view,
      revision: draft.revision ?? 0,
      ...(route ? { task: this.view(route) } : {}),
    };
  }
}
