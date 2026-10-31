import { translate, EXECUTION_BUDGET_MS, ProviderError } from '../providers/chat-completions';
import type { TranslationProcessor } from '../core/translation-processor';
import { type Execution, type ExecutionView } from '../runtime/executor-protocol';
import { WorkerProcessor } from './worker-processor';

export const RESULT_TTL_MS = 30_000;
export const DEDUP_TTL_MS = 300_000;
export const MAX_EXECUTIONS = 4;
const MAX_RECORDS = 512;
type Entry = {
  view: ExecutionView;
  expiresAt: number;
  controller?: AbortController;
  processor?: TranslationProcessor;
  timer?: ReturnType<typeof setTimeout>;
};

export class TaskRunner {
  private entries = new Map<string, Entry>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  constructor(
    private readonly changed: (taskId: string) => void,
    private readonly processorFactory: () => TranslationProcessor = () => new WorkerProcessor(),
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private view(entry: Entry): ExecutionView {
    return structuredClone(entry.view);
  }
  query(taskId: string): ExecutionView {
    this.prune();
    const entry = this.entries.get(taskId);
    return entry ? this.view(entry) : { taskId, state: 'missing' };
  }
  inspect() {
    this.prune();
    return {
      active: [...this.entries.values()].filter((e) => e.view.state === 'running').length,
      pendingResults: [...this.entries.values()].filter((e) => e.view.state === 'ready').length,
    };
  }
  start(input: Execution): ExecutionView {
    this.prune();
    const existing = this.entries.get(input.taskId);
    if (existing) return this.view(existing);
    if (
      this.disposed ||
      this.entries.size >= MAX_RECORDS ||
      this.inspect().active >= MAX_EXECUTIONS
    ) {
      return { taskId: input.taskId, state: 'failed', error: 'TASK_BUSY' };
    }
    const entry: Entry = { view: { taskId: input.taskId, state: 'running' }, expiresAt: Infinity };
    this.entries.set(input.taskId, entry);
    const remaining = Math.min(EXECUTION_BUDGET_MS, input.deadlineAt - Date.now());
    if (remaining <= 0 || input.deadlineAt > Date.now() + EXECUTION_BUDGET_MS) {
      this.finish(entry, 'timedOut', 'TIMEOUT');
      return this.view(entry);
    }
    entry.controller = new AbortController();
    try {
      entry.processor = this.processorFactory();
    } catch {
      this.finish(entry, 'failed', 'NETWORK_ERROR');
      return this.view(entry);
    }
    entry.timer = setTimeout(() => this.finish(entry, 'timedOut', 'TIMEOUT'), remaining);
    void translate(
      { ...input, signal: entry.controller.signal },
      this.fetcher,
      entry.processor,
    ).then(
      (result) => {
        if (entry.view.state !== 'running') return;
        entry.view.result = result;
        this.finish(entry, 'ready');
      },
      (error) => {
        if (entry.view.state !== 'running') return;
        const code = error instanceof ProviderError ? error.code : 'FORMAT_INVALID';
        this.finish(
          entry,
          code === 'TIMEOUT' ? 'timedOut' : code === 'CANCELED' ? 'canceled' : 'failed',
          code,
        );
      },
    );
    return this.view(entry);
  }
  cancel(taskId: string): ExecutionView {
    this.prune();
    let entry = this.entries.get(taskId);
    if (!entry) {
      if (this.entries.size >= MAX_RECORDS) return { taskId, state: 'failed', error: 'TASK_BUSY' };
      entry = {
        view: { taskId, state: 'canceled', error: 'CANCELED' },
        expiresAt: Date.now() + DEDUP_TTL_MS,
      };
      this.entries.set(taskId, entry);
      this.scheduleExpiry();
    } else if (entry.view.state === 'running' || entry.view.state === 'ready') {
      this.finish(entry, 'canceled', 'CANCELED');
    }
    return this.view(entry);
  }
  acknowledge(taskId: string): ExecutionView {
    this.prune();
    const entry = this.entries.get(taskId);
    if (entry?.view.state === 'ready') this.finish(entry, 'delivered');
    return this.query(taskId);
  }
  private finish(entry: Entry, state: ExecutionView['state'], error?: string) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.controller?.abort();
    entry.processor?.dispose();
    delete entry.controller;
    delete entry.processor;
    delete entry.timer;
    entry.view.state = state;
    if (error) entry.view.error = error;
    if (state !== 'ready') delete entry.view.result;
    entry.expiresAt = Date.now() + (state === 'ready' ? RESULT_TTL_MS : DEDUP_TTL_MS);
    this.scheduleExpiry();
    this.changed(entry.view.taskId);
  }
  private prune() {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      if (entry.view.state === 'ready') {
        delete entry.view.result;
        entry.view.state = 'expired';
        entry.expiresAt = now + DEDUP_TTL_MS;
        this.changed(id);
      } else this.entries.delete(id);
    }
  }
  private scheduleExpiry() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const next = Math.min(...[...this.entries.values()].map((e) => e.expiresAt));
    if (Number.isFinite(next) && !this.disposed)
      this.expiryTimer = setTimeout(
        () => {
          this.prune();
          this.scheduleExpiry();
        },
        Math.max(1, next - Date.now()),
      );
  }
  dispose() {
    this.disposed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.controller?.abort();
      entry.processor?.dispose();
    }
    this.entries.clear();
  }
}
