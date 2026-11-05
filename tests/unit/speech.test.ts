import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectLocalVoice } from '../../src/core/local-voice';
import {
  SpeechService,
  SPEECH_ALARM_PREFIX,
  type SpeechPlatform,
} from '../../src/background/speech-service';
import {
  SpeechMessageSchema,
  type SpeechInput,
  type SpeechLease,
  type SpeechOwner,
} from '../../src/runtime/speech-protocol';

const owner = (): SpeechOwner => ({
  kind: 'page',
  tabId: 1,
  documentId: crypto.randomUUID(),
  siteOrigin: 'https://example.test',
  documentNonce: crypto.randomUUID(),
  cardId: crypto.randomUUID(),
});
const input: SpeechInput = { text: 'bank', language: 'en-US', languageConfirmed: true, rate: 1 };
const services: SpeechService[] = [];
async function setup(old?: unknown) {
  let saved: unknown = old;
  const platform = {
    read: vi.fn(async () => saved),
    save: vi.fn(async (lease: SpeechLease) => {
      saved = structuredClone(lease);
    }),
    remove: vi.fn(async () => {
      saved = undefined;
    }),
    voices: vi
      .fn<SpeechPlatform['voices']>()
      .mockResolvedValue([{ voiceName: 'Local English', lang: 'en-US', remote: false }]),
    speak: vi.fn<SpeechPlatform['speak']>().mockResolvedValue(undefined),
    stop: vi.fn(),
    alarm: vi.fn<SpeechPlatform['alarm']>().mockResolvedValue(undefined),
    clearAlarm: vi.fn<SpeechPlatform['clearAlarm']>().mockResolvedValue(true),
    permitted: vi.fn<SpeechPlatform['permitted']>().mockResolvedValue(true),
    notify: vi.fn<NonNullable<SpeechPlatform['notify']>>().mockResolvedValue(undefined),
  };
  const service = new SpeechService(platform);
  services.push(service);
  await service.ready;
  return { service, platform, saved: () => saved };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const service of services.splice(0))
    await service.cancelWhere(() => true).catch(() => undefined);
  vi.useRealTimers();
});

describe('local voice selection', () => {
  it.each(['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES'])(
    'pins a local voice for %s',
    (language) => {
      expect(
        selectLocalVoice([{ voiceName: 'Local', lang: language, remote: false }], language),
      ).toEqual({ voiceName: 'Local', lang: language });
    },
  );
  it('prefers exact locale, refuses unknown/remote engines and never crosses Chinese dialects', () => {
    const voices = [
      { voiceName: 'British', lang: 'en-GB', remote: false },
      { voiceName: 'US', lang: 'en-US', remote: false },
      { voiceName: 'Remote', lang: 'fr-FR', remote: true },
      { voiceName: 'Unknown', lang: 'de-DE' },
      { voiceName: 'Extension', lang: 'ja-JP', remote: false, extensionId: 'another' },
      { voiceName: 'Cantonese', lang: 'zh-HK', remote: false },
      { voiceName: 'Mandarin', lang: 'zh-TW', remote: false },
    ];
    expect(selectLocalVoice(voices, 'en-US')?.voiceName).toBe('US');
    expect(selectLocalVoice(voices, 'en-AU')?.voiceName).toBe('British');
    for (const lang of ['fr', 'de', 'ja', 'not_a_tag'])
      expect(selectLocalVoice(voices, lang)).toBeUndefined();
    expect(selectLocalVoice(voices, 'zh-Hant')?.voiceName).toBe('Mandarin');
    expect(selectLocalVoice(voices, 'yue-HK')?.voiceName).toBe('Cantonese');
    expect(selectLocalVoice([voices[5]!], 'zh-CN')).toBeUndefined();
    expect(selectLocalVoice([voices[6]!], 'zh-HK')).toBeUndefined();
  });
  it('rejects a same-name remote engine instead of relying on unspecified voice resolution', () => {
    expect(
      selectLocalVoice(
        [
          { voiceName: 'Shared', lang: 'en', remote: false },
          { voiceName: 'Shared', lang: 'en', remote: true },
        ],
        'en',
      ),
    ).toBeUndefined();
  });
});

describe('speech ownership and cancellation', () => {
  it('does not enumerate on ticket issuance; persists no text and speaks once with a pinned voice', async () => {
    const f = await setup();
    const who = owner();
    const ticket = await f.service.ticket(who, crypto.randomUUID());
    expect(f.platform.voices).not.toHaveBeenCalled();
    expect(await f.service.start(who, ticket, { ...input, rate: 0.75 })).toBe('speaking');
    expect(await f.service.start(who, ticket, input)).toBe('speaking');
    expect(f.platform.speak).toHaveBeenCalledOnce();
    expect(f.platform.speak).toHaveBeenCalledWith(
      'bank',
      expect.objectContaining({
        voiceName: 'Local English',
        lang: 'en-US',
        rate: 0.75,
        enqueue: false,
      }),
    );
    expect(JSON.stringify(f.saved())).not.toContain('bank');
    expect(f.platform.save.mock.invocationCallOrder[0]).toBeLessThan(
      f.platform.alarm.mock.invocationCallOrder[0]!,
    );
    expect(f.platform.alarm.mock.invocationCallOrder[0]).toBeLessThan(
      f.platform.speak.mock.invocationCallOrder[0]!,
    );
    await f.service.stop(who, ticket);
    expect(f.saved()).toBeUndefined();
    expect(f.platform.stop).toHaveBeenCalledOnce();
  });
  it('a stop before start prevents both enumeration and late speech', async () => {
    const f = await setup();
    const who = owner();
    const ticket = await f.service.ticket(who, crypto.randomUUID());
    await f.service.stop(who, ticket);
    expect(await f.service.start(who, ticket, input)).toBe('canceled');
    expect(f.platform.voices).not.toHaveBeenCalled();
    expect(f.platform.speak).not.toHaveBeenCalled();
  });
  it('cancels immediately during a stalled enumeration, without waiting for its late voices', async () => {
    const f = await setup();
    const who = owner();
    let finish!: (voices: Awaited<ReturnType<SpeechPlatform['voices']>>) => void;
    f.platform.voices.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const ticket = await f.service.ticket(who, crypto.randomUUID());
    const starting = f.service.start(who, ticket, input);
    await vi.advanceTimersByTimeAsync(0);
    await f.service.stop(who, ticket);
    expect(await starting).toBe('canceled');
    finish([{ voiceName: 'Local', lang: 'en-US', remote: false }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.platform.speak).not.toHaveBeenCalled();
  });
  it('bounds a stalled or absent voice list and reports unavailable without guessing', async () => {
    const f = await setup();
    const who = owner();
    f.platform.voices.mockImplementation(() => new Promise(() => {}));
    const ticket = await f.service.ticket(who, crypto.randomUUID());
    const starting = f.service.start(who, ticket, input);
    await vi.advanceTimersByTimeAsync(3100);
    expect(await starting).toBe('unavailable');
    expect(f.platform.voices).toHaveBeenCalledTimes(10);
    expect(f.platform.speak).not.toHaveBeenCalled();
  });
  it.each(['save', 'alarm', 'permission'] as const)('fails closed at %s', async (step) => {
    const f = await setup();
    const who = owner();
    if (step === 'save') f.platform.save.mockRejectedValue(new Error('storage'));
    if (step === 'alarm') f.platform.alarm.mockRejectedValue(new Error('alarm'));
    if (step === 'permission') f.platform.permitted.mockResolvedValue(false);
    const ticket = await f.service.ticket(who, crypto.randomUUID());
    expect(await f.service.start(who, ticket, input)).toBe('failed');
    expect(f.platform.speak).not.toHaveBeenCalled();
    expect(f.saved()).toBeUndefined();
  });
  it('rechecks cancellation after persistence/alarm and never speaks a card closed in that gap', async () => {
    const f = await setup();
    const who = owner();
    let release!: () => void;
    f.platform.alarm.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const ticket = await f.service.ticket(who, crypto.randomUUID());
    const starting = f.service.start(who, ticket, input);
    await vi.advanceTimersByTimeAsync(0);
    const stopped = f.service.stop(who, ticket);
    await vi.advanceTimersByTimeAsync(0);
    release();
    expect(await starting).toBe('canceled');
    await stopped;
    expect(f.platform.speak).not.toHaveBeenCalled();
    expect(f.saved()).toBeUndefined();
  });
  it('keeps an active lease stoppable after its original ticket expired', async () => {
    const f = await setup();
    const who = owner();
    const ticket = await f.service.ticket(who, crypto.randomUUID());
    await vi.advanceTimersByTimeAsync(29_000);
    await f.service.start(who, ticket, input);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await f.service.stop(who, ticket)).toBe('canceled');
    expect(f.platform.stop).toHaveBeenCalledOnce();
    await expect(f.service.start(who, ticket, input)).rejects.toThrow('SPEECH_EXPIRED');
  });
  it('does not let old events, alarms or stop cancel a newer card', async () => {
    const f = await setup();
    const first = owner();
    const second = { ...first, cardId: crypto.randomUUID() };
    const a = await f.service.ticket(first, crypto.randomUUID());
    await f.service.start(first, a, input);
    const oldEvent = f.platform.speak.mock.calls[0]![1].onEvent;
    const oldAlarm = f.platform.alarm.mock.calls[0]![0];
    const b = await f.service.ticket(second, crypto.randomUUID());
    await f.service.start(second, b, input);
    const stops = f.platform.stop.mock.calls.length;
    oldEvent({ type: 'end' });
    await f.service.onAlarm(oldAlarm);
    expect(await f.service.stop(first, a)).toBe('canceled');
    expect(f.platform.stop).toHaveBeenCalledTimes(stops);
    expect(f.saved()).toMatchObject({ ticket: b });
    f.platform.speak.mock.calls[1]![1].onEvent({ type: 'end' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.saved()).toBeUndefined();
    expect(f.platform.stop).toHaveBeenCalledTimes(stops);
  });
  it('does not let a different document/tab/card use another ticket', async () => {
    const f = await setup();
    const who = owner();
    const ticket = await f.service.ticket(who, crypto.randomUUID());
    for (const other of [{ ...who, tabId: 2 }, { ...who, cardId: crypto.randomUUID() }, owner()]) {
      await expect(f.service.start(other, ticket, input)).rejects.toThrow('SPEECH_EXPIRED');
      await expect(f.service.stop(other, ticket)).rejects.toThrow('SPEECH_EXPIRED');
    }
    expect(f.platform.speak).not.toHaveBeenCalled();
  });

  it('deduplicates terminal tickets and gives a later issuance a fresh alarm identity', async () => {
    const f = await setup();
    const who = owner();
    const clientId = crypto.randomUUID();
    const a = await f.service.ticket(who, clientId);
    expect(a.speechId).not.toBe(clientId);
    await f.service.start(who, a, input);
    const oldAlarm = f.platform.alarm.mock.calls[0]![0];
    f.platform.speak.mock.calls[0]![1].onEvent({ type: 'end' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.service.ticket(who, clientId)).toEqual(a);
    expect(await f.service.start(who, a, input)).toBe('ended');
    expect(f.platform.speak).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_001);
    const b = await f.service.ticket(who, clientId);
    expect(b.speechId).not.toBe(a.speechId);
    await f.service.start(who, b, input);
    await f.service.onAlarm(oldAlarm);
    expect(f.saved()).toMatchObject({ ticket: b });
    expect(f.platform.stop).not.toHaveBeenCalled();
  });

  it('retains the canceled state when a queued start is superseded before execution', async () => {
    const f = await setup();
    const who = owner();
    const a = await f.service.ticket(who, crypto.randomUUID());
    const b = await f.service.ticket(who, crypto.randomUUID());
    const first = f.service.start(who, a, input);
    const second = f.service.start(who, b, input);
    expect(await Promise.all([first, second])).toEqual(['canceled', 'speaking']);
    expect(await f.service.start(who, a, input)).toBe('canceled');
    expect(f.platform.speak).toHaveBeenCalledOnce();
  });

  it('allows 256 pending records beside one active lease, retaining all at termination', async () => {
    const f = await setup();
    const who = owner();
    const active = await f.service.ticket(who, crypto.randomUUID());
    await f.service.start(who, active, input);
    const canceled = await f.service.ticket(who, crypto.randomUUID());
    await f.service.stop(who, canceled);
    for (let i = 1; i < 256; i++) await f.service.ticket(who, crypto.randomUUID());
    await expect(f.service.ticket(who, crypto.randomUUID())).rejects.toThrow('SPEECH_BUSY');
    f.platform.speak.mock.calls[0]![1].onEvent({ type: 'end' });
    await vi.advanceTimersByTimeAsync(0);
    await expect(f.service.ticket(who, crypto.randomUUID())).rejects.toThrow('SPEECH_BUSY');
    expect(await f.service.start(who, canceled, input)).toBe('canceled');
    expect(await f.service.start(who, active, input)).toBe('ended');
  });
  it('retains 256 cancellation tombstones rather than evicting a still-valid ticket', async () => {
    const f = await setup();
    const who = owner();
    const first = await f.service.ticket(who, crypto.randomUUID());
    await f.service.stop(who, first);
    for (let i = 1; i < 256; i++) await f.service.ticket(who, crypto.randomUUID());
    await expect(f.service.ticket(who, crypto.randomUUID())).rejects.toThrow('SPEECH_BUSY');
    expect(await f.service.start(who, first, input)).toBe('canceled');
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(f.service.start(who, first, input)).rejects.toThrow('SPEECH_EXPIRED');
    await expect(f.service.ticket(who, crypto.randomUUID())).resolves.toMatchObject({
      epoch: f.service.epoch,
    });
  });
  it('stops and cleans a previous background lease before issuing a new epoch', async () => {
    const old: SpeechLease = {
      owner: owner(),
      ticket: {
        speechId: crypto.randomUUID(),
        epoch: crypto.randomUUID(),
        expiresAt: Date.now() + 30_000,
      },
      deadline: Date.now() + 30_000,
    };
    const f = await setup(old);
    expect(f.platform.stop).toHaveBeenCalledOnce();
    expect(f.platform.clearAlarm).toHaveBeenCalledWith(
      `${SPEECH_ALARM_PREFIX}${old.ticket.epoch}.${old.ticket.speechId}`,
    );
    expect(f.saved()).toBeUndefined();
    await expect(f.service.start(old.owner, old.ticket, input)).rejects.toThrow('SPEECH_EXPIRED');
    expect(f.platform.speak).not.toHaveBeenCalled();
  });
  it('stops at the normal timer and can also stop at its exact alarm', async () => {
    const f = await setup();
    const who = owner();
    await f.service.start(who, await f.service.ticket(who, crypto.randomUUID()), input);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.platform.stop).toHaveBeenCalledOnce();
    await f.service.start(who, await f.service.ticket(who, crypto.randomUUID()), input);
    await f.service.onAlarm(f.platform.alarm.mock.calls[1]![0]);
    expect(f.platform.stop).toHaveBeenCalledTimes(2);
    expect(f.saved()).toBeUndefined();
  });
  it('can stop even when the UI never acknowledges state notifications', async () => {
    const f = await setup();
    const who = owner();
    f.platform.notify.mockImplementation(() => new Promise(() => {}));
    const ticket = await f.service.ticket(who, crypto.randomUUID());
    expect(await f.service.start(who, ticket, input)).toBe('speaking');
    await f.service.stop(who, ticket);
    expect(f.platform.stop).toHaveBeenCalledOnce();
  });
});

it('rejects markup, automatic/unconfirmed language and arbitrary audio URL/rate fields', () => {
  const valid = {
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    type: 'speech.start',
    payload: {
      source: { origin: 'page', cardId: crypto.randomUUID(), documentNonce: crypto.randomUUID() },
      ticket: {
        speechId: crypto.randomUUID(),
        epoch: crypto.randomUUID(),
        expiresAt: Date.now() + 30_000,
      },
      input,
    },
  };
  expect(SpeechMessageSchema.safeParse(valid).success).toBe(true);
  for (const extra of [
    { text: '<speak>Hi</speak>' },
    { text: 'x'.repeat(81) },
    { language: 'auto' },
    { languageConfirmed: false },
    { rate: 2 },
    { audioUrl: 'https://example.test/audio' },
  ])
    expect(
      SpeechMessageSchema.safeParse({
        ...valid,
        payload: { ...valid.payload, input: { ...input, ...extra } },
      }).success,
    ).toBe(false);
});
