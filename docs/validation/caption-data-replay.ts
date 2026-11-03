// Local recorded responses only. No browser, model request or network access.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseJson3 } from '../../src/captions/json3';
import { groupCaptions } from '../../src/captions/group';
import { CaptionAssembler, encodeCaptionResponse } from '../../src/captions/bridge';
import { bytes, TrackSchema } from '../../src/captions/contract';

// Earlier captures retained diagnostic rows only; these two retain the raw JSON3.
const names = ['reloaded', 'second-asr'];
const samples = [];
for (const name of names) {
  const data = JSON.parse(await readFile(`/tmp/sayvia-youtube-${name}-cues.json`, 'utf8'));
  const meta = data.selected;
  const track = TrackSchema.parse({ videoId: meta.v, lang: meta.lang, kind: meta.kind, name: meta.name, tlang: meta.tlang });
  const cues = parseJson3(data.rawSource, track.kind === 'asr');
  const groups = await groupCaptions(track, cues);
  const scope = { track, generation: crypto.randomUUID() };
  const chunks = encodeCaptionResponse(scope, cues);
  let clock = 0;
  const assembler = new CaptionAssembler(scope, () => clock);
  let roundtrip = false;
  for (const chunk of chunks) {
    clock += 20;
    const result = assembler.accept(chunk);
    if (result.status === 'complete') roundtrip = isDeepStrictEqual(result.cues, cues);
    else if (result.status !== 'pending') throw new Error(`Bridge failed: ${name}`);
  }
  if (!roundtrip) throw new Error(`Roundtrip mismatch: ${name}`);
  samples.push({ sample: name, sourceCapturedAt: data.capturedAt, rawSha256: createHash('sha256').update(data.rawSource).digest('hex'), track, rawBytes: bytes(data.rawSource), cues: cues.length, groups: groups.length, revisedIntervals: cues.filter((cue) => cue.revised).length, firstStart: cues[0]?.start, lastEnd: Math.max(...cues.map((cue) => cue.end)), chunkCount: chunks.length, largestChunkBytes: Math.max(...chunks.map(bytes)), roundtrip });
}
const report = { checkedAt: new Date().toISOString(), productionParser: true, modelRequests: 0, newSiteCapture: false, samples };
await writeFile('docs/validation/caption-data-replay.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
