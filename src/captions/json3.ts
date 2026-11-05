import { CAPTION_LIMITS, CaptionError, bytes, type CaptionCue } from './contract';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new CaptionError('INVALID_CAPTION_DATA');
  return value;
}
function text(value: string) {
  if (value.length > 8000 || [...value].length > CAPTION_LIMITS.cueCodepoints)
    throw new CaptionError('CAPTION_LIMIT');
  return value;
}
// No sorting repairs invalid source order. Event indexes remain those of the original JSON3.
export function parseJson3(body: string, asr: boolean): CaptionCue[] {
  if (body.length > CAPTION_LIMITS.responseBytes || bytes(body) > CAPTION_LIMITS.responseBytes)
    throw new CaptionError('CAPTION_LIMIT');
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new CaptionError('UNSUPPORTED_CAPTION_FORMAT');
  }
  if (!object(data) || data.wireMagic !== 'pb3' || !Array.isArray(data.events))
    throw new CaptionError('UNSUPPORTED_CAPTION_FORMAT');
  if (data.events.length > CAPTION_LIMITS.events) throw new CaptionError('CAPTION_LIMIT');
  const cues: CaptionCue[] = [];
  let outputBytes = 2;
  const push = (cue: CaptionCue) => {
    // Earlier end/revised edits only shorten their serialized representation.
    outputBytes += bytes(JSON.stringify(cue)) + 1;
    if (outputBytes > CAPTION_LIMITS.responseBytes || cues.length >= CAPTION_LIMITS.cues)
      throw new CaptionError('CAPTION_LIMIT');
    cues.push(cue);
  };
  const windows = new Map<
    string,
    { current: CaptionCue; line: CaptionCue[]; originalEnd: number; lastTime: number }
  >();
  let segments = 0;
  for (const [index, event] of data.events.entries()) {
    if (!object(event)) throw new CaptionError('INVALID_CAPTION_DATA');
    if (event.segs === undefined) continue; // Window/style configuration, never text.
    if (!Array.isArray(event.segs)) throw new CaptionError('INVALID_CAPTION_DATA');
    segments += event.segs.length;
    if (segments > CAPTION_LIMITS.segments) throw new CaptionError('CAPTION_LIMIT');
    const parts: string[] = [];
    let codepoints = 0;
    for (const segment of event.segs) {
      if (!object(segment) || typeof segment.utf8 !== 'string')
        throw new CaptionError('INVALID_CAPTION_DATA');
      if (!segment.utf8) continue;
      if (segment.utf8.length > 8000) throw new CaptionError('CAPTION_LIMIT');
      codepoints += [...segment.utf8].length;
      if (codepoints > CAPTION_LIMITS.cueCodepoints) throw new CaptionError('CAPTION_LIMIT');
      parts.push(segment.utf8);
    }
    const content = parts.join('');
    const start = time(event.tStartMs);
    const duration = event.dDurationMs === undefined ? undefined : time(event.dDurationMs);
    const end = duration === undefined ? undefined : time(start + duration);
    if (
      event.wWinId !== undefined &&
      (typeof event.wWinId !== 'number' || !Number.isSafeInteger(event.wWinId) || event.wWinId < 0)
    )
      throw new CaptionError('INVALID_CAPTION_DATA');
    const windowId = event.wWinId === undefined ? 'default' : String(event.wWinId);
    const parent = windows.get(windowId);
    if (parent && start < parent.lastTime) throw new CaptionError('INVALID_CAPTION_DATA');
    if (event.aAppend !== undefined && event.aAppend !== 0 && event.aAppend !== 1)
      throw new CaptionError('INVALID_CAPTION_DATA');
    if (event.aAppend === 1) {
      if (!content.trim()) continue; // Observed ASR line-break events carry no new words.
      if (!parent || start < parent.current.start || start >= parent.current.end)
        throw new CaptionError('INVALID_CAPTION_DATA');
      const effectiveEnd = Math.min(parent.current.end, end ?? parent.originalEnd);
      if (effectiveEnd <= start) throw new CaptionError('INVALID_CAPTION_DATA');
      const revision: CaptionCue = {
        ...parent.current,
        revision: parent.current.revision + 1,
        start,
        end: effectiveEnd,
        text: text(parent.current.text + content),
        events: [...parent.current.events, index],
        revised: true,
      };
      parent.current.end = start;
      for (const cue of parent.line) cue.revised = true;
      parent.current = revision;
      parent.line.push(revision);
      parent.lastTime = start;
      push(revision);
    } else {
      if (parent) {
        if (asr || start === parent.current.start)
          parent.current.end = Math.min(parent.current.end, start);
        parent.lastTime = start;
      }
      if (!content.trim()) continue;
      if (end === undefined) throw new CaptionError('INVALID_CAPTION_DATA');
      const cue: CaptionCue = {
        id: `w${windowId}:e${index}:t${start}`,
        revision: 0,
        start,
        end,
        text: content,
        windowId,
        events: [index],
        revised: false,
      };
      windows.set(windowId, { current: cue, line: [cue], originalEnd: end, lastTime: start });
      push(cue);
    }
    if (cues.length > CAPTION_LIMITS.cues) throw new CaptionError('CAPTION_LIMIT');
  }
  const result = cues.filter((cue) => cue.end > cue.start);
  if (bytes(JSON.stringify(result)) > CAPTION_LIMITS.responseBytes)
    throw new CaptionError('CAPTION_LIMIT');
  return result;
}
