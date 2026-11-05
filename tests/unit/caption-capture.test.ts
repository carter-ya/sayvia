// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://www.youtube.com/watch?v=example"}
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { installYouTubeCapture } from '../../src/captions/capture-main';
import { observePlayer } from '../../src/captions/player';

class FakeXHR extends EventTarget {
  responseURL = '';
  responseText = '';
  responseType = '';
  status = 200;
  open(_method: string, url: string) {
    this.responseURL = new URL(url, location.href).href;
  }
  send() {}
  finish(text = 'hello', fields = {}) {
    this.responseText = JSON.stringify({
      wireMagic: 'pb3',
      events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: text }] }],
    });
    Object.assign(this, fields);
    this.dispatchEvent(new Event('loadend'));
  }
}
type WindowCapture = typeof window & { __sayviaCapture?: { stop(): void; active(): boolean } };
const endpoint = (language = 'en', video = 'example') =>
  `https://www.youtube.com/api/timedtext?v=${video}&lang=${language}&fmt=json3&sig=never-forward`;
let selected: unknown;
let videoId: string;
let player: HTMLElement;
let option: ReturnType<typeof vi.fn>;
let emitted: Array<Record<string, unknown>>;
let fetchOriginal: ReturnType<typeof vi.fn>;
const chunks = () => emitted.filter((value) => value.channel === 'sayvia.captions.v1');
function xhr(language = 'en', video = 'example') {
  const request = new (window.XMLHttpRequest as unknown as typeof FakeXHR)();
  request.open('GET', endpoint(language, video));
  request.send();
  return request;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  history.replaceState({}, '', '/watch?v=example');
  videoId = 'example';
  selected = { languageCode: 'en' };
  player = document.createElement('div');
  player.id = 'movie_player';
  option = vi.fn(() => selected);
  Object.assign(player, { getOption: option, getVideoData: () => ({ video_id: videoId }) });
  document.body.replaceChildren(player);
  emitted = [];
  vi.spyOn(window, 'postMessage').mockImplementation((raw) => {
    emitted.push(JSON.parse(String(raw)));
  });
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  fetchOriginal = vi.fn(() => Promise.resolve(new Response('unchanged player response')));
  vi.stubGlobal('fetch', fetchOriginal);
});
afterEach(() => {
  (window as WindowCapture).__sayviaCapture?.stop();
  delete (window as WindowCapture).__sayviaCapture;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('normal text XHR is captured once without forwarding signatures or altering the site response', async () => {
  const originalOpen = window.XMLHttpRequest.prototype.open;
  installYouTubeCapture();
  const request = xhr();
  request.finish('same caption');
  await vi.advanceTimersByTimeAsync(0);
  expect(chunks()).toHaveLength(1);
  expect((chunks()[0]!.cues as Array<{ text: string }>)[0]!.text).toBe('same caption');
  expect(JSON.stringify(emitted)).not.toContain('never-forward');
  expect(request.responseText).toContain('same caption');
  (window as WindowCapture).__sayviaCapture!.stop();
  expect(window.XMLHttpRequest.prototype.open).toBe(originalOpen);
});

test('reinjection stops an active v3 MAIN capture and replaces it with the current guard', () => {
  const old = { version: 'capture-v3', active: () => true, stop: vi.fn() };
  Object.assign(window, { __sayviaCapture: old });
  installYouTubeCapture();
  expect(old.stop).toHaveBeenCalledOnce();
  expect((window as WindowCapture).__sayviaCapture).toMatchObject({ version: 'capture-v4' });
});

test('a request preceding the next player sample survives only when its exact track becomes selected', async () => {
  selected = null;
  installYouTubeCapture();
  const request = xhr('fr');
  request.finish('bonjour');
  selected = { languageCode: 'fr' };
  await vi.advanceTimersByTimeAsync(250);
  expect(chunks()).toHaveLength(1);
  expect(chunks()[0]!.track).toMatchObject({ lang: 'fr' });
});

test('an early response stays local until the same player identifies its first track', async () => {
  selected = null;
  Object.assign(player, { getOption: undefined });
  installYouTubeCapture();
  xhr().finish('first English track');
  await vi.advanceTimersByTimeAsync(500);
  Object.assign(player, { getOption: option });
  await vi.advanceTimersByTimeAsync(500);
  expect(chunks()).toHaveLength(0);
  selected = { languageCode: 'en' };
  await vi.advanceTimersByTimeAsync(250);
  expect(chunks()).toHaveLength(1);
  expect(chunks()[0]!.track).toMatchObject({ videoId: 'example', lang: 'en', kind: null });
});

test.each(['wrong track', 'new player', 'new video', 'deadline', 'stop'] as const)(
  'an unconfirmed first response is discarded on %s and cannot return later',
  async (change) => {
    selected = null;
    installYouTubeCapture();
    xhr().finish('discard me');
    await vi.advanceTimersByTimeAsync(750);
    switch (change) {
      case 'wrong track':
        selected = { languageCode: 'en', kind: 'asr' };
        break;
      case 'new player': {
        const replacement = player.cloneNode() as HTMLElement;
        Object.assign(replacement, {
          getOption: option,
          getVideoData: () => ({ video_id: videoId }),
        });
        player.replaceWith(replacement);
        break;
      }
      case 'new video':
        videoId = 'second';
        history.replaceState({}, '', '/watch?v=second');
        break;
      case 'deadline':
        await vi.advanceTimersByTimeAsync(9500);
        break;
      case 'stop':
        (window as WindowCapture).__sayviaCapture!.stop();
        break;
    }
    await vi.advanceTimersByTimeAsync(250);
    videoId = 'example';
    history.replaceState({}, '', '/watch?v=example');
    selected = { languageCode: 'en' };
    await vi.advanceTimersByTimeAsync(500);
    expect(chunks()).toHaveLength(0);
  },
);

test('a pending first network request loses startup tolerance once a track has been identified', async () => {
  selected = null;
  installYouTubeCapture();
  const first = xhr();
  selected = { languageCode: 'en' };
  await vi.advanceTimersByTimeAsync(250);
  selected = null;
  await vi.advanceTimersByTimeAsync(250);
  selected = { languageCode: 'en' };
  await vi.advanceTimersByTimeAsync(250);
  first.finish('response from before CC was turned off');
  expect(chunks()).toHaveLength(0);
});

test('a sample after the absolute deadline cannot accept the body before its delayed timer fires', async () => {
  selected = null;
  installYouTubeCapture();
  xhr().finish('expired before the track appeared');
  await vi.advanceTimersByTimeAsync(9750);
  selected = { languageCode: 'en' };
  vi.setSystemTime(Date.now() + 500);
  // Request interception samples the player immediately, before any timer callback.
  const fresh = xhr();
  await Promise.resolve();
  expect(chunks()).toHaveLength(0);
  expect(emitted.filter((event) => event.code === 'CAPTION_REQUEST_FAILED')).toHaveLength(1);
  fresh.finish('fresh body');
  await vi.advanceTimersByTimeAsync(0);
  expect(chunks()).toHaveLength(1);
});

test('a response that expires while queued for bridge emission is not emitted or cached for replay', async () => {
  installYouTubeCapture();
  const late = xhr();
  await vi.advanceTimersByTimeAsync(9750);
  late.finish('expired in the bridge queue');
  // finish validated and queued the response. Cross the deadline before its send microtask.
  vi.setSystemTime(Date.now() + 500);
  await vi.advanceTimersByTimeAsync(0);
  const generation = emitted.findLast((value) => value.type === 'state')!.generation;
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: JSON.stringify({ channel: 'sayvia.capture.control.v1', type: 'replay', generation }),
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(chunks()).toHaveLength(0);
  expect(emitted.filter((event) => event.code === 'CAPTION_REQUEST_FAILED')).toHaveLength(1);
});

test('expiry between bridge chunks prevents the receiver from assembling the expired response', async () => {
  installYouTubeCapture();
  const late = xhr();
  await vi.advanceTimersByTimeAsync(9750);
  vi.mocked(window.postMessage).mockImplementation((raw) => {
    const event = JSON.parse(String(raw));
    emitted.push(event);
    if (event.type === 'cues' && event.sequence === 0) vi.setSystemTime(Date.now() + 500);
  });
  late.finish('', {
    responseText: JSON.stringify({
      wireMagic: 'pb3',
      events: Array.from({ length: 101 }, (_, index) => ({
        tStartMs: index * 1000,
        dDurationMs: 900,
        segs: [{ utf8: 'public cue' }],
      })),
    }),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(chunks()).toHaveLength(1);
  expect(chunks()[0]).toMatchObject({ sequence: 0, total: 2 });
  expect(emitted.filter((event) => event.code === 'CAPTION_REQUEST_FAILED')).toHaveLength(1);
});

test('the first sampled A track rejects a conflicting candidate after an unsampled A to B to A navigation', async () => {
  installYouTubeCapture(); // A/en already observed.
  history.pushState({}, '', '/watch?v=second');
  xhr('en', 'second');
  history.pushState({}, '', '/watch?v=example');
  const wrong = xhr('fr'); // A/fr candidate, before the next private sample.
  await vi.advanceTimersByTimeAsync(250); // A/en, identical to the previous private sample.
  selected = { languageCode: 'fr' };
  await vi.advanceTimersByTimeAsync(250);
  wrong.finish('old French candidate');
  await vi.advanceTimersByTimeAsync(0);
  expect(chunks()).toHaveLength(0);
});

test('navigation and a replaced player discard old responses and do not merge tracks', async () => {
  installYouTubeCapture();
  const old = xhr();
  history.pushState({}, '', '/watch?v=second');
  videoId = 'second';
  await vi.advanceTimersByTimeAsync(250);
  old.finish('old video');
  const current = xhr('en', 'second');
  const replacement = player.cloneNode() as HTMLElement;
  Object.assign(replacement, { getOption: option, getVideoData: () => ({ video_id: videoId }) });
  player.replaceWith(replacement);
  await vi.advanceTimersByTimeAsync(250);
  current.finish('old player');
  await vi.advanceTimersByTimeAsync(0);
  expect(chunks()).toHaveLength(0);
});

test('changing away and back cannot revive a pending old track response', async () => {
  installYouTubeCapture();
  const old = xhr();
  selected = { languageCode: 'fr' };
  await vi.advanceTimersByTimeAsync(250);
  selected = { languageCode: 'en' };
  await vi.advanceTimersByTimeAsync(250);
  old.finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(chunks()).toHaveLength(0);
});

test('player replacement is detected before the next private API sample, retaining the new first response', async () => {
  installYouTubeCapture();
  const old = xhr();
  const replacement = player.cloneNode() as HTMLElement;
  Object.assign(replacement, { getOption: option, getVideoData: () => ({ video_id: videoId }) });
  player.replaceWith(replacement);
  old.finish('old player');
  const current = xhr();
  current.finish('new player');
  await vi.advanceTimersByTimeAsync(250);
  expect(chunks()).toHaveLength(1);
  expect((chunks()[0]!.cues as Array<{ text: string }>)[0]!.text).toBe('new player');
});

test('a third pending subtitle request reports capacity without canceling the site request', async () => {
  installYouTubeCapture();
  xhr();
  xhr();
  const third = xhr();
  third.finish('still available to site');
  await vi.advanceTimersByTimeAsync(0);
  expect(chunks()).toHaveLength(0);
  expect(emitted.some((event) => event.code === 'CAPTION_LIMIT')).toBe(true);
  expect(third.responseText).toContain('still available to site');
});

test('a reused XHR cannot dispatch the response under its previous identity', async () => {
  installYouTubeCapture();
  const request = xhr();
  request.open('GET', endpoint('fr'));
  selected = { languageCode: 'fr' };
  request.send();
  request.finish('new request');
  await vi.advanceTimersByTimeAsync(250);
  expect(chunks()).toHaveLength(1);
  expect(chunks()[0]!.track).toMatchObject({ lang: 'fr' });
});

test('observation does not wrap ordinary responses or sample the private player more than four times per second', async () => {
  installYouTubeCapture();
  for (let i = 0; i < 100; i++) await window.fetch('/ordinary');
  expect(fetchOriginal).toHaveBeenCalledTimes(100);
  await vi.advanceTimersByTimeAsync(999);
  expect(option).toHaveBeenCalledTimes(4);
  expect(chunks()).toHaveLength(0);
});

test('unsupported XHR types fail visibly; paused capture cannot be restarted by page messages', async () => {
  installYouTubeCapture();
  xhr().finish('unused', { responseType: 'json' });
  expect(emitted.some((value) => value.code === 'UNSUPPORTED_CAPTION_FORMAT')).toBe(true);
  window.dispatchEvent(new Event('pagehide'));
  const generation = emitted.findLast((value) => value.type === 'state')!.generation;
  window.dispatchEvent(
    new MessageEvent('message', {
      source: window,
      origin: location.origin,
      data: JSON.stringify({ channel: 'sayvia.capture.control.v1', type: 'heartbeat', generation }),
    }),
  );
  xhr().finish();
  await vi.advanceTimersByTimeAsync(0);
  expect((window as WindowCapture).__sayviaCapture!.active()).toBe(false);
  expect(chunks()).toHaveLength(0);
});

test('a long scheduling gap stops capture before observing a new request', () => {
  installYouTubeCapture();
  vi.setSystemTime(Date.now() + 3000);
  xhr().finish();
  expect((window as WindowCapture).__sayviaCapture!.active()).toBe(false);
  expect(chunks()).toHaveLength(0);
});

test('player identity rejects CC off, ads, platform translation and live content', () => {
  selected = {};
  expect(observePlayer(document, location.href).reason).toBe('track-unavailable');
  selected = { languageCode: 'en', translationLanguage: { languageCode: 'fr' } };
  expect(observePlayer(document, location.href).reason).toBe('platform-translated');
  player.classList.add('ad-showing');
  expect(observePlayer(document, location.href).reason).toBe('advertisement');
  player.classList.remove('ad-showing');
  Object.assign(player, { getVideoData: () => ({ video_id: videoId, isLive: true }) });
  expect(observePlayer(document, location.href).reason).toBe('live');
  expect(observePlayer(document, 'https://www.youtube.com/shorts/example').reason).toBe(
    'unsupported-page',
  );
});

test('synchronous site errors retain their identity and immediately free capture capacity', async () => {
  const failure = new Error('site synchronous failure');
  const send = vi.spyOn(FakeXHR.prototype, 'send');
  send
    .mockImplementationOnce(() => {
      throw failure;
    })
    .mockImplementationOnce(() => {
      throw failure;
    });
  fetchOriginal
    .mockImplementationOnce(() => {
      throw failure;
    })
    .mockImplementationOnce(() => {
      throw failure;
    });
  installYouTubeCapture();
  for (let i = 0; i < 2; i++) {
    expect(() => xhr()).toThrow(failure);
    expect(() => window.fetch(endpoint())).toThrow(failure);
  }
  const one = xhr();
  const two = xhr();
  one.finish('one');
  two.finish('two');
  await vi.advanceTimersByTimeAsync(0);
  expect(chunks()).toHaveLength(2);
  expect(emitted.some((event) => event.code === 'CAPTION_LIMIT')).toBe(false);
});

test('a duplicate XHR send does not remove the first request observer when the site throws', async () => {
  const failure = new DOMException('already sent', 'InvalidStateError');
  vi.spyOn(FakeXHR.prototype, 'send')
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw failure;
    });
  installYouTubeCapture();
  const request = xhr();
  expect(() => request.send()).toThrow(failure);
  request.finish('original request');
  await vi.advanceTimersByTimeAsync(0);
  expect(chunks()).toHaveLength(1);
  expect((chunks()[0]!.cues as Array<{ text: string }>)[0]!.text).toBe('original request');
});

test('rapid A to B to A navigation between samples restores readiness without reviving old scopes', async () => {
  installYouTubeCapture();
  const old = xhr();
  history.pushState({}, '', '/watch?v=second');
  xhr('en', 'second');
  history.pushState({}, '', '/watch?v=example');
  const current = xhr();
  old.finish('old A');
  current.finish('current A');
  await vi.advanceTimersByTimeAsync(550);
  expect(chunks()).toHaveLength(1);
  expect((chunks()[0]!.cues as Array<{ text: string }>)[0]!.text).toBe('current A');
  expect(emitted.findLast((event) => event.type === 'state')).toMatchObject({
    reason: 'ready',
    track: { lang: 'en' },
  });
});
