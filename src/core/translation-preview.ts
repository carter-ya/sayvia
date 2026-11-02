import type { TranslationPlan, TranslationSegment } from './plan-types';
import { MAX_OUTPUT_CHARACTERS } from './translation-plan';

// Parse only the segment envelope. Incomplete JSON string escapes stay buffered;
// the normal final reconstruction remains the sole authority for a usable result.
function partialSegments(input: string) {
  let cursor = 0;
  const space = () => {
    while (/\s/.test(input[cursor] ?? '') && cursor < input.length) cursor++;
  };
  const take = (character: string) => {
    space();
    if (input[cursor] !== character) return false;
    cursor++;
    return true;
  };
  const string = () => {
    space();
    if (input[cursor] !== '"') return;
    const start = cursor++;
    let safe = cursor;
    while (cursor < input.length) {
      const char = input[cursor]!;
      if (char === '"') {
        cursor++;
        try {
          return { value: JSON.parse(input.slice(start, cursor)) as string, complete: true };
        } catch {
          return;
        }
      }
      if (char === '\\') {
        if (cursor + 1 >= input.length) break;
        if (input[cursor + 1] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(input.slice(cursor + 2, cursor + 6))) break;
          cursor += 6;
        } else {
          if (!/["\\/bfnrt]/.test(input[cursor + 1]!)) return;
          cursor += 2;
        }
      } else {
        if (char.charCodeAt(0) < 32) return;
        cursor++;
      }
      safe = cursor;
    }
    try {
      return {
        value: (JSON.parse(input.slice(start, safe) + '"') as string).replace(
          /[\uD800-\uDBFF]$/,
          '',
        ),
        complete: false,
      };
    } catch {
      return;
    }
  };
  const values: { id: string; text: string; complete: boolean }[] = [];
  if (!take('{')) return values;
  const key = string();
  if (!key?.complete || key.value !== 'segments' || !take(':') || !take('[')) return values;
  for (let count = 0; count < 4096; count++) {
    if (!take('{')) break;
    let id: string | undefined, text: string | undefined;
    const keys = new Set<string>();
    let complete = false;
    for (let fields = 0; fields < 2; fields++) {
      const key = string();
      if (
        !key?.complete ||
        !['id', 'text'].includes(key.value) ||
        keys.has(key.value) ||
        !take(':')
      )
        return values;
      keys.add(key.value);
      const value = string();
      if (!value) return values;
      if (key.value === 'id' && value.complete) id = value.value;
      if (key.value === 'text') text = value.value;
      if (!value.complete) {
        if (id !== undefined && text !== undefined) values.push({ id, text, complete: false });
        return values;
      }
      if (take('}')) {
        complete = true;
        break;
      }
      if (!take(',')) return values;
    }
    if (id === undefined || text === undefined || !complete) return values;
    values.push({ id, text, complete: true });
    if (!take(',')) break;
  }
  return values;
}

function restorePrefix(segment: TranslationSegment, text: string) {
  // Do not show half a local placeholder, an invented marker, or reordered tokens.
  const last = text.lastIndexOf('⟦');
  if (
    last >= 0 &&
    segment.tokens.some(
      (token) =>
        text.length - last < token.marker.length && token.marker.startsWith(text.slice(last)),
    )
  )
    text = text.slice(0, last);
  let cursor = 0,
    output = '',
    tokenIndex = 0;
  const literal = (value: string) => value;
  while (cursor < text.length) {
    const start = text.indexOf(segment.tokenPrefix, cursor);
    if (start < 0) {
      output += literal(text.slice(cursor));
      break;
    }
    const token = segment.tokens[tokenIndex++];
    if (!token || !text.startsWith(token.marker, start)) return;
    output += literal(text.slice(cursor, start)) + token.text;
    cursor = start + token.marker.length;
  }
  return output;
}
export function previewTranslation(plan: TranslationPlan, content: string) {
  if (content.length > MAX_OUTPUT_CHARACTERS * 8) return '';
  const segments = partialSegments(content);
  let output = '',
    cursor = 0;
  for (let index = 0; index < segments.length; index++) {
    const value = segments[index]!,
      segment = plan.segments[index];
    if (!segment || segment.id !== value.id) break;
    const text = restorePrefix(segment, value.text);
    if (text === undefined) break;
    output += plan.sourceText.slice(cursor, segment.start) + text;
    cursor = segment.end;
    if (!value.complete) break;
  }
  return output.length <= 48_000 ? output : '';
}
