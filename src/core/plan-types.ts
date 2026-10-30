export type PlanErrorCode =
  | 'INVALID_PLAN'
  | 'PLAN_TOO_COMPLEX'
  | 'INVALID_TRANSLATION'
  | 'FORMAT_CHANGED'
  | 'OUTPUT_TOO_LONG';

export class PlanError extends Error {
  constructor(readonly code: PlanErrorCode) {
    super(code);
  }
}

export interface Interval {
  start: number;
  end: number;
}

export type PlanPart = Readonly<
  Interval & ({ kind: 'text'; id: string; text: string } | { kind: 'protected'; text: string })
>;

export interface TranslationPlan {
  readonly version: 1;
  readonly sourceKind: 'markdown' | 'plain-text' | 'dom-selection';
  readonly sourceText: string;
  readonly parts: readonly PlanPart[];
  readonly markdownShape?: string;
}
