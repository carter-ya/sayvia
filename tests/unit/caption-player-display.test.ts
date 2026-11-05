// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=example"}
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CaptionController } from '../../src/captions/controller';
import { CaptionPlayerSession } from '../../src/captions/player-session';
import { encodeCaptionResponse } from '../../src/captions/bridge';
import { trackKey, type CaptionCue, type CaptionTrack } from '../../src/captions/contract';
import {
  DisplayReplySchema,
  DisplayRequestSchema,
  HIDDEN_ATTRIBUTE,
  OVERLAY_ATTRIBUTE,
  installDisplayLease,
} from '../../src/captions/display-lease';
import { CaptionStartSchema } from '../../src/runtime/learning-protocol';

const track: CaptionTrack = {
  videoId: 'example',
  lang: 'en',
  kind: null,
  name: null,
  tlang: null,
};
let controller: CaptionController;
let session: CaptionPlayerSession;
let guard: ReturnType<typeof installDisplayLease>;
let player: HTMLDivElement;
let video: HTMLVideoElement;
let native: HTMLDivElement;
let requests: Record<string, unknown>[];
let renewals: Array<ReturnType<typeof DisplayRequestSchema.parse>>;
let heldReplies: Array<ReturnType<typeof DisplayReplySchema.parse>>;
let holdFalseReplies: boolean;
let provider: { id: string; revision: number; model: string };
let taskId: string;

function emit(data: unknown) {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: typeof data === 'string' ? data : JSON.stringify(data),
    }),
  );
}
function moveTo(seconds: number) {
  video.currentTime = seconds;
  video.dispatchEvent(new Event('seeked'));
}
function result() {
  const start = requests.find((request) => request.type === 'learning.start');
  const payload = CaptionStartSchema.parse(start?.payload);
  const { sessionId, generation, videoId, trackKey, batchId, units } = payload.input;
  return {
    protocolVersion: 1,
    type: 'learning.result',
    taskId,
    clientTaskId: payload.clientTaskId,
    documentNonce: payload.documentNonce,
    canApply: false,
    provider,
    result: {
      requested: true,
      algorithmVersion: 'caption-units-v1',
      durationMs: 1,
      data: {
        purpose: 'captions',
        value: {
          sessionId,
          generation,
          videoId,
          trackKey,
          batchId,
          units: units.map((unit) => ({ ...unit, text: '已翻译' })),
        },
      },
    },
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01'));
  vi.stubGlobal('crypto', webcrypto);
  document.body.replaceChildren();
  player = document.createElement('div');
  player.id = 'movie_player';
  video = document.createElement('video');
  video.currentTime = 0.5;
  native = document.createElement('div');
  native.className = 'ytp-caption-window-container';
  native.textContent = 'Native caption';
  player.append(video, native);
  document.body.append(player);
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
  Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: null });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return (
      this.hasAttribute(OVERLAY_ATTRIBUTE)
        ? { left: 20, top: 220, right: 620, bottom: 290, width: 600, height: 70 }
        : { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 }
    ) as DOMRect;
  });
  requests = [];
  renewals = [];
  heldReplies = [];
  holdFalseReplies = false;
  provider = { id: crypto.randomUUID(), revision: 1, model: 'fixture' };
  taskId = crypto.randomUUID();
  const generation = crypto.randomUUID();
  const granted = {
    sessionId: crypto.randomUUID(),
    generation: 0,
    videoId: track.videoId,
    trackKey: trackKey(track),
    captureGeneration: generation,
  };
  const request = async (message: Record<string, unknown>): Promise<unknown> => {
    requests.push(message);
    if (message.type === 'captions.configuration')
      return { ok: true, provider, targetLanguage: 'zh-Hans' };
    if (message.type === 'captions.grant') return { ok: true, session: granted };
    if (String(message.type).startsWith('captions.'))
      return { ok: true, enabled: true, authorized: true };
    const payload = message.payload as { clientTaskId: string; documentNonce: string };
    return {
      ok: true,
      data: {
        clientTaskId: payload.clientTaskId,
        documentNonce: payload.documentNonce,
        taskId,
        provider,
        canApply: false,
        cancelPending: false,
        state: message.type === 'translation.cancel' ? 'canceled' : 'running',
      },
    };
  };
  // Model transport is simulated; controller, grouping, scheduler, overlay and
  // MAIN lease guard are real. Hold selected replies to exercise event ordering.
  vi.spyOn(window, 'postMessage').mockImplementation((raw) => {
    const data: unknown = JSON.parse(String(raw));
    const outgoing = DisplayRequestSchema.safeParse(data);
    if (outgoing.success) {
      if (outgoing.data.type === 'renew') renewals.push(outgoing.data);
      emit(raw);
      return;
    }
    const reply = DisplayReplySchema.safeParse(data);
    if (reply.success) {
      if (!reply.data.active && holdFalseReplies) heldReplies.push(reply.data);
      else emit(raw);
    }
  });
  guard = installDisplayLease(window, () => ({
    generation,
    trackKey: trackKey(track),
    player,
    ready: true,
  }));
  controller = new CaptionController({ request, alive: () => true });
  await controller.confirm();
  emit({
    channel: 'sayvia.capture.v1',
    type: 'state',
    generation,
    videoId: 'example',
    track,
    reason: 'ready',
  });
  const cues: CaptionCue[] = [
    [0, 1000],
    [2000, 4000],
  ].map(([start, end], index) => ({
    id: String(index),
    revision: 0,
    start: start!,
    end: end!,
    windowId: '0',
    text: `Original ${index}`,
    events: [index],
    revised: false,
  }));
  const grouped = new Promise<void>((resolve) => {
    const unsubscribe = controller.subscribe((view) => {
      if (view.groups.length === 2) {
        unsubscribe();
        resolve();
      }
    });
  });
  for (const chunk of encodeCaptionResponse({ generation, track }, cues)) emit(chunk);
  await grouped;
  session = new CaptionPlayerSession(controller, request);
  await session.loadConfiguration();
  await session.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(session.snapshot().active).toBe(true);
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(true);
});

afterEach(async () => {
  session?.dispose();
  await session?.confirmStop();
  controller?.dispose();
  guard?.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('renews immediately after a short gap and ignores the previous false ACK', async () => {
  const oldRenewal = renewals.at(-1)!;
  holdFalseReplies = true;
  await vi.advanceTimersByTimeAsync(100);
  moveTo(1.5);
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  await vi.advanceTimersByTimeAsync(150); // MAIN notices the gap and sends false for the old lease.
  expect(heldReplies.some((reply) => reply.requestId === oldRenewal.requestId)).toBe(true);
  await vi.advanceTimersByTimeAsync(50);
  moveTo(2.5); // Only 300 ms since the preceding lease, inside its normal 500 ms throttle.
  expect(renewals.at(-1)!.requestId).not.toBe(oldRenewal.requestId);
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(true);
  for (const reply of heldReplies.splice(0)) emit(reply);
  expect(session.snapshot().active).toBe(true);
  expect(session.snapshot().error).toBeUndefined();
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(true);
  expect(requests.filter((request) => request.type === 'learning.start')).toHaveLength(1);
});

it('restores native in translation-only mode until the actual translation arrives', async () => {
  session.setMode('translation');
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  expect(getComputedStyle(native).visibility).not.toBe('hidden');
  expect(player.querySelector<HTMLElement>(`[${OVERLAY_ATTRIBUTE}]`)!.hidden).toBe(true);
  await vi.advanceTimersByTimeAsync(250);
  expect(session.snapshot().active).toBe(true);
  expect(session.receive(result())).toBe(true);
  expect(player.querySelector<HTMLElement>(`[${OVERLAY_ATTRIBUTE}]`)!.hidden).toBe(false);
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(true);
  expect(native.textContent).toBe('Native caption');
});

it('ignores late lease and model replies after stop and cannot revive the retired overlay', async () => {
  const oldRenewal = renewals.at(-1)!;
  const lateResult = result();
  session.stop();
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  expect(player.querySelector(`[${OVERLAY_ATTRIBUTE}]`)).toBeNull();
  expect(await session.confirmStop()).toBe(true);
  for (const active of [true, false])
    emit({
      ...oldRenewal,
      type: undefined,
      channel: 'sayvia.caption.display.status.v1',
      active,
    });
  emit(oldRenewal);
  expect(session.receive(lateResult)).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(session.snapshot().active).toBe(false);
  expect(player.hasAttribute(HIDDEN_ATTRIBUTE)).toBe(false);
  expect(getComputedStyle(native).visibility).not.toBe('hidden');
  expect(requests.filter((request) => request.type === 'learning.start')).toHaveLength(1);
});
