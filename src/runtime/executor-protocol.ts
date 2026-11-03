import { z } from 'zod';
import type { TranslationProgress, TranslationResult } from './translation-progress';
import { SourceInputSchema } from '../core/source-input';
import { LookupInputSchema, CaptionInputSchema } from '../core/learning-contract';
import type { LearningResult } from './learning-protocol';

export const EXECUTOR_PORT = 'sayvia.executor.v1';
export const LanguageSchema = z.string().trim().min(1).max(40);
export const TranslationExecutionSchema = z
  .object({
    purpose: z.literal('translate').optional(),
    taskId: z.uuid(),
    deadlineAt: z.int().positive(),
    source: SourceInputSchema,
    sourceLanguage: LanguageSchema,
    targetLanguage: LanguageSchema,
    config: z
      .object({
        baseUrl: z.string().min(1).max(2048),
        model: z.string().trim().min(1).max(160),
        apiKey: z.string().min(1).max(8192),
      })
      .strict(),
  })
  .strict();
export type TranslationExecution = z.infer<typeof TranslationExecutionSchema>;
const LearningExecutionBase = TranslationExecutionSchema.pick({
  taskId: true,
  deadlineAt: true,
  config: true,
});
export const LearningExecutionSchema = z.discriminatedUnion('purpose', [
  LearningExecutionBase.extend({ purpose: z.literal('lookup'), input: LookupInputSchema }),
  LearningExecutionBase.extend({ purpose: z.literal('captions'), input: CaptionInputSchema }),
]);
export type LearningExecution = z.infer<typeof LearningExecutionSchema>;
export const ExecutionSchema = z.union([TranslationExecutionSchema, LearningExecutionSchema]);
export type Execution = z.infer<typeof ExecutionSchema>;
const TaskCommand = z.object({ taskId: z.uuid() }).strict();
export const ExecutorCommandSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: z.uuid(),
    epoch: z.uuid(),
    token: z.uuid(),
    command: z.discriminatedUnion('type', [
      z.object({ type: z.literal('bind') }).strict(),
      z.object({ type: z.literal('start'), execution: ExecutionSchema }).strict(),
      z.object({ type: z.literal('query'), ...TaskCommand.shape }).strict(),
      z.object({ type: z.literal('cancel'), ...TaskCommand.shape }).strict(),
      z.object({ type: z.literal('ack'), ...TaskCommand.shape }).strict(),
      z.object({ type: z.literal('inspect') }).strict(),
    ]),
  })
  .strict();
export type ExecutorCommand = z.infer<typeof ExecutorCommandSchema>;
export type ExecutionState =
  'running' | 'ready' | 'failed' | 'canceled' | 'timedOut' | 'delivered' | 'expired' | 'missing';
export interface ExecutionView {
  taskId: string;
  state: ExecutionState;
  purpose?: 'translate' | 'lookup' | 'captions';
  result?: TranslationResult | LearningResult;
  progress?: TranslationProgress;
  error?: string;
}
