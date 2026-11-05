import { z } from 'zod';
import { TrackSchema, trackKey, type CaptionTrack } from './contract';

export const YOUTUBE_ORIGIN = 'https://www.youtube.com';
export const CaptureReason = z.enum([
  'ready',
  'unsupported-page',
  'player-unavailable',
  'track-unavailable',
  'platform-translated',
  'advertisement',
  'live',
  'paused',
]);
export const CaptureStateSchema = z
  .object({
    channel: z.literal('sayvia.capture.v1'),
    type: z.literal('state'),
    generation: z.uuid(),
    videoId: z.string().max(64).nullable(),
    track: TrackSchema.nullable(),
    reason: CaptureReason,
  })
  .strict();
export type CaptureState = z.infer<typeof CaptureStateSchema>;
export const CaptureErrorSchema = z
  .object({
    channel: z.literal('sayvia.capture.v1'),
    type: z.literal('error'),
    generation: z.uuid(),
    code: z.enum([
      'UNSUPPORTED_CAPTION_FORMAT',
      'INVALID_CAPTION_DATA',
      'CAPTION_LIMIT',
      'CAPTION_BRIDGE_INVALID',
      'CAPTION_REQUEST_FAILED',
      'NO_CAPTIONS',
    ]),
  })
  .strict();
export type CaptureErrorEvent = z.infer<typeof CaptureErrorSchema>;
export function watchVideoId(input: string): string | undefined {
  try {
    const url = new URL(input);
    const video = url.searchParams.get('v');
    if (
      url.origin === YOUTUBE_ORIGIN &&
      url.pathname === '/watch' &&
      url.searchParams.getAll('v').length === 1 &&
      video &&
      /^[A-Za-z0-9_-]{1,64}$/.test(video)
    )
      return video;
  } catch {
    /* Unsupported URL. */
  }
  return;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
type Player = HTMLElement & {
  getVideoData?(): unknown;
  getOption?(module: string, option: string): unknown;
};
export type PlayerObservation = Pick<CaptureState, 'videoId' | 'track' | 'reason'> & {
  player: HTMLElement | null;
};
export function observePlayer(doc: Document, href: string): PlayerObservation {
  const videoId = watchVideoId(href) ?? null;
  const player = doc.getElementById('movie_player') as Player | null;
  const result: PlayerObservation = { videoId, player, track: null, reason: 'player-unavailable' };
  if (!videoId) return { ...result, reason: 'unsupported-page' };
  if (
    !player ||
    typeof player.getVideoData !== 'function' ||
    typeof player.getOption !== 'function'
  )
    return result;
  try {
    const data = player.getVideoData();
    if (!object(data) || data.video_id !== videoId) return result;
    if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'))
      return { ...result, reason: 'advertisement' };
    if (data.isLive === true || player.querySelector('video')?.duration === Infinity)
      return { ...result, reason: 'live' };
    const selected = player.getOption('captions', 'track');
    if (!object(selected)) return { ...result, reason: 'track-unavailable' };
    let tlang: unknown = selected.tlang ?? null;
    if (selected.translationLanguage !== undefined && selected.translationLanguage !== null) {
      if (
        !object(selected.translationLanguage) ||
        typeof selected.translationLanguage.languageCode !== 'string'
      )
        return { ...result, reason: 'track-unavailable' };
      tlang = selected.translationLanguage.languageCode;
    }
    const parsed = TrackSchema.safeParse({
      videoId,
      lang: selected.languageCode,
      kind: selected.kind ?? null,
      name: selected.name ?? null,
      tlang,
    });
    if (!parsed.success) return { ...result, reason: 'track-unavailable' };
    trackKey(parsed.data);
    return {
      ...result,
      track: parsed.data,
      reason: parsed.data.tlang ? 'platform-translated' : 'ready',
    };
  } catch {
    return result;
  }
}
export const sameTrack = (left: CaptionTrack | null, right: CaptionTrack | null) =>
  left !== null && right !== null && trackKey(left) === trackKey(right);
