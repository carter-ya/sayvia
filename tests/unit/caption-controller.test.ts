// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=example"}
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
const grouping = vi.hoisted(() => vi.fn());
vi.mock('../../src/captions/group', () => ({ groupCaptions: grouping }));
import { CaptionController } from '../../src/captions/controller';
import { encodeCaptionResponse } from '../../src/captions/bridge';
import { trackKey, type CaptionCue, type CaptionTrack } from '../../src/captions/contract';
import type { CaptureState } from '../../src/captions/player';
const track: CaptionTrack = { videoId: 'example', lang: 'en', kind: null, name: null, tlang: null };
const capture: CaptureState = {
  channel: 'sayvia.capture.v1',
  type: 'state',
  generation: crypto.randomUUID(),
  videoId: 'example',
  track,
  reason: 'ready',
};
const cue: CaptionCue = {
  id: 'a',
  revision: 0,
  start: 0,
  end: 1000,
  windowId: '0',
  text: 'hello',
  events: [0],
  revised: false,
};
const session = {
  sessionId: crypto.randomUUID(),
  generation: 0,
  videoId: track.videoId,
  trackKey: trackKey(track),
  captureGeneration: capture.generation,
};
const group = {
  unitId: 'a',
  revision: 0,
  start: 0,
  end: 1000,
  windowId: '0',
  text: 'hello',
  sources: [{ id: 'a', revision: 0 }],
};
let controller: CaptionController;
let request: Mock<(message: Record<string, unknown>) => Promise<unknown>>;
let sent: Array<Record<string, unknown>>;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function message(
  data: unknown,
  origin = 'https://www.youtube.com',
  source: MessageEventSource | null = window,
) {
  window.dispatchEvent(
    new MessageEvent('message', {
      source,
      origin,
      data: typeof data === 'string' ? data : JSON.stringify(data),
    }),
  );
}
function cues() {
  for (const chunk of encodeCaptionResponse({ generation: capture.generation, track }, [cue]))
    message(chunk);
}
async function ready() {
  await controller.confirm();
  message(capture);
  cues();
  await vi.advanceTimersByTimeAsync(0);
}
beforeEach(() => {
  vi.useFakeTimers();
  history.replaceState({}, '', '/watch?v=example');
  grouping.mockReset().mockResolvedValue([group]);
  sent = [];
  vi.spyOn(window, 'postMessage').mockImplementation((value) => {
    sent.push(JSON.parse(String(value)));
  });
  request = vi.fn(async (value: Record<string, unknown>) =>
    value.type === 'captions.grant'
      ? { ok: true, session }
      : { ok: true, enabled: true, authorized: true },
  );
  controller = new CaptionController({ request, alive: () => true });
});
afterEach(() => {
  controller.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('only captures bounded source data until explicit video opt-in, with no duplicate replay while a normal response arrives', async () => {
  await ready();
  expect(controller.snapshot().groups).toEqual([group]);
  expect(request.mock.calls.some(([value]) => value.type === 'captions.grant')).toBe(false);
  await vi.advanceTimersByTimeAsync(600);
  expect(sent.filter((value) => value.type === 'replay' && value.generation)).toHaveLength(0);
  expect(await controller.enableTranslation()).toEqual(session);
});
it('requests one bounded replay when an early captured response was missed', async () => {
  await controller.confirm();
  message(capture);
  await vi.advanceTimersByTimeAsync(500);
  expect(sent.filter((value) => value.type === 'replay' && value.generation)).toHaveLength(1);
  message(capture);
  await vi.advanceTimersByTimeAsync(1000);
  expect(sent.filter((value) => value.type === 'replay' && value.generation)).toHaveLength(1);
});
it('rejects wrong-window, wrong-origin and mismatched-video bridge data', async () => {
  await controller.confirm();
  message(capture, 'https://example.test');
  message(capture, undefined, null);
  message({ ...capture, videoId: 'other' });
  cues();
  expect(controller.snapshot().capture).toBeUndefined();
  expect(grouping).not.toHaveBeenCalled();
});
it('navigation and freeze cancel in-progress grouping and require a new background confirmation', async () => {
  const pending = deferred<unknown[]>();
  grouping.mockReturnValueOnce(pending.promise);
  await controller.confirm();
  message(capture);
  cues();
  expect(controller.snapshot().processing).toBe(true);
  document.dispatchEvent(new Event('freeze'));
  expect(grouping.mock.calls[0]![2].aborted).toBe(true);
  pending.resolve([group]);
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.snapshot()).toMatchObject({ enabled: false, groups: [] });
  message(capture);
  cues();
  expect(controller.snapshot().groups).toEqual([]);
  const beforeResume = request.mock.calls.filter(
    ([value]) => value.type === 'captions.ensure',
  ).length;
  document.dispatchEvent(new Event('resume'));
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls.filter(([value]) => value.type === 'captions.ensure')).toHaveLength(
    beforeResume + 1,
  );
  await ready();
  await controller.enableTranslation();
  history.pushState({}, '', '/watch?v=other');
  await vi.advanceTimersByTimeAsync(500);
  expect(controller.snapshot().session).toBeUndefined();
  expect(controller.snapshot().groups).toEqual([]);
});
it('ignores a grant arriving after stop without accepting a late active session', async () => {
  await ready();
  const pending = deferred<unknown>();
  request.mockImplementationOnce(() => pending.promise);
  const start = controller.enableTranslation();
  const rejected = expect(start).rejects.toThrow('CAPTION_NOT_READY');
  await controller.disableTranslation();
  pending.resolve({ ok: true, session });
  await rejected;
  expect(controller.snapshot().session).toBeUndefined();
});
it('a periodic check without a session cannot revoke a subsequently granted session', async () => {
  await ready();
  const pending = deferred<unknown>();
  request.mockImplementation(async (value) =>
    value.type === 'captions.check'
      ? pending.promise
      : value.type === 'captions.grant'
        ? { ok: true, session }
        : { ok: true, enabled: true },
  );
  await vi.advanceTimersByTimeAsync(5000);
  await controller.enableTranslation();
  pending.resolve({ ok: true, enabled: true, authorized: false });
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.snapshot().session).toEqual(session);
});
it('a missing background check expires instead of keeping capture alive indefinitely', async () => {
  await ready();
  request.mockImplementation(async (value) =>
    value.type === 'captions.check' ? new Promise(() => {}) : { ok: true },
  );
  await vi.advanceTimersByTimeAsync(7600);
  expect(controller.snapshot().enabled).toBe(false);
  expect(sent.at(-1)?.type).toBe('stop');
});
it('a late enable response cannot override pause', async () => {
  await controller.confirm();
  controller.pause();
  const pending = deferred<unknown>();
  request.mockImplementationOnce(() => pending.promise);
  const confirm = controller.confirm();
  controller.pause();
  pending.resolve({ ok: true, enabled: true });
  expect(await confirm).toBe(false);
  expect(controller.snapshot().enabled).toBe(false);
});

it('creates a fresh background confirmation when freeze and resume overtake an in-flight ensure', async () => {
  await controller.confirm();
  controller.pause();
  const pending = deferred<unknown>();
  request.mockImplementationOnce(() => pending.promise);
  const old = controller.confirm();
  document.dispatchEvent(new Event('freeze'));
  const before = request.mock.calls.filter(([value]) => value.type === 'captions.ensure').length;
  document.dispatchEvent(new Event('resume'));
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls.filter(([value]) => value.type === 'captions.ensure')).toHaveLength(
    before + 1,
  );
  expect(controller.snapshot().enabled).toBe(true);
  pending.resolve({ ok: true, enabled: true });
  await old;
  expect(controller.snapshot().enabled).toBe(true);
});
it('does not charge its own control messages against the MAIN data budget', async () => {
  await controller.confirm();
  message(capture);
  for (let i = 0; i < 100; i++)
    message({
      channel: 'sayvia.capture.control.v1',
      type: 'heartbeat',
      generation: capture.generation,
    });
  cues();
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.snapshot().groups).toEqual([group]);
  expect(controller.snapshot().error).toBeUndefined();
});
