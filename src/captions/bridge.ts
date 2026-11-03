import { z } from 'zod';
import {
  CAPTION_LIMITS as limits,
  CaptionError,
  CueSchema,
  TrackSchema,
  bytes,
  trackKey,
  type CaptionCue,
  type CaptionTrack,
} from './contract';

const channel = 'sayvia.captions.v1';
const prefix = `{"channel":"${channel}",`;
const ChunkSchema = z
  .object({
    channel: z.literal(channel),
    type: z.literal('cues'),
    generation: z.uuid(),
    responseId: z.uuid(),
    track: TrackSchema,
    sequence: z
      .int()
      .min(0)
      .max(limits.chunks - 1),
    total: z.int().min(1).max(limits.chunks),
    cues: z.array(CueSchema).min(1).max(limits.chunkCues),
  })
  .strict();
type Chunk = z.infer<typeof ChunkSchema>;
export type BridgeScope = { generation: string; track: CaptionTrack };

export function encodeCaptionResponse(
  scope: BridgeScope,
  input: readonly CaptionCue[],
  responseId = crypto.randomUUID(),
): string[] {
  if (!input.length || input.length > limits.cues) throw new CaptionError('CAPTION_LIMIT');
  trackKey(scope.track);
  const envelope = {
    channel,
    type: 'cues',
    generation: scope.generation,
    responseId,
    track: scope.track,
    sequence: 255,
    total: 256,
    cues: [],
  };
  // Validate the envelope independently, before allocating all serialized rows.
  const fields = {
    channel,
    type: 'cues',
    generation: scope.generation,
    responseId,
    track: scope.track,
    sequence: 255,
    total: 256,
  };
  if (!ChunkSchema.omit({ cues: true }).safeParse(fields).success)
    throw new CaptionError('CAPTION_BRIDGE_INVALID');
  const overhead = bytes(JSON.stringify(envelope));
  const chunks: CaptionCue[][] = [];
  let current: CaptionCue[] = [];
  let size = overhead;
  let totalSize = 0;
  const flush = () => {
    if (current.length) {
      chunks.push(current);
      totalSize += size;
    }
    current = [];
    size = overhead;
  };
  for (const source of input) {
    const cue = CueSchema.safeParse(source);
    if (!cue.success) throw new CaptionError('INVALID_CAPTION_DATA');
    const cost = bytes(JSON.stringify(cue.data)) + 1;
    if (cost + overhead > limits.messageBytes) throw new CaptionError('CAPTION_LIMIT');
    if (current.length === limits.chunkCues || size + cost > limits.messageBytes) flush();
    current.push(cue.data);
    size += cost;
    if (chunks.length >= limits.chunks || totalSize + size > limits.responseBytes)
      throw new CaptionError('CAPTION_LIMIT');
  }
  flush();
  // Nothing is emitted until the entire response fits, including every envelope.
  return chunks.map((cues, sequence) =>
    JSON.stringify({ ...envelope, sequence, total: chunks.length, cues }),
  );
}

export class MessageRate {
  private tokens = limits.messagesPerSecond as number;
  private previous: number;
  constructor(private readonly now = () => performance.now()) {
    this.previous = now();
  }
  take(): boolean {
    const current = this.now();
    this.tokens = Math.min(
      limits.messagesPerSecond,
      this.tokens + (Math.max(0, current - this.previous) * limits.messagesPerSecond) / 1000,
    );
    this.previous = current;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}
type Assembly = { first: Chunk; next: number; deadline: number; bytes: number; cues: CaptionCue[] };
export type BridgeResult =
  | { status: 'ignored' | 'pending' }
  | { status: 'rejected'; error: 'CAPTION_BRIDGE_INVALID' }
  | { status: 'complete'; cues: CaptionCue[]; responseId: string };
export class CaptionAssembler {
  private readonly assemblies = new Map<string, Assembly>();
  private readonly completed = new Set<string>();
  private failed = false;
  private readonly rate: MessageRate;
  private readonly scope: BridgeScope;
  constructor(
    scope: BridgeScope,
    private readonly now = () => performance.now(),
  ) {
    this.scope = {
      generation: z.uuid().parse(scope.generation),
      track: TrackSchema.parse(scope.track),
    };
    trackKey(this.scope.track);
    this.rate = new MessageRate(now);
  }
  private reject(): BridgeResult {
    this.failed = true;
    this.assemblies.clear();
    return { status: 'rejected', error: 'CAPTION_BRIDGE_INVALID' };
  }
  cancel() {
    this.failed = true;
    this.assemblies.clear();
    this.completed.clear();
  }
  expire(): boolean {
    if ([...this.assemblies.values()].some((assembly) => assembly.deadline <= this.now()))
      this.reject();
    return this.failed;
  }
  accept(raw: unknown): BridgeResult {
    if (typeof raw !== 'string' || !raw.startsWith(prefix)) return { status: 'ignored' };
    if (this.failed || this.expire() || !this.rate.take() || raw.length > limits.messageBytes)
      return this.reject();
    const size = bytes(raw);
    if (size > limits.messageBytes) return this.reject();
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return this.reject();
    }
    const parsed = ChunkSchema.safeParse(decoded);
    if (!parsed.success) return this.reject();
    const chunk = parsed.data;
    // Old generations are discarded without poisoning a newly established session.
    if (chunk.generation !== this.scope.generation) return { status: 'ignored' };
    try {
      if (trackKey(chunk.track) !== trackKey(this.scope.track)) return this.reject();
    } catch {
      return this.reject();
    }
    if (chunk.sequence >= chunk.total || this.completed.has(chunk.responseId)) return this.reject();
    let assembly = this.assemblies.get(chunk.responseId);
    if (!assembly) {
      if (
        chunk.sequence !== 0 ||
        this.assemblies.size >= limits.assemblies ||
        this.completed.size >= 256
      )
        return this.reject();
      assembly = {
        first: chunk,
        next: 0,
        deadline: this.now() + limits.assemblyMs,
        bytes: 0,
        cues: [],
      };
      this.assemblies.set(chunk.responseId, assembly);
    }
    if (chunk.sequence !== assembly.next || chunk.total !== assembly.first.total)
      return this.reject();
    assembly.bytes += size;
    if (
      assembly.bytes > limits.responseBytes ||
      [...this.assemblies.values()].reduce((sum, item) => sum + item.bytes, 0) >
        limits.cacheBytes ||
      assembly.cues.length + chunk.cues.length > limits.cues
    )
      return this.reject();
    assembly.cues.push(...chunk.cues);
    assembly.next++;
    if (assembly.next !== chunk.total) return { status: 'pending' };
    this.assemblies.delete(chunk.responseId);
    this.completed.add(chunk.responseId);
    const ids = new Set(assembly.cues.map((cue) => JSON.stringify([cue.id, cue.revision])));
    if (ids.size !== assembly.cues.length) return this.reject();
    return { status: 'complete', cues: assembly.cues, responseId: chunk.responseId };
  }
}

// The caller owns one sender per document, never one per response.
export class CaptionBridgeSender {
  private waiting = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private readonly emit: (message: string) => void,
    private readonly rate = new MessageRate(),
  ) {}
  send(scope: BridgeScope, cues: readonly CaptionCue[], signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new CaptionError('CAPTION_BRIDGE_INVALID'));
    if (this.waiting >= limits.assemblies) return Promise.reject(new CaptionError('CAPTION_LIMIT'));
    const chunks = encodeCaptionResponse(scope, cues);
    this.waiting++;
    const pending = this.tail
      .then(async () => {
        for (const chunk of chunks) {
          while (!signal.aborted && !this.rate.take())
            await new Promise<void>((resolve) => setTimeout(resolve, 16));
          if (signal.aborted) throw new CaptionError('CAPTION_BRIDGE_INVALID');
          this.emit(chunk);
        }
      })
      .finally(() => {
        this.waiting--;
      });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}
