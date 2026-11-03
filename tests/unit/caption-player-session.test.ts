// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=example"}
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CaptionPlayerSession } from '../../src/captions/player-session';
import type { CaptionController, CaptionView } from '../../src/captions/controller';
import { trackKey } from '../../src/captions/contract';
import { TaskMessageSchema } from '../../src/runtime/task-protocol';
import type { CaptionProvider } from '../../src/runtime/caption-protocol';
import type { CaptionInput } from '../../src/core/learning-contract';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const sessions: CaptionPlayerSession[] = [];

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  vi.setSystemTime(new Date('2026-01-01'));
  document.body.innerHTML = '<div id="movie_player"><video></video></div>';
  Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, value: null });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await flush();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture(holdGrant = false) {
  const documentNonce = crypto.randomUUID();
  let provider: CaptionProvider = { id: crypto.randomUUID(), revision: 0, model: 'fixture' };
  const track = { videoId: 'example', lang: 'en', kind: null, name: null, tlang: null };
  const generation = crypto.randomUUID();
  let view: CaptionView = {
    enabled: true,
    processing: false,
    capture: {
      channel: 'sayvia.capture.v1',
      type: 'state',
      generation,
      videoId: track.videoId,
      track,
      reason: 'ready',
    },
    groups: Array.from({ length: 20 }, (_, i) => ({
      unitId: `g${i}`,
      revision: 0,
      start: i * 10_000,
      end: (i + 1) * 10_000,
      text: `Caption ${i}`,
      windowId: '1',
      sources: [{ id: `s${i}`, revision: 0 }],
    })),
  };
  const listeners = new Set<(value: CaptionView) => void>();
  const emit = () => {
    for (const listener of listeners) listener(view);
  };
  const grantEntered = deferred();
  const grantReady = deferred();
  const controller = {
    documentNonce,
    snapshot: () => view,
    subscribe(listener: (value: CaptionView) => void) {
      listeners.add(listener);
      listener(view);
      return () => {
        listeners.delete(listener);
      };
    },
    enableTranslation: vi.fn(async () => {
      grantEntered.resolve();
      if (holdGrant) await grantReady.promise;
      // Deliberately deliver even after a stop: the session's own generation
      // fence must protect dispatch independently of the controller's fence.
      const granted = {
        sessionId: crypto.randomUUID(),
        generation: 0,
        videoId: track.videoId,
        trackKey: trackKey(track),
        captureGeneration: generation,
      };
      view = { ...view, session: granted };
      emit();
      return granted;
    }),
    disableTranslation: vi.fn(async () => {
      view = { ...view, session: undefined };
      emit();
    }),
  };
  let cancelPending = false;
  let cancelAckLost = false;
  const starts: Array<{ clientTaskId: string; input: CaptionInput }> = [];
  const cancellations: string[] = [];
  const tasks = new Map<string, { taskId: string; provider: CaptionProvider }>();
  const request = vi.fn(async (raw: Record<string, unknown>): Promise<unknown> => {
    if (raw.type === 'captions.configuration')
      return { ok: true, provider: { ...provider }, targetLanguage: 'zh-Hans' };
    const message = TaskMessageSchema.parse(raw);
    if (message.type === 'translation.manual.read') throw new Error('Unexpected manual request');
    const { clientTaskId } = message.payload;
    if (message.type === 'learning.start') {
      if (message.payload.purpose !== 'captions') throw new Error('Unexpected lookup');
      starts.push({ clientTaskId, input: message.payload.input });
      tasks.set(clientTaskId, {
        taskId: crypto.randomUUID(),
        provider: message.payload.expectedProvider,
      });
    }
    if (message.type === 'translation.cancel') {
      cancellations.push(clientTaskId);
      if (cancelAckLost) throw new Error('CANCEL_ACK_LOST');
    }
    const task = tasks.get(clientTaskId);
    if (!task) throw new Error('Unexpected task identity');
    return {
      ok: true,
      data: {
        clientTaskId,
        documentNonce,
        ...task,
        canApply: false,
        state: message.type === 'translation.cancel' ? 'canceled' : 'running',
        cancelPending: message.type === 'translation.cancel' && cancelPending,
      },
    };
  });
  const session = new CaptionPlayerSession(controller as unknown as CaptionController, request);
  sessions.push(session);
  await session.loadConfiguration();
  return {
    session,
    controller,
    starts,
    cancellations,
    grantEntered: grantEntered.promise,
    releaseGrant: grantReady.resolve,
    player: document.getElementById('movie_player')!,
    video: document.querySelector('video')!,
    setCancelPending(value: boolean) {
      cancelPending = value;
    },
    setCancelAckLost(value: boolean) {
      cancelAckLost = value;
    },
    changeConfiguration() {
      provider = { ...provider, revision: provider.revision + 1, model: 'changed' };
      session.configurationChanged();
    },
  };
}

it.each(['video', 'player'] as const)(
  'does not dispatch when the %s is replaced while a video grant is pending',
  async (node) => {
    const f = await fixture(true);
    const starting = f.session.start();
    await f.grantEntered;
    if (node === 'video') f.video.replaceWith(document.createElement('video'));
    else {
      const replacement = document.createElement('div');
      replacement.id = 'movie_player';
      replacement.append(document.createElement('video'));
      f.player.replaceWith(replacement);
    }
    f.releaseGrant();
    await starting;
    await flush();
    expect(f.starts).toHaveLength(0);
    expect(f.session.snapshot()).toMatchObject({ active: false, starting: false });
    expect(f.controller.disableTranslation).toHaveBeenCalled();
  },
);

it('uses the latest actual media time before the first scheduler dispatch', async () => {
  const f = await fixture(true);
  f.video.currentTime = 40;
  const starting = f.session.start();
  await f.grantEntered;
  f.video.currentTime = 85;
  f.releaseGrant();
  await starting;
  await flush();
  expect(f.starts).toHaveLength(1);
  expect(f.starts[0]!.input.units.map((unit) => unit.unitId)).toEqual(['g8', 'g9', 'g10', 'g11']);
  expect(f.session.snapshot().active).toBe(true);
});

it.each(['stop', 'configuration'] as const)(
  'does not dispatch or revive after %s invalidates an outstanding grant',
  async (action) => {
    const f = await fixture(true);
    const starting = f.session.start();
    await f.grantEntered;
    if (action === 'stop') f.session.stop();
    else f.changeConfiguration();
    f.releaseGrant();
    await starting;
    await flush();
    expect(f.starts).toHaveLength(0);
    expect(f.session.snapshot()).toMatchObject({ active: false, starting: false });
    if (action === 'configuration') expect(f.session.snapshot().model).toBe('changed');
  },
);

it.each(['pending', 'lost ACK'] as const)(
  'retains an unconfirmed cancellation (%s) until same-identity confirmation',
  async (reason) => {
    const f = await fixture();
    await f.session.start();
    await flush();
    expect(f.starts).toHaveLength(1);
    const original = f.starts[0]!.clientTaskId;
    f.setCancelPending(reason === 'pending');
    f.setCancelAckLost(reason === 'lost ACK');
    f.session.stop();
    expect(await f.session.confirmStop()).toBe(false);
    expect(f.session.snapshot()).toMatchObject({ active: false, stopping: true });
    await f.session.start();
    expect(f.starts).toHaveLength(1);
    expect(f.session.snapshot().stopping).toBe(true);
    f.setCancelPending(false);
    f.setCancelAckLost(false);
    expect(await f.session.confirmStop()).toBe(true);
    expect(f.session.snapshot().stopping).toBe(false);
    expect(f.starts).toHaveLength(1);
    expect(f.cancellations.length).toBeGreaterThanOrEqual(3);
    expect(f.cancellations.every((id) => id === original)).toBe(true);
    await f.session.start();
    await flush();
    expect(f.starts).toHaveLength(2);
    expect(f.starts[1]!.clientTaskId).not.toBe(original);
  },
);
