import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
} from '@discordjs/voice';
import { OpusJitterStream } from '../src/audio/jitter.js';
import { makeOpusPackets, sleep } from './helpers.js';

// Drives the real @discordjs/voice AudioPlayer (no Discord connection needed with
// NoSubscriberBehavior.Play) to prove it consumes our jitter stream correctly.
test('AudioPlayer plays OpusJitterStream and goes idle after destroy', async () => {
  const packets = makeOpusPackets(2);
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 50 } });
  const pipe = new OpusJitterStream({ targetFrames: 10, maxFrames: 50 });
  const resource = createAudioResource(pipe, { inputType: StreamType.Opus });
  player.play(resource);
  assert.equal(player.state.status, AudioPlayerStatus.Buffering);

  // Feed in real time, like the browser does.
  let i = 0;
  const feeder = setInterval(() => {
    const p = packets[i++];
    if (p) pipe.enqueue(p);
  }, 20);

  await entersState(player, AudioPlayerStatus.Playing, 2000);
  await sleep(600);
  assert.ok(pipe.played > 15, `played ${pipe.played}`);
  assert.ok(resource.playbackDuration > 300);

  clearInterval(feeder);
  pipe.destroy();
  await entersState(player, AudioPlayerStatus.Idle, 2000);
  player.stop(true);
});
