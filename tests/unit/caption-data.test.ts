import { expect, test } from 'vitest';
import {
  CAPTION_LIMITS,
  bytes,
  timedtextTrack,
  trackKey,
  type CaptionTrack,
  type CaptionCue,
} from '../../src/captions/contract';
import { parseJson3 } from '../../src/captions/json3';
import { groupCaptions } from '../../src/captions/group';
import {
  CaptionAssembler,
  CaptionBridgeSender,
  encodeCaptionResponse,
  MessageRate,
} from '../../src/captions/bridge';

const track: CaptionTrack = {
  videoId: 'example',
  lang: 'en',
  kind: 'asr',
  name: null,
  tlang: null,
};
const scope = () => ({ generation: crypto.randomUUID(), track });
const wire = (events: unknown[]) => JSON.stringify({ wireMagic: 'pb3', events });
const row = (start: number, duration: number, text: string, fields = {}) => ({
  tStartMs: start,
  dDurationMs: duration,
  segs: [{ utf8: text }],
  ...fields,
});
const cue = (index: number, text = `row ${index}`): CaptionCue => ({
  id: `e${index}`,
  revision: 0,
  start: index * 1000,
  end: (index + 1) * 1000,
  windowId: '1',
  text,
  events: [index],
  revised: false,
});
const mutate = (raw: string, patch: object) => JSON.stringify({ ...JSON.parse(raw), ...patch });

test('track identity accepts only exact native endpoints, preserves discriminators and ignores format/signatures', () => {
  const first = timedtextTrack(
    'https://www.youtube.com/api/timedtext?v=example&lang=en&kind=asr&fmt=json3&sig=private',
  );
  expect(first).toEqual(track);
  expect(trackKey(first!)).not.toContain('private');
  expect(
    trackKey(
      timedtextTrack(
        'https://www.youtube.com/api/timedtext?v=example&lang=en&kind=asr&name=&fmt=srv3',
      )!,
    ),
  ).toBe(trackKey(track));
  for (const patch of [
    { kind: null },
    { name: 'other' },
    { tlang: 'fr' },
    { videoId: 'different' },
    { lang: 'de' },
  ])
    expect(trackKey({ ...track, ...patch })).not.toBe(trackKey(track));
  for (const url of [
    'https://evil.example/api/timedtext?v=example&lang=en',
    'https://www.youtube.com/api/timedtext/extra?v=example&lang=en',
    'https://www.youtube.com/api/timedtext?v=example&lang=en&lang=fr',
    'https://www.youtube.com/api/timedtext?v=example&lang=invalid_tag',
  ])
    expect(timedtextTrack(url)).toBeUndefined();
});

test('ASR retains repeated words, clips overlap per window, preserves gaps and replaces equal starts', () => {
  const input = wire([
    { tStartMs: 0, id: 1 },
    row(0, 5000, 'hello', { wWinId: 1 }),
    row(1000, 500, 'hello', { wWinId: 1 }),
    row(3000, 1000, 'old', { wWinId: 1 }),
    row(3000, 500, 'new', { wWinId: 1 }),
    row(0, 9000, 'other window', { wWinId: 2 }),
    row(4000, 0, 'zero', { wWinId: 1 }),
  ]);
  const result = parseJson3(input, true);
  expect(result.map(({ text, start, end }) => [text, start, end])).toEqual([
    ['hello', 0, 1000],
    ['hello', 1000, 1500],
    ['new', 3000, 3500],
    ['other window', 0, 9000],
  ]);
  expect(parseJson3(wire([row(0, 5000, 'one'), row(1000, 500, 'two')]), false)[0]!.end).toBe(5000);
});

test('append revisions appear only at their effective times and keep source event mapping', () => {
  const result = parseJson3(
    wire([
      row(0, 5000, 'hello '),
      row(1000, 4000, '\n', { aAppend: 1 }),
      { tStartMs: 2000, aAppend: 1, segs: [{ utf8: 'world' }] },
      row(4000, 500, 'next'),
    ]),
    true,
  );
  expect(
    result.map(({ text, start, end, revision, events }) => [text, start, end, revision, events]),
  ).toEqual([
    ['hello ', 0, 2000, 0, [0]],
    ['hello world', 2000, 4000, 1, [0, 2]],
    ['next', 4000, 4500, 0, [3]],
  ]);
  expect(result.slice(0, 2).every((item) => item.revised)).toBe(true);
});

test.each([
  [row(-1, 1, 'bad')],
  [row(0, -1, 'bad')],
  [row(Number.MAX_SAFE_INTEGER, 1, 'bad')],
  [row(1000, 1000, 'later'), row(0, 1000, 'earlier')],
  [row(0, 1000, 'orphan', { aAppend: 1 })],
  [row(0, 1000, 'parent'), row(1000, 100, 'late', { aAppend: 1 })],
  [row(0, 1000, 'parent'), row(200, 0, 'zero', { aAppend: 1 })],
  [{ tStartMs: 0, segs: [{ utf8: 'missing duration' }] }],
])('invalid timeline is rejected rather than sorted or extended: %j', (...events) => {
  expect(() => parseJson3(wire(events), true)).toThrow('INVALID_CAPTION_DATA');
});

test('limits apply to decoded bytes, empty source events, segment counts and individual text', () => {
  expect(() => parseJson3(' '.repeat(CAPTION_LIMITS.responseBytes + 1), true)).toThrow(
    'CAPTION_LIMIT',
  );
  expect(() =>
    parseJson3(wire(Array.from({ length: CAPTION_LIMITS.events + 1 }, () => ({}))), true),
  ).toThrow('CAPTION_LIMIT');
  expect(() => parseJson3(wire([row(0, 1, '😀'.repeat(4001))]), true)).toThrow('CAPTION_LIMIT');
  expect(parseJson3(wire([row(0, 1, '😀'.repeat(4000))]), true)).toHaveLength(1);
  expect(() => parseJson3('<transcript/>', true)).toThrow('UNSUPPORTED_CAPTION_FORMAT');
  expect(() =>
    parseJson3(
      wire([
        {
          tStartMs: 0,
          dDurationMs: 1,
          segs: Array.from({ length: CAPTION_LIMITS.segments + 1 }, () => ({})),
        },
      ]),
      true,
    ),
  ).toThrow('CAPTION_LIMIT');
});

test('ASR groups use full timeline, exact contiguous same-window bounds and stable identity', async () => {
  const original = [
    cue(0, 'first'),
    cue(1, 'second'),
    cue(2, 'third'),
    cue(3, 'fourth.'),
    cue(5, 'after gap'),
    { ...cue(6), windowId: '2' },
  ];
  const groups = await groupCaptions(track, original);
  expect(groups.map((item) => item.text)).toEqual([
    'first\nsecond\nthird',
    'fourth.',
    'after gap',
    'row 6',
  ]);
  expect(groups[0]!.sources).toEqual(
    original.slice(0, 3).map(({ id, revision }) => ({ id, revision })),
  );
  expect(await groupCaptions(track, original)).toEqual(groups);
  const changed = await groupCaptions(track, [
    { ...original[0]!, text: 'changed' },
    ...original.slice(1),
  ]);
  expect(changed[0]!.unitId).not.toBe(groups[0]!.unitId);
  expect(changed[1]!.unitId).toBe(groups[1]!.unitId);
  expect(groups.every((group) => group.unitId.length <= 160)).toBe(true);
});

test('grouping preserves oversized single rows and never merges across append revisions or punctuation', async () => {
  const sources = [
    { ...cue(0, 'x'.repeat(201)), end: 1000 },
    cue(1, 'stop!'),
    { ...cue(2), end: 12000 },
    { ...cue(12), revised: true },
    cue(13),
  ];
  expect((await groupCaptions(track, sources)).map((group) => group.sources.length)).toEqual([
    1, 1, 1, 1, 1,
  ]);
  expect((await groupCaptions({ ...track, kind: null }, [cue(0), cue(1)])).length).toBe(2);
  await expect(groupCaptions(track, [cue(1), cue(0)])).rejects.toThrow('INVALID_CAPTION_DATA');
});

test('bridge budgets include envelope and escaped multibyte text, with atomic interleaved commits', () => {
  const identity = scope();
  const rows = Array.from({ length: 170 }, (_, index) => cue(index, '“😀\\\n'.repeat(80)));
  const a = encodeCaptionResponse(identity, rows);
  const b = encodeCaptionResponse(identity, rows);
  expect(a.length).toBeGreaterThan(1);
  expect(
    a.every(
      (raw) => bytes(raw) <= CAPTION_LIMITS.messageBytes && JSON.parse(raw).cues.length <= 100,
    ),
  ).toBe(true);
  const receiver = new CaptionAssembler(identity);
  for (let index = 0; index < a.length; index++) {
    for (const list of [a, b]) {
      const result = receiver.accept(list[index]);
      expect(result.status).toBe(index === a.length - 1 ? 'complete' : 'pending');
      if (result.status === 'complete') expect(result.cues).toEqual(rows);
    }
  }
  expect(receiver.accept(a[0]).status).toBe('rejected');
});

test.each([
  'duplicate',
  'out of order',
  'total changes',
  'track changes',
  'third response',
  'timeout',
  'cancel',
])('bridge fails closed on %s and never revives partial data', (mode) => {
  const identity = scope();
  const rows = Array.from({ length: 101 }, (_, index) => cue(index));
  const chunks = encodeCaptionResponse(identity, rows);
  let clock = 0;
  const receiver = new CaptionAssembler(identity, () => clock);
  if (mode === 'out of order') expect(receiver.accept(chunks[1]).status).toBe('rejected');
  else {
    expect(receiver.accept(chunks[0]).status).toBe('pending');
    if (mode === 'duplicate') expect(receiver.accept(chunks[0]).status).toBe('rejected');
    if (mode === 'total changes')
      expect(receiver.accept(mutate(chunks[1]!, { total: 3 })).status).toBe('rejected');
    if (mode === 'track changes')
      expect(
        receiver.accept(mutate(chunks[1]!, { track: { ...track, name: 'other' } })).status,
      ).toBe('rejected');
    if (mode === 'third response') {
      expect(receiver.accept(encodeCaptionResponse(identity, rows)[0]).status).toBe('pending');
      expect(receiver.accept(encodeCaptionResponse(identity, rows)[0]).status).toBe('rejected');
    }
    if (mode === 'timeout') {
      clock = 10_000;
      expect(receiver.expire()).toBe(true);
    }
    if (mode === 'cancel') receiver.cancel();
  }
  expect(receiver.accept(chunks[1]).status).toBe('rejected');
  expect(receiver.accept(chunks[0]).status).toBe('rejected');
});

test('bridge rejects duplicate cue revisions, huge strings and message bursts, ignoring old generation', () => {
  const identity = scope();
  const receiver = new CaptionAssembler(identity);
  expect(receiver.accept(encodeCaptionResponse(scope(), [cue(0)])[0]).status).toBe('ignored');
  expect(receiver.accept({ channel: 'sayvia.captions.v1' }).status).toBe('ignored');
  expect(receiver.accept(encodeCaptionResponse(identity, [cue(0), cue(0)])[0]).status).toBe(
    'rejected',
  );
  expect(
    new CaptionAssembler(identity).accept('{"channel":"sayvia.captions.v1",' + ' '.repeat(65536))
      .status,
  ).toBe('rejected');
  let now = 0;
  const rate = new MessageRate(() => now);
  expect(Array.from({ length: 64 }, () => rate.take()).every(Boolean)).toBe(true);
  expect(rate.take()).toBe(false);
  now = 1000 / 64;
  expect(rate.take()).toBe(true);
  expect(rate.take()).toBe(false);
});

test('sender cancellation never emits queued partial work and bounds concurrent submissions', async () => {
  const sent: string[] = [];
  const sender = new CaptionBridgeSender((raw) => sent.push(raw));
  const abort = new AbortController();
  const first = sender.send(scope(), [cue(0)], abort.signal);
  const second = sender.send(scope(), [cue(1)], abort.signal);
  const third = sender.send(scope(), [cue(2)], abort.signal);
  abort.abort();
  await expect(first).rejects.toThrow();
  await expect(second).rejects.toThrow();
  await expect(third).rejects.toThrow('CAPTION_LIMIT');
  expect(sent).toEqual([]);
});

test('an oversized response is never partially accepted or emitted', () => {
  const identity = scope();
  expect(() =>
    encodeCaptionResponse(
      identity,
      Array.from({ length: 1100 }, (_, index) => cue(index, 'x'.repeat(4000))),
    ),
  ).toThrow('CAPTION_LIMIT');
  const template = JSON.parse(encodeCaptionResponse(identity, [cue(0)])[0]!);
  let clock = 0;
  const receiver = new CaptionAssembler(identity, () => clock);
  let rejected = false;
  for (let sequence = 0; sequence < 110; sequence++) {
    clock += 20;
    const result = receiver.accept(
      JSON.stringify({
        ...template,
        total: 110,
        sequence,
        cues: Array.from({ length: 10 }, (_, i) => cue(sequence * 10 + i, 'x'.repeat(4000))),
      }),
    );
    expect(result.status).not.toBe('complete');
    rejected ||= result.status === 'rejected';
  }
  expect(rejected).toBe(true);
});

test('later chunks do not extend the fixed assembly deadline', () => {
  const identity = scope();
  const chunks = encodeCaptionResponse(
    identity,
    Array.from({ length: 201 }, (_, index) => cue(index)),
  );
  let clock = 0;
  const receiver = new CaptionAssembler(identity, () => clock);
  expect(receiver.accept(chunks[0]).status).toBe('pending');
  clock = 9999;
  expect(receiver.accept(chunks[1]).status).toBe('pending');
  clock = 10_000;
  expect(receiver.accept(chunks[2]).status).toBe('rejected');
});

test('empty segments at the source limit do not repeatedly scan the accumulated line', () => {
  const segments = [
    { utf8: 'x'.repeat(4000) },
    ...Array.from({ length: CAPTION_LIMITS.segments - 1 }, () => ({ utf8: '' })),
  ];
  expect(
    parseJson3(wire([{ tStartMs: 0, dDurationMs: 1000, segs: segments }]), true)[0]!.text,
  ).toHaveLength(4000);
});
