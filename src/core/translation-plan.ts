import { z } from 'zod';
import { parseSourceInput, MAX_SOURCE_SPANS, type SourceInput } from './source-input';
import { markdownFingerprint, markdownTextIntervals, parseMarkdown } from './markdown';
import { PlanError, type Interval, type PlanPart, type TranslationPlan } from './plan-types';

export { PlanError } from './plan-types';
export type { TranslationPlan, PlanPart } from './plan-types';
export const MAX_OUTPUT_CHARACTERS = 24_000;
const knownPlans = new WeakSet<TranslationPlan>();

function mergeIntervals(intervals: Interval[]) {
  const merged: Interval[] = [];
  for (const span of intervals.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

function matches(text: string, pattern: RegExp): Interval[] {
  return [...text.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function protectedTokens(text: string, markdown: boolean) {
  const intervals = [
    ...matches(text, /\r\n|[\r\n\t]/g),
    ...matches(
      text,
      /(?:https?:\/\/|www\.)[^\s<>，。；！？、（）【】《》「」]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,
    ),
    ...matches(text, /(?<![\p{L}\p{N}_@])@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\/[a-z\d-]+)?/giu),
    ...matches(text, /(?<![\p{L}\p{N}_])(?:[a-z\d_.-]+\/[a-z\d_.-]+)?#\d+\b/giu),
  ];
  if (markdown) {
    intervals.push(
      ...matches(text, /\\[!-/:-@[-`{-~]|&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]*);/g),
    );
  }
  return mergeIntervals(intervals);
}

export function createTranslationPlan(input: SourceInput): TranslationPlan {
  const source = parseSourceInput(input);
  let eligible: Interval[] = [{ start: 0, end: source.text.length }];
  const protectedRanges: Interval[] = protectedTokens(source.text, source.kind === 'markdown');
  let markdownShape: string | undefined;
  if (source.kind === 'markdown') {
    const markdown = markdownTextIntervals(source.text);
    eligible = markdown.eligible;
    protectedRanges.push(...markdown.html);
    markdownShape = markdownFingerprint(markdown.tree);
  } else if (source.kind === 'dom-selection') {
    protectedRanges.push(...source.protectedRanges);
  }
  const forbidden = mergeIntervals(protectedRanges);
  const translated: Interval[] = [];
  for (const candidate of eligible.sort((a, b) => a.start - b.start)) {
    let cursor = candidate.start;
    const add = (end: number) => {
      const raw = source.text.slice(cursor, end);
      const leading = raw.length - raw.trimStart().length;
      const trailing = raw.length - raw.trimEnd().length;
      if (raw.trim()) translated.push({ start: cursor + leading, end: end - trailing });
    };
    for (const block of forbidden) {
      if (block.end <= cursor) continue;
      if (block.start >= candidate.end) break;
      add(Math.max(cursor, block.start));
      cursor = Math.min(candidate.end, block.end);
    }
    add(candidate.end);
  }

  const parts: PlanPart[] = [];
  let cursor = 0;
  let index = 0;
  const preserve = (end: number) => {
    if (end > cursor)
      parts.push(
        Object.freeze({
          kind: 'protected',
          start: cursor,
          end,
          text: source.text.slice(cursor, end),
        }),
      );
  };
  for (const span of translated) {
    if (span.start < cursor) throw new PlanError('INVALID_PLAN');
    preserve(span.start);
    parts.push(
      Object.freeze({
        kind: 'text',
        id: `s${index++}`,
        ...span,
        text: source.text.slice(span.start, span.end),
      }),
    );
    cursor = span.end;
  }
  preserve(source.text.length);
  if (parts.length > MAX_SOURCE_SPANS) throw new PlanError('PLAN_TOO_COMPLEX');
  const plan: TranslationPlan = Object.freeze({
    version: 1,
    sourceKind: source.kind,
    sourceText: source.text,
    parts: Object.freeze(parts),
    ...(markdownShape === undefined ? {} : { markdownShape }),
  });
  knownPlans.add(plan);
  return plan;
}

function assertPlan(plan: TranslationPlan) {
  if (!knownPlans.has(plan)) throw new PlanError('INVALID_PLAN');
}

export function needsTranslation(plan: TranslationPlan) {
  assertPlan(plan);
  return plan.parts.some((part) => part.kind === 'text');
}

// Only this payload may cross the model boundary. Protected source stays local.
export function translationPayload(plan: TranslationPlan) {
  assertPlan(plan);
  return {
    segments: plan.parts.map((part, index) =>
      part.kind === 'text'
        ? { id: part.id, text: part.text }
        : { id: `p${index}`, protected: true as const },
    ),
  };
}

const ResponseSchema = z
  .object({
    segments: z
      .array(
        z
          .object({
            id: z.string().max(32),
            text: z
              .string()
              .min(1)
              .max(MAX_OUTPUT_CHARACTERS * 2),
          })
          .strict(),
      )
      .max(MAX_SOURCE_SPANS),
  })
  .strict();

function validTranslatedText(text: string) {
  return (
    text === text.trim() &&
    [...text].every((character) => {
      const point = character.codePointAt(0)!;
      return (
        point > 31 &&
        point !== 127 &&
        point !== 0x2028 &&
        point !== 0x2029 &&
        !(point >= 0xd800 && point <= 0xdfff)
      );
    })
  );
}

function escapeMarkdown(text: string, strict: boolean) {
  return text.replace(/[!-~]/g, (character) => {
    const dangerous = '\\`*_[]<>|&~'.includes(character);
    return dangerous || (strict && !/[a-z\d]/i.test(character)) ? `\\${character}` : character;
  });
}

export function reconstructTranslation(plan: TranslationPlan, json: string) {
  assertPlan(plan);
  if (json.length > MAX_OUTPUT_CHARACTERS * 8) throw new PlanError('OUTPUT_TOO_LONG');
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch {
    throw new PlanError('INVALID_TRANSLATION');
  }
  const parsed = ResponseSchema.safeParse(decoded);
  if (!parsed.success) throw new PlanError('INVALID_TRANSLATION');
  const expected = plan.parts.filter((part) => part.kind === 'text');
  if (parsed.data.segments.length !== expected.length) throw new PlanError('INVALID_TRANSLATION');
  const replacements = new Map<string, string>();
  for (const [index, segment] of parsed.data.segments.entries()) {
    if (segment.id !== expected[index]!.id || !validTranslatedText(segment.text)) {
      throw new PlanError('INVALID_TRANSLATION');
    }
    replacements.set(segment.id, segment.text);
  }
  const render = (strict: boolean) =>
    plan.parts
      .map((part) => {
        if (part.kind === 'protected') return part.text;
        const text = replacements.get(part.id)!;
        return plan.sourceKind === 'markdown' && text !== part.text
          ? escapeMarkdown(text, strict)
          : text;
      })
      .join('');
  let result = render(false);
  if (plan.sourceKind === 'markdown') {
    const sameShape = (text: string) =>
      markdownFingerprint(parseMarkdown(text)) === plan.markdownShape;
    // Try stronger local escaping if line-start punctuation creates structure.
    if (!sameShape(result)) result = render(true);
    if (!sameShape(result)) throw new PlanError('FORMAT_CHANGED');
  }
  if ([...result].length > MAX_OUTPUT_CHARACTERS) throw new PlanError('OUTPUT_TOO_LONG');
  return result;
}
