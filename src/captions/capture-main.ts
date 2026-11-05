import { CaptionBodyReader } from './body-reader';
import { CaptionBridgeSender, MessageRate } from './bridge';
import {
  CAPTION_LIMITS,
  CaptionError,
  bytes,
  timedtextTrack,
  type CaptionCue,
  type CaptionTrack,
} from './contract';
import { parseJson3 } from './json3';
import {
  observePlayer,
  sameTrack,
  type CaptureState,
  type CaptureErrorEvent,
  YOUTUBE_ORIGIN,
  watchVideoId,
} from './player';

const VERSION = 'capture-v1';
type Controller = { version: string; active(): boolean; stop(): void };
type CaptureWindow = Window & typeof globalThis & { __sayviaCapture?: Controller };
type RequestScope = {
  player: HTMLElement | null;
  generation: string;
  track: CaptionTrack;
  signal: AbortSignal;
  cancel(): void;
  finish(): void;
};
export function installYouTubeCapture(win: CaptureWindow = window) {
  if (win.top !== win || win.location.origin !== YOUTUBE_ORIGIN) return;
  const previous = win.__sayviaCapture;
  if (previous?.version === VERSION && previous.active()) return;
  previous?.stop();
  const originalFetch = win.fetch;
  const prototype = win.XMLHttpRequest.prototype;
  const originalOpen = prototype.open;
  const originalSend = prototype.send;
  const requests = new WeakMap<XMLHttpRequest, string>();
  const xhrScopes = new WeakMap<XMLHttpRequest, RequestScope>();
  const listeners = new Map<XMLHttpRequest, () => void>();
  const pendingScopes = new Set<RequestScope>();
  const pool = new CaptionBodyReader();
  const rate = new MessageRate();
  const sender = new CaptionBridgeSender((value) => win.postMessage(value, YOUTUBE_ORIGIN), rate);
  let enabled = true;
  let controller = new AbortController();
  let observation = observePlayer(win.document, win.location.href);
  let playerNode = observation.player;
  let state: CaptureState = {
    channel: 'sayvia.capture.v1',
    type: 'state',
    generation: crypto.randomUUID(),
    videoId: observation.videoId,
    track: observation.track,
    reason: observation.reason,
  };
  let lastSent = '';
  let lastTick = Date.now();
  let lastObserved = lastTick;
  let lease = lastTick + 30_000; // Bounded startup capture before the isolated controller mounts.
  let lastReplay = -Infinity;
  let pendingError: CaptureErrorEvent | undefined;
  let cached: { generation: string; track: CaptionTrack; cues: CaptionCue[] } | undefined;
  function emit(value: CaptureState | CaptureErrorEvent) {
    if (!rate.take()) return false;
    win.postMessage(JSON.stringify(value), YOUTUBE_ORIGIN);
    return true;
  }
  function publish() {
    if (pendingError && emit(pendingError)) pendingError = undefined;
    const encoded = JSON.stringify(state);
    if (encoded !== lastSent && emit(state)) lastSent = encoded;
  }
  function clear() {
    for (const pending of [...pendingScopes]) pending.cancel();
    controller.abort();
    controller = new AbortController();
    pool.cancel();
    for (const [xhr, listener] of listeners) xhr.removeEventListener('loadend', listener);
    listeners.clear();
    cached = undefined;
    pendingError = undefined;
  }
  function refresh() {
    const now = Date.now();
    if (!enabled) return false;
    if (now - lastTick > 2500 || now >= lease) {
      stop();
      return false;
    }
    lastTick = now;
    const node = win.document.getElementById('movie_player');
    if (node !== playerNode) {
      clear();
      playerNode = node;
      state = {
        ...state,
        generation: crypto.randomUUID(),
        track: null,
        reason: 'player-unavailable',
      };
    }
    const video = watchVideoId(win.location.href) ?? null;
    if (video !== state.videoId) {
      clear();
      state = {
        ...state,
        generation: crypto.randomUUID(),
        videoId: video,
        track: null,
        reason: 'player-unavailable',
      };
    }
    if (now - lastObserved < 250) {
      publish();
      return true;
    }
    lastObserved = now;
    const next = observePlayer(win.document, win.location.href);
    const identity = (value: typeof next) =>
      JSON.stringify([value.videoId, value.track, value.reason]);
    if (next.player !== observation.player || identity(next) !== identity(observation)) {
      if (['advertisement', 'live', 'unsupported-page'].includes(next.reason)) {
        clear();
        state = { ...state, generation: crypto.randomUUID() };
      } else {
        controller.abort();
        controller = new AbortController();
        cached = undefined;
        // A track request may precede the next 4 Hz player snapshot. Keep only
        // those already-observed requests that match the newly selected track.
        for (const pending of [...pendingScopes])
          if (!sameTrack(pending.track, next.track)) pending.cancel();
      }
    }
    // An immediate A → B → A invalidation can happen between private samples.
    // Always restore the sampled state, even when it equals the older snapshot.
    observation = next;
    state = {
      ...state,
      videoId: next.videoId,
      track: next.track,
      reason: next.reason,
    };
    publish();
    return true;
  }
  function scope(url: string): RequestScope | undefined {
    const track = timedtextTrack(url);
    if (
      !track ||
      !refresh() ||
      track.videoId !== state.videoId ||
      track.tlang ||
      ['advertisement', 'live', 'unsupported-page'].includes(state.reason)
    )
      return;
    if (pendingScopes.size >= 2) {
      report('CAPTION_LIMIT');
      return;
    }
    const abort = new AbortController();
    const pending: RequestScope = {
      generation: state.generation,
      player: playerNode,
      track,
      signal: abort.signal,
      cancel() {
        abort.abort();
        pending.finish();
      },
      finish() {
        clearTimeout(deadline);
        pendingScopes.delete(pending);
      },
    };
    const deadline = setTimeout(() => {
      error(pending, 'CAPTION_REQUEST_FAILED');
      pending.cancel();
    }, 10_000);
    pendingScopes.add(pending);
    return pending;
  }
  function validScope(request: RequestScope, url: string) {
    return (
      refresh() &&
      !request.signal.aborted &&
      state.generation === request.generation &&
      state.videoId === request.track.videoId &&
      request.player === playerNode &&
      sameTrack(timedtextTrack(url) ?? null, request.track)
    );
  }
  function error(request: RequestScope, code: CaptureErrorEvent['code']) {
    if (!enabled || request.signal.aborted || request.generation !== state.generation) return;
    report(code);
  }
  function report(code: CaptureErrorEvent['code']) {
    cached = undefined;
    pendingError = {
      channel: 'sayvia.capture.v1',
      type: 'error',
      generation: state.generation,
      code,
    };
    publish();
  }
  async function accept(request: RequestScope, body: string, url: string) {
    if (!validScope(request, url)) return;
    if (state.reason !== 'ready' || !sameTrack(state.track, request.track)) {
      // A fast response can arrive before the next player sample. Retain only
      // this bounded response until one sample is due, without another request.
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.max(1, 250 - (Date.now() - lastObserved))),
      );
    }
    if (
      !validScope(request, url) ||
      state.reason !== 'ready' ||
      !sameTrack(state.track, request.track)
    )
      return;
    try {
      const cues = parseJson3(body, request.track.kind === 'asr');
      if (!cues.length) {
        error(request, 'NO_CAPTIONS');
        return;
      }
      cached = { generation: request.generation, track: request.track, cues };
      await sender.send(cached, cues, request.signal);
    } catch (cause) {
      error(request, cause instanceof CaptionError ? cause.code : 'INVALID_CAPTION_DATA');
    }
  }
  const wrappedFetch: typeof fetch = function (this: Window, ...args) {
    let request: RequestScope | undefined;
    try {
      request = scope(
        typeof args[0] === 'string'
          ? new URL(args[0], win.location.href).href
          : args[0] instanceof URL
            ? args[0].href
            : args[0].url,
      );
    } catch {
      /* Never change the site's error behavior. */
    }
    let pending: Promise<Response>;
    try {
      pending = originalFetch.apply(this, args);
    } catch (cause) {
      request?.cancel();
      throw cause;
    }
    if (request) {
      const frozen = request;
      void pending
        .then((response) => {
          if (!validScope(frozen, response.url)) return;
          if (!response.ok) {
            error(frozen, 'CAPTION_REQUEST_FAILED');
            return;
          }
          return pool
            .read(response, frozen.signal)
            .then((body) => accept(frozen, body, response.url));
        })
        .catch((cause) =>
          error(frozen, cause instanceof CaptionError ? cause.code : 'CAPTION_REQUEST_FAILED'),
        )
        .finally(() => frozen.finish());
    }
    return pending;
  };
  const wrappedOpen = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
    xhrScopes.get(this)?.cancel();
    const old = listeners.get(this);
    if (old) {
      this.removeEventListener('loadend', old);
      listeners.delete(this);
    }
    requests.delete(this);
    const result = originalOpen.apply(this, args);
    try {
      requests.set(this, new URL(String(args[1]), win.location.href).href);
    } catch {
      /* Unsupported request. */
    }
    return result;
  } as XMLHttpRequest['open'];
  const wrappedSend: XMLHttpRequest['send'] = function (this: XMLHttpRequest, ...args) {
    // A second send on the same live XHR normally throws. Keep the observer for
    // its first request intact and let the browser produce the original error.
    if (xhrScopes.has(this)) return originalSend.apply(this, args);
    let request: RequestScope | undefined;
    try {
      request = scope(requests.get(this) ?? '');
    } catch {
      /* Observation only. */
    }
    if (request && listeners.size < 2) {
      const frozen = request;
      const cleanup = () => {
        this.removeEventListener('loadend', listener);
        listeners.delete(this);
        xhrScopes.delete(this);
      };
      const listener = () => {
        listeners.delete(this);
        xhrScopes.delete(this);
        frozen.signal.removeEventListener('abort', cleanup);
        if (!validScope(frozen, this.responseURL)) {
          frozen.finish();
          return;
        }
        if (this.status < 200 || this.status >= 300) {
          error(frozen, 'CAPTION_REQUEST_FAILED');
          frozen.finish();
          return;
        }
        try {
          // JSON objects cannot be size-checked before serialization. The observed
          // native JSON3 transport uses text; other response types fail visibly.
          if (this.responseType !== '' && this.responseType !== 'text') {
            error(frozen, 'UNSUPPORTED_CAPTION_FORMAT');
            frozen.finish();
            return;
          }
          const body = this.responseText;
          if (
            body.length > CAPTION_LIMITS.responseBytes ||
            bytes(body) > CAPTION_LIMITS.responseBytes
          ) {
            error(frozen, 'CAPTION_LIMIT');
            frozen.finish();
            return;
          }
          void accept(frozen, body, this.responseURL).finally(() => frozen.finish());
        } catch {
          error(frozen, 'UNSUPPORTED_CAPTION_FORMAT');
          frozen.finish();
        }
      };
      listeners.set(this, listener);
      xhrScopes.set(this, frozen);
      this.addEventListener('loadend', listener, { once: true });
      frozen.signal.addEventListener('abort', cleanup, { once: true });
    } else if (request) {
      error(request, 'CAPTION_LIMIT');
      request.cancel();
    }
    try {
      return originalSend.apply(this, args);
    } catch (cause) {
      request?.cancel();
      throw cause;
    }
  };
  function control(event: MessageEvent) {
    if (
      event.source !== win ||
      event.origin !== YOUTUBE_ORIGIN ||
      typeof event.data !== 'string' ||
      event.data.length > 1024
    )
      return;
    let value: { channel?: unknown; type?: unknown; generation?: unknown };
    try {
      value = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!value || value.channel !== 'sayvia.capture.control.v1') return;
    if (value.type === 'stop') {
      stop();
      return;
    }
    // No message can restart a paused capture; only a new extension injection can.
    if (!refresh()) return;
    if (value.type === 'heartbeat' && value.generation === state.generation)
      lease = Date.now() + 5000;
    if (value.type === 'replay') {
      emit(state);
      if (cached && value.generation === state.generation && Date.now() - lastReplay >= 2000) {
        lastReplay = Date.now();
        void sender.send(cached, cached.cues, controller.signal).catch(() => undefined);
      }
    }
  }
  function stop() {
    if (!enabled) return;
    enabled = false;
    clear();
    clearInterval(timer);
    win.removeEventListener('message', control);
    win.removeEventListener('pagehide', stop);
    win.document.removeEventListener('freeze', stop);
    if (win.fetch === wrappedFetch) win.fetch = originalFetch;
    if (prototype.open === wrappedOpen) prototype.open = originalOpen;
    if (prototype.send === wrappedSend) prototype.send = originalSend;
    state = { ...state, reason: 'paused' };
    emit(state);
  }
  win.fetch = wrappedFetch;
  prototype.open = wrappedOpen;
  prototype.send = wrappedSend;
  win.addEventListener('message', control);
  win.addEventListener('pagehide', stop);
  win.document.addEventListener('freeze', stop);
  const timer = setInterval(refresh, 250);
  win.__sayviaCapture = { version: VERSION, active: () => enabled, stop };
  publish();
}
