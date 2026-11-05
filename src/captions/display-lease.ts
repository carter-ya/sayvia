import { z } from 'zod';
import { YOUTUBE_ORIGIN } from './player';
import { MessageRate } from './bridge';

export const HIDDEN_ATTRIBUTE = 'data-sayvia-caption-hidden';
export const OVERLAY_ATTRIBUTE = 'data-sayvia-caption-overlay';
export const READY_ATTRIBUTE = 'data-sayvia-caption-ready';
export const DisplayRequestSchema = z
  .object({
    channel: z.literal('sayvia.caption.display.v1'),
    type: z.enum(['renew', 'stop']),
    owner: z.uuid(),
    generation: z.uuid(),
    requestId: z.uuid(),
    trackKey: z.string().min(1).max(256),
  })
  .strict();
export const DisplayReplySchema = z
  .object({
    channel: z.literal('sayvia.caption.display.status.v1'),
    owner: z.uuid(),
    generation: z.uuid(),
    requestId: z.uuid(),
    trackKey: z.string().min(1).max(256),
    active: z.boolean(),
  })
  .strict();
export function restoreNativeCaptions(player: Element, owner: string) {
  if (player.getAttribute(HIDDEN_ATTRIBUTE) === owner) player.removeAttribute(HIDDEN_ATTRIBUTE);
}
export function compatibleDisplay(
  document: Document,
  player: Element,
  overlay: Element,
  video: HTMLVideoElement,
) {
  const fullscreen = document.fullscreenElement;
  return (
    player.contains(video) &&
    player.contains(overlay) &&
    !document.pictureInPictureElement &&
    (!fullscreen || (fullscreen.contains(video) && fullscreen.contains(overlay)))
  );
}
// Refuse to replace captions when any of our text lies outside the visible
// video/player rectangle, including custom offsets in a small clipped player.
export function visibleCaptionBounds(
  win: Window,
  player: Element,
  video: Element,
  overlay: Element,
) {
  const p = player.getBoundingClientRect();
  const v = video.getBoundingClientRect();
  const o = overlay.getBoundingClientRect();
  const left = Math.max(0, p.left, v.left),
    top = Math.max(0, p.top, v.top);
  const right = Math.min(win.innerWidth, p.right, v.right),
    bottom = Math.min(win.innerHeight, p.bottom, v.bottom);
  return (
    o.width > 0 &&
    o.height > 0 &&
    right > left &&
    bottom > top &&
    o.left >= left - 1 &&
    o.top >= top - 1 &&
    o.right <= right + 1 &&
    o.bottom <= bottom + 1
  );
}
type DisplayScope = {
  generation: string;
  trackKey: string | null;
  player: HTMLElement | null;
  ready: boolean;
};
// This MAIN-world guard only restores appearance. Page messages never grant
// translation/capture access. Its independent lease survives isolated-world loss.
export function installDisplayLease(win: Window & typeof globalThis, current: () => DisplayScope) {
  let active:
    | {
        owner: string;
        generation: string;
        requestId: string;
        trackKey: string;
        player: HTMLElement;
        overlay: HTMLElement;
        video: HTMLVideoElement;
        until: number;
        style: HTMLStyleElement;
      }
    | undefined;
  let ownership: { owner: string; generation: string; trackKey: string } | undefined;
  let lastTick = Date.now();
  let disposed = false;
  const retired = new Set<string>();
  const rate = new MessageRate();
  const reply = (
    owner: string,
    generation: string,
    trackKey: string,
    requestId: string,
    enabled: boolean,
  ) => {
    win.postMessage(
      JSON.stringify({
        channel: 'sayvia.caption.display.status.v1',
        owner,
        generation,
        trackKey,
        requestId,
        active: enabled,
      }),
      YOUTUBE_ORIGIN,
    );
  };
  function restore(retire: boolean) {
    if (!active) return;
    const old = active;
    active = undefined;
    restoreNativeCaptions(old.player, old.owner);
    old.style.remove();
    if (retire && retired.size < 256) retired.add(old.owner);
    reply(old.owner, old.generation, old.trackKey, old.requestId, false);
  }
  const reset = () => {
    if (ownership && retired.size < 256) retired.add(ownership.owner);
    ownership = undefined;
    restore(true);
  };
  function visible(overlay: HTMLElement) {
    const rect = overlay.getBoundingClientRect();
    const css = win.getComputedStyle(overlay);
    return (
      overlay.isConnected &&
      !overlay.hidden &&
      overlay.getAttribute(READY_ATTRIBUTE) === 'true' &&
      rect.width > 0 &&
      rect.height > 0 &&
      css.display !== 'none' &&
      css.visibility !== 'hidden' &&
      css.opacity !== '0'
    );
  }
  function valid() {
    if (!active) return false;
    const scope = current();
    return (
      scope.ready &&
      scope.generation === active.generation &&
      scope.trackKey === active.trackKey &&
      scope.player === active.player &&
      active.player.isConnected &&
      active.style.isConnected &&
      active.style.sheet?.cssRules.length === 1 &&
      active.player.querySelector('video') === active.video &&
      active.overlay.getAttribute(OVERLAY_ATTRIBUTE) === active.owner
    );
  }
  function check() {
    const now = Date.now();
    // A resumed execution must restore first; queued renewals cannot extend a
    // lease across a frozen or heavily throttled interval.
    if (active && (now - lastTick >= 2000 || now >= active.until || !valid())) reset();
    else if (
      active &&
      (!visible(active.overlay) ||
        !visibleCaptionBounds(win, active.player, active.video, active.overlay) ||
        !compatibleDisplay(win.document, active.player, active.overlay, active.video))
    )
      restore(false);
    lastTick = now;
  }
  function receive(event: MessageEvent) {
    if (
      disposed ||
      event.source !== win ||
      event.origin !== YOUTUBE_ORIGIN ||
      typeof event.data !== 'string' ||
      event.data.length > 1024 ||
      !event.data.startsWith('{"channel":"sayvia.caption.display.v1",')
    )
      return;
    if (!rate.take()) {
      reset();
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      return;
    }
    const parsed = DisplayRequestSchema.safeParse(raw);
    if (!parsed.success) return;
    check();
    const request = parsed.data;
    if (request.type === 'stop') {
      if (retired.size < 256) retired.add(request.owner);
      if (ownership?.owner === request.owner && ownership.generation === request.generation)
        reset();
      reply(request.owner, request.generation, request.trackKey, request.requestId, false);
      return;
    }
    const scope = current();
    if (
      !scope.ready ||
      scope.generation !== request.generation ||
      scope.trackKey !== request.trackKey ||
      !scope.player ||
      retired.has(request.owner) ||
      retired.size >= 256
    ) {
      reply(request.owner, request.generation, request.trackKey, request.requestId, false);
      return;
    }
    const player = scope.player;
    const overlay = player.querySelector<HTMLElement>(`[${OVERLAY_ATTRIBUTE}="${request.owner}"]`);
    const video = player.querySelector('video');
    if (
      !overlay ||
      !video ||
      !visible(overlay) ||
      !visibleCaptionBounds(win, player, video, overlay) ||
      !compatibleDisplay(win.document, player, overlay, video)
    ) {
      if (ownership?.owner === request.owner) restore(false);
      reply(request.owner, request.generation, request.trackKey, request.requestId, false);
      return;
    }
    if (ownership && ownership.owner !== request.owner) reset();
    ownership = {
      owner: request.owner,
      generation: request.generation,
      trackKey: request.trackKey,
    };
    if (!active) {
      const style = win.document.createElement('style');
      style.textContent = `[${HIDDEN_ATTRIBUTE}="${request.owner}"] .ytp-caption-window-container{visibility:hidden!important}`;
      (win.document.head ?? win.document.documentElement).append(style);
      active = {
        owner: request.owner,
        generation: request.generation,
        requestId: request.requestId,
        trackKey: request.trackKey,
        player,
        overlay,
        video,
        until: Date.now() + 2000,
        style,
      };
    }
    active.until = Date.now() + 2000;
    active.requestId = request.requestId;
    player.setAttribute(HIDDEN_ATTRIBUTE, request.owner);
    const native = player.querySelector('.ytp-caption-window-container');
    if (!active.style.sheet || (native && win.getComputedStyle(native).visibility !== 'hidden')) {
      reset();
      return;
    }
    reply(request.owner, request.generation, request.trackKey, request.requestId, true);
  }
  const timer = setInterval(check, 250);
  win.addEventListener('message', receive);
  win.addEventListener('pagehide', reset);
  win.document.addEventListener('freeze', reset);
  return {
    reset,
    dispose() {
      if (disposed) return;
      reset();
      disposed = true;
      clearInterval(timer);
      win.removeEventListener('message', receive);
      win.removeEventListener('pagehide', reset);
      win.document.removeEventListener('freeze', reset);
    },
  };
}
