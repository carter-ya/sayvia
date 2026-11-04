import { installDisplayLease } from './display-lease';
import { CaptionBodyReader } from './body-reader';
import { CaptionBridgeSender, MessageRate } from './bridge';
import {
  CAPTION_LIMITS,
  CaptionError,
  bytes,
  timedtextTrack,
  trackKey,
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

const VERSION = 'capture-v4';
const REQUEST_TIMEOUT_MS = 10_000;
type Controller = { version: string; active(): boolean; stop(): void };
type CaptureWindow = Window & typeof globalThis & { __sayviaCapture?: Controller };
type RequestScope = {
  player: HTMLElement | null;
  generation: string;
  track: CaptionTrack;
  deadlineAt: number;
  initialTrackPending: boolean;
  sampled?: () => void;
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
  let hasObservedTrack = observation.track !== null;
  let state: CaptureState = {
    channel: 'sayvia.capture.v1',
    type: 'state',
    generation: crypto.randomUUID(),
    videoId: observation.videoId,
    track: observation.track,
    reason: observation.reason,
  };
  const display = installDisplayLease(win, () => ({
    generation: state.generation,
    trackKey: state.track ? trackKey(state.track) : null,
    player: playerNode,
    ready: enabled && state.reason === 'ready',
  }));
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
    display.reset();
    for (const pending of [...pendingScopes]) pending.cancel();
    controller.abort();
    controller = new AbortController();
    pool.cancel();
    for (const [xhr, listener] of listeners) xhr.removeEventListener('loadend', listener);
    listeners.clear();
    cached = undefined;
    pendingError = undefined;
  }
  const awaitingTrack = (reason: CaptureState['reason']) =>
    reason === 'track-unavailable' || reason === 'player-unavailable';
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
      hasObservedTrack = false;
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
      hasObservedTrack = false;
      state = {
        ...state,
        generation: crypto.randomUUID(),
        videoId: video,
        track: null,
        reason: 'player-unavailable',
      };
    }
    for (const pending of pendingScopes) withinDeadline(pending, now);
    if (now - lastObserved < 250) {
      publish();
      return true;
    }
    lastObserved = now;
    const next = observePlayer(win.document, win.location.href);
    const identity = (value: typeof next) =>
      JSON.stringify([value.videoId, value.track, value.reason]);
    if (next.player !== observation.player || identity(next) !== identity(observation)) {
      display.reset();
      if (['advertisement', 'live', 'unsupported-page'].includes(next.reason)) {
        clear();
        state = { ...state, generation: crypto.randomUUID() };
      } else {
        controller.abort();
        controller = new AbortController();
        cached = undefined;
        // Retain an initial candidate while the player is still identifying its
        // first track. Once a track is known, discard every conflicting request.
        for (const pending of [...pendingScopes])
          if (
            !sameTrack(pending.track, next.track) &&
            !(pending.initialTrackPending && awaitingTrack(next.reason))
          )
            pending.cancel();
      }
    }
    if (next.track) {
      hasObservedTrack = true;
      for (const pending of pendingScopes) {
        // A → B → A can rotate the generation between samples even if the
        // private snapshot equals the previous one. Its first track still binds.
        if (pending.initialTrackPending && !sameTrack(pending.track, next.track)) pending.cancel();
        else pending.initialTrackPending = false;
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
    for (const pending of pendingScopes) pending.sampled?.();
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
      deadlineAt: Date.now() + REQUEST_TIMEOUT_MS,
      initialTrackPending: !!playerNode && !hasObservedTrack && awaitingTrack(state.reason),
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
    const deadline = setTimeout(() => expire(pending), REQUEST_TIMEOUT_MS);
    pendingScopes.add(pending);
    return pending;
  }
  function expire(request: RequestScope) {
    error(request, 'CAPTION_REQUEST_FAILED');
    request.cancel();
  }
  function withinDeadline(request: RequestScope, now = Date.now()) {
    if (request.signal.aborted) return false;
    if (now < request.deadlineAt) return true;
    expire(request);
    return false;
  }
  function validScope(request: RequestScope, url: string) {
    return (
      refresh() &&
      withinDeadline(request) &&
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
      // An existing player can load captions before publishing its first selected
      // track. Keep the response in its original slot and deadline until the player
      // identifies that track. Later track switches still get only one sample.
      await new Promise<void>((resolve) => {
        const finish = () => {
          delete request.sampled;
          request.signal.removeEventListener('abort', finish);
          resolve();
        };
        request.signal.addEventListener('abort', finish, { once: true });
        request.sampled = () => {
          if (!request.initialTrackPending || !awaitingTrack(state.reason)) finish();
        };
      });
    }
    if (
      !validScope(request, url) ||
      state.reason !== 'ready' ||
      !sameTrack(state.track, request.track)
    )
      return;
    try {
      const cues = parseJson3(body, request.track.kind === 'asr');
      if (!withinDeadline(request)) return;
      if (!cues.length) {
        error(request, 'NO_CAPTIONS');
        return;
      }
      const source = { generation: request.generation, track: request.track, cues };
      await sender.send(source, cues, request.signal, () => withinDeadline(request));
      if (validScope(request, url) && sameTrack(state.track, request.track)) cached = source;
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
    display.dispose();
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
