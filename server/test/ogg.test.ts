import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OggOpusWriter } from '../src/audio/ogg.js';
import { makeOpusPackets, readOggPackets } from './helpers.js';

test('OggOpusWriter output is a valid Opus file ffprobe understands', async () => {
  const packets = makeOpusPackets(1);
  const file = join(mkdtempSync(join(tmpdir(), 'sb-')), 'out.ogg');
  const w = new OggOpusWriter(file);
  for (const p of packets) w.write(p);
  await w.close();

  const info = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString(),
  );
  const s = info.streams[0];
  assert.equal(s.codec_name, 'opus');
  assert.equal(s.channels, 2);
  assert.equal(Number(s.sample_rate), 48000);
  assert.ok(Math.abs(Number(info.format.duration) - 1) < 0.1, `duration ${info.format.duration}`);
  assert.equal(readOggPackets(file).length, packets.length);
  // A full decode must succeed without errors.
  execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
});
