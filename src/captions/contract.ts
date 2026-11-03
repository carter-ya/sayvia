import { z } from 'zod';
import { LocaleSchema } from '../core/learning-contract';

export const CAPTION_LIMITS = {
  responseBytes: 4 * 1024 * 1024,
  cacheBytes: 8 * 1024 * 1024,
  cues: 20_000,
  events: 40_001,
  segments: 200_000,
  cueCodepoints: 4000,
  messageBytes: 64 * 1024,
  chunkCues: 100,
  chunks: 256,
  assemblies: 2,
  assemblyMs: 10_000,
  messagesPerSecond: 64,
} as const;
export type CaptionErrorCode =
  | 'UNSUPPORTED_CAPTION_FORMAT'
  | 'INVALID_CAPTION_DATA'
  | 'CAPTION_LIMIT'
  | 'CAPTION_BRIDGE_INVALID';
export class CaptionError extends Error {
  constructor(readonly code: CaptionErrorCode) {
    super(code);
  }
}
export const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const optionalPart = z
  .string()
  .max(120)
  .nullable()
  .transform((value) => (value === '' ? null : value));
export const TrackSchema = z
  .object({
    videoId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    lang: LocaleSchema,
    kind: optionalPart,
    name: optionalPart,
    tlang: z.union([z.literal(''), LocaleSchema, z.null()]).transform((value) => value || null),
  })
  .strict();
export type CaptionTrack = z.infer<typeof TrackSchema>;
// JSON tuple encoding avoids separator collisions and preserves every track discriminator.
export function trackKey(track: CaptionTrack): string {
  const value = TrackSchema.parse(track);
  const key = JSON.stringify([value.videoId, value.lang, value.kind, value.name, value.tlang]);
  if (key.length > 256) throw new CaptionError('CAPTION_LIMIT');
  return key;
}
export function timedtextTrack(input: string): CaptionTrack | undefined {
  try {
    const url = new URL(input);
    if (
      url.origin !== 'https://www.youtube.com' ||
      url.pathname !== '/api/timedtext' ||
      url.username ||
      url.password
    )
      return;
    const keys = ['v', 'lang', 'kind', 'name', 'tlang'];
    if (keys.some((key) => url.searchParams.getAll(key).length > 1)) return;
    const parsed = TrackSchema.safeParse({
      videoId: url.searchParams.get('v'),
      lang: url.searchParams.get('lang'),
      kind: url.searchParams.get('kind'),
      name: url.searchParams.get('name'),
      tlang: url.searchParams.get('tlang'),
    });
    if (!parsed.success) return;
    trackKey(parsed.data);
    return parsed.data;
  } catch {
    return;
  }
}
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CueSchema = z
  .object({
    id: z.string().min(1).max(160),
    revision: z.int().nonnegative(),
    start: time,
    end: time,
    windowId: z.string().min(1).max(32),
    text: z
      .string()
      .min(1)
      .max(8000)
      .refine(
        (value) => value.trim().length > 0 && [...value].length <= CAPTION_LIMITS.cueCodepoints,
      ),
    events: z
      .array(
        z
          .int()
          .nonnegative()
          .max(CAPTION_LIMITS.events - 1),
      )
      .min(1)
      .max(CAPTION_LIMITS.events),
    revised: z.boolean(),
  })
  .strict()
  .refine((cue) => cue.end > cue.start);
export type CaptionCue = z.infer<typeof CueSchema>;
export type CaptionGroup = {
  unitId: string;
  revision: number;
  start: number;
  end: number;
  text: string;
  windowId: string;
  sources: Array<{ id: string; revision: number }>;
};
