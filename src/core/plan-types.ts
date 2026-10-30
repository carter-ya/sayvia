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
  readonly version: 2;
  readonly sourceKind: 'markdown' | 'plain-text' | 'dom-selection';
  readonly sourceText: string;
  readonly parts: readonly PlanPart[];
  readonly segments: readonly TranslationSegment[];
  readonly markdownShape?: string;
}

export interface FormatBoundary extends Interval {
  role: 'format-open' | 'format-close';
}
export type ProtectedToken = Readonly<
  Interval & {
    text: string;
    marker: string;
    role: 'format-open' | 'format-close' | 'content' | 'whitespace';
    leadingWhitespace: boolean;
    trailingWhitespace: boolean;
  }
>;
export interface TranslationSegment extends Interval {
  readonly id: string;
  readonly text: string;
  readonly tokenPrefix: string;
  readonly tokens: readonly ProtectedToken[];
}
