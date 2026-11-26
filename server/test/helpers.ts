import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Extracts raw packets from an Ogg file (skips the two Opus header packets). */
export function readOggPackets(file: string): Buffer[] {
  const data = readFileSync(file);
  const packets: Buffer[] = [];
  let off = 0;
  let pending: Buffer[] = [];
  while (off < data.length) {
    if (data.toString('ascii', off, off + 4) !== 'OggS') throw new Error(`bad page at ${off}`);
    const nseg = data[off + 26]!;
    const lacing = data.subarray(off + 27, off + 27 + nseg);
    let p = off + 27 + nseg;
    for (const len of lacing) {
      pending.push(data.subarray(p, p + len));
      p += len;
      if (len < 255) {
        packets.push(Buffer.concat(pending));
        pending = [];
      }
    }
    off = p;
  }
  return packets.slice(2);
}

/** Uses ffmpeg to make real 20 ms stereo Opus packets of a sine tone. */
export function makeOpusPackets(seconds: number): Buffer[] {
  const dir = mkdtempSync(join(tmpdir(), 'sb-'));
  const file = join(dir, 'tone.ogg');
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}:sample_rate=48000`,
    '-ac', '2', '-c:a', 'libopus', '-b:a', '96k', '-frame_duration', '20', '-page_duration', '20000', file,
  ]);
  return readOggPackets(file);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
