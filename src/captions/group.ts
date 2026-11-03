import {
  CAPTION_LIMITS,
  CaptionError,
  CueSchema,
  bytes,
  trackKey,
  type CaptionCue,
  type CaptionGroup,
  type CaptionTrack,
} from './contract';

const terminal = /[.!?。！？][”’"')\]]*\s*$/u;
export async function groupCaptions(
  track: CaptionTrack,
  source: readonly CaptionCue[],
  signal?: AbortSignal,
): Promise<CaptionGroup[]> {
  signal?.throwIfAborted();
  if (
    source.length > CAPTION_LIMITS.cues ||
    bytes(JSON.stringify(source)) > CAPTION_LIMITS.responseBytes
  )
    throw new CaptionError('CAPTION_LIMIT');
  const key = trackKey(track);
  const byWindow = new Map<string, CaptionCue[]>();
  const identities = new Set<string>();
  for (const input of source) {
    const parsed = CueSchema.safeParse(input);
    if (!parsed.success) throw new CaptionError('INVALID_CAPTION_DATA');
    const cue = parsed.data;
    const identity = JSON.stringify([cue.id, cue.revision]);
    if (identities.has(identity)) throw new CaptionError('INVALID_CAPTION_DATA');
    identities.add(identity);
    const list = byWindow.get(cue.windowId) ?? [];
    if (list.length && cue.start < list.at(-1)!.start)
      throw new CaptionError('INVALID_CAPTION_DATA');
    list.push(cue);
    byWindow.set(cue.windowId, list);
  }
  const groups: CaptionCue[][] = [];
  for (const cues of byWindow.values()) {
    let group: CaptionCue[] = [];
    const flush = () => {
      if (group.length) groups.push(group);
      group = [];
    };
    for (const cue of cues) {
      const last = group.at(-1);
      if (
        last &&
        (track.kind !== 'asr' ||
          last.revised ||
          cue.revised ||
          last.end !== cue.start ||
          group.length === 3 ||
          cue.end - group[0]!.start > 8000 ||
          [...[...group.map((item) => item.text), cue.text].join('\n')].length > 200 ||
          terminal.test(last.text))
      )
        flush();
      group.push(cue);
      if (cue.revised || track.kind !== 'asr' || terminal.test(cue.text)) flush();
    }
    flush();
  }
  const result: CaptionGroup[] = [];
  // Serial hashing bounds simultaneous allocations even for 20,000 independent rows.
  for (const group of groups) {
    signal?.throwIfAborted();
    const first = group[0]!;
    const last = group.at(-1)!;
    const sources = group.map((cue) => ({ id: cue.id, revision: cue.revision }));
    const encoded = JSON.stringify([
      key,
      'asr-group-v1',
      group.map((cue) => [cue.id, cue.revision, cue.start, cue.end, cue.text]),
    ]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded));
    const unitId = `g1:${Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')}`;
    result.push({
      unitId,
      revision: 0,
      start: first.start,
      end: last.end,
      windowId: first.windowId,
      text: group.map((cue) => cue.text).join('\n'),
      sources,
    });
  }
  return result.sort((a, b) => a.start - b.start || a.unitId.localeCompare(b.unitId));
}
