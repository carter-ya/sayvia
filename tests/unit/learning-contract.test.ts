import { describe, expect, it } from 'vitest';
import {
  CaptionInputSchema,
  LookupInputSchema,
  parseCaptionResult,
  parseLookupResult,
} from '../../src/core/learning-contract';
import { LearningStartMessage } from '../../src/runtime/learning-protocol';

const input = () => ({
  sessionId: crypto.randomUUID(),
  generation: 3,
  videoId: 'example',
  trackKey: 'en:asr',
  batchId: crypto.randomUUID(),
  sourceLanguage: 'en',
  targetLanguage: 'zh-CN',
  units: [
    { unitId: 'g0', revision: 2, text: 'behind the wheel' },
    { unitId: 'g1', revision: 4, text: 'that works fine' },
  ],
});
const lookup = () => ({
  detectedLanguage: 'EN-us',
  meanings: [{ partOfSpeech: null, definition: 'a place for money' }],
  example: null,
  note: null,
});

describe('bounded learning input and structured results', () => {
  it('counts code points, preserves CJK phrases and canonicalizes language tags', () => {
    expect(
      LookupInputSchema.parse({
        text: '学习',
        sourceLanguage: 'auto',
        explanationLanguage: 'zh-cn',
      }),
    ).toEqual({ text: '学习', sourceLanguage: 'auto', explanationLanguage: 'zh-CN' });
    expect(
      LookupInputSchema.safeParse({
        text: '😀'.repeat(80),
        sourceLanguage: 'en',
        explanationLanguage: 'fr',
      }).success,
    ).toBe(true);
    expect(
      LookupInputSchema.safeParse({
        text: '😀'.repeat(81),
        sourceLanguage: 'en',
        explanationLanguage: 'fr',
      }).success,
    ).toBe(false);
    for (const language of ['auto', 'en_US', '', 'a'.repeat(41)])
      expect(
        LookupInputSchema.safeParse({
          text: 'word',
          sourceLanguage: 'en',
          explanationLanguage: language,
        }).success,
      ).toBe(false);
  });

  it('accepts uncertain part of speech but rejects missing, extra or oversized dictionary fields', () => {
    expect(parseLookupResult(JSON.stringify(lookup())).detectedLanguage).toBe('en-US');
    for (const value of [
      { ...lookup(), audioUrl: 'https://untrusted.test' },
      { ...lookup(), meanings: [] },
      { ...lookup(), meanings: [{ partOfSpeech: 'noun', definition: ' '.repeat(10) }] },
      { ...lookup(), meanings: [{ partOfSpeech: null, definition: '词'.repeat(301) }] },
      { ...lookup(), example: { text: 'hello', translation: '你好', audio: 'file' } },
    ])
      expect(() => parseLookupResult(JSON.stringify(value))).toThrow('FORMAT_INVALID');
    expect(() => parseLookupResult(' '.repeat(16 * 1024 + 1))).toThrow('FORMAT_INVALID');
  });

  it('rejects repeated IDs and aggregate input excess before a model request', () => {
    const batch = input();
    expect(
      CaptionInputSchema.safeParse({ ...batch, units: [batch.units[0], batch.units[0]] }).success,
    ).toBe(false);
    expect(
      CaptionInputSchema.safeParse({
        ...batch,
        units: batch.units.map((u) => ({ ...u, text: '字'.repeat(3001) })),
      }).success,
    ).toBe(false);
    expect(
      CaptionInputSchema.safeParse({
        ...batch,
        units: batch.units.map((u) => ({ ...u, startMs: 123 })),
      }).success,
    ).toBe(false);
  });

  it('binds results to local identity and revision without accepting model timestamps', () => {
    const batch = input();
    const content = {
      cues: [
        { id: 'g0', text: '掌舵' },
        { id: 'g1', text: '这样很好' },
      ],
    };
    const result = parseCaptionResult(JSON.stringify(content), batch);
    expect(result).toMatchObject({
      sessionId: batch.sessionId,
      generation: 3,
      batchId: batch.batchId,
      units: [
        { unitId: 'g0', revision: 2, text: '掌舵' },
        { unitId: 'g1', revision: 4, text: '这样很好' },
      ],
    });
    for (const cues of [
      content.cues.slice(0, 1),
      [...content.cues].reverse(),
      [content.cues[0], content.cues[0]],
      [{ id: 'unknown', text: 'x' }, content.cues[1]],
      [{ id: ' g0 ', text: 'x' }, content.cues[1]],
      [{ id: 'g0', text: 'a\nb' }, content.cues[1]],
      [{ id: 'g0', text: 'x', startMs: 0 }, content.cues[1]],
    ])
      expect(() => parseCaptionResult(JSON.stringify({ cues }), batch)).toThrow('FORMAT_INVALID');
  });
});

describe('learning task source boundary', () => {
  const envelope = () => ({
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    type: 'learning.start',
  });
  const owner = () => ({ clientTaskId: crypto.randomUUID(), documentNonce: crypto.randomUUID() });
  it('rejects captions from a popup, supplied page tab IDs and write capabilities', () => {
    const payload = { ...owner(), purpose: 'captions', origin: 'page', input: input() };
    expect(LearningStartMessage.safeParse({ ...envelope(), payload }).success).toBe(true);
    for (const extra of [
      { origin: 'manual' },
      { tabId: 42 },
      { editorSessionId: crypto.randomUUID() },
      { canApply: true },
    ])
      expect(
        LearningStartMessage.safeParse({ ...envelope(), payload: { ...payload, ...extra } })
          .success,
      ).toBe(false);
  });
  it('requires a revision and generation for manual lookup while page lookup has neither', () => {
    const payload = {
      ...owner(),
      purpose: 'lookup',
      origin: 'page',
      input: { text: 'bank', sourceLanguage: 'en', explanationLanguage: 'zh-CN' },
    };
    expect(LearningStartMessage.safeParse({ ...envelope(), payload }).success).toBe(true);
    expect(
      LearningStartMessage.safeParse({
        ...envelope(),
        payload: { ...payload, origin: 'manual', tabId: 4 },
      }).success,
    ).toBe(false);
    expect(
      LearningStartMessage.safeParse({
        ...envelope(),
        payload: {
          ...payload,
          origin: 'manual',
          tabId: 4,
          manualRevision: 0,
          manualGeneration: crypto.randomUUID(),
        },
      }).success,
    ).toBe(true);
    expect(
      LearningStartMessage.safeParse({ ...envelope(), payload: { ...payload, manualRevision: 0 } })
        .success,
    ).toBe(false);
  });
});
