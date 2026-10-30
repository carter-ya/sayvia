import { z } from 'zod';

export const MAX_SOURCE_CHARACTERS = 12_000;
export const MAX_SOURCE_SPANS = 4096;
export type SourceErrorCode =
  | 'EMPTY_SOURCE'
  | 'SOURCE_TOO_LONG'
  | 'INVALID_SOURCE'
  | 'SELECTION_LOST'
  | 'UNSUPPORTED_SELECTION'
  | 'SELECTION_TOO_COMPLEX';

export class SourceError extends Error {
  constructor(readonly code: SourceErrorCode) {
    super(code);
  }
}

export function isUtf16Boundary(text: string, offset: number) {
  if (offset <= 0 || offset >= text.length) return true;
  return !(
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff
  );
}

function validText(text: string) {
  let characters = 0;
  for (const character of text) {
    if (++characters > MAX_SOURCE_CHARACTERS) return false;
    const unit = character.charCodeAt(0);
    if (character.length === 1 && unit >= 0xd800 && unit <= 0xdfff) return false;
  }
  return Boolean(text.trim());
}

const Text = z
  .string()
  .min(1)
  .max(MAX_SOURCE_CHARACTERS * 2)
  .refine(validText);
const Span = z.object({ start: z.int().nonnegative(), end: z.int().positive() }).strict();
const ProtectedRange = Span.extend({
  kind: z.enum(['inline-code', 'code-block', 'url', 'mention', 'reference']),
});
const Mark = Span.extend({ kind: z.enum(['link-label', 'paragraph', 'line-break']) });

export const SourceInputSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('markdown'), text: Text }).strict(),
    z.object({ kind: z.literal('plain-text'), text: Text }).strict(),
    z
      .object({
        kind: z.literal('dom-selection'),
        text: Text,
        protectedRanges: z.array(ProtectedRange).max(MAX_SOURCE_SPANS),
        marks: z.array(Mark).max(MAX_SOURCE_SPANS),
      })
      .strict(),
  ])
  .superRefine((source, ctx) => {
    if (source.kind !== 'dom-selection') return;
    for (const span of [...source.protectedRanges, ...source.marks]) {
      if (
        span.start >= span.end ||
        span.end > source.text.length ||
        !isUtf16Boundary(source.text, span.start) ||
        !isUtf16Boundary(source.text, span.end)
      ) {
        ctx.addIssue({ code: 'custom', message: 'Invalid source interval' });
      }
    }
    let end = 0;
    for (const span of source.protectedRanges) {
      if (span.start < end)
        ctx.addIssue({ code: 'custom', message: 'Conflicting protected intervals' });
      end = span.end;
    }
  });
export type SourceInput = z.infer<typeof SourceInputSchema>;
export type DomSource = Extract<SourceInput, { kind: 'dom-selection' }>;

export function parseSourceInput(input: unknown): SourceInput {
  if (
    typeof input === 'object' &&
    input !== null &&
    'text' in input &&
    typeof input.text === 'string'
  ) {
    if (!input.text.trim()) throw new SourceError('EMPTY_SOURCE');
    if (
      input.text.length > MAX_SOURCE_CHARACTERS * 2 ||
      [...input.text].length > MAX_SOURCE_CHARACTERS
    )
      throw new SourceError('SOURCE_TOO_LONG');
  }
  const parsed = SourceInputSchema.safeParse(input);
  if (!parsed.success) throw new SourceError('INVALID_SOURCE');
  return parsed.data;
}
