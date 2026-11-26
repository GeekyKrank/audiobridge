import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpusJitterStream } from '../src/audio/jitter.js';

const pkt = (n: number) => Buffer.from([n]);

test('waits for target before releasing packets, announces readable once', () => {
  const j = new OpusJitterStream({ targetFrames: 3, maxFrames: 10 });
  let readable = 0;
  j.on('readable', () => readable++);
  j.enqueue(pkt(1));
  j.enqueue(pkt(2));
  assert.equal(j.read(), null);
  j.enqueue(pkt(3));
  assert.equal(readable, 1);
  assert.deepEqual(j.read(), pkt(1));
  assert.equal(j.read(0), null, 'read(0) must not consume');
  assert.deepEqual(j.read(), pkt(2));
  assert.deepEqual(j.read(), pkt(3));
});

test('underrun re-buffers to target', () => {
  const j = new OpusJitterStream({ targetFrames: 2, maxFrames: 10 });
  j.enqueue(pkt(1));
  j.enqueue(pkt(2));
  j.read();
  j.read();
  assert.equal(j.read(), null);
  assert.equal(j.underruns, 1);
  j.enqueue(pkt(3));
  assert.equal(j.read(), null, 'still priming');
  j.enqueue(pkt(4));
  assert.deepEqual(j.read(), pkt(3));
});

test('drops oldest packets when latency exceeds max', () => {
  const j = new OpusJitterStream({ targetFrames: 2, maxFrames: 4 });
  for (let i = 1; i <= 5; i++) j.enqueue(pkt(i));
  assert.equal(j.bufferedFrames, 2);
  assert.equal(j.dropped, 3);
  assert.deepEqual(j.read(), pkt(4));
});

test('destroy ends the stream', () => {
  const j = new OpusJitterStream({ targetFrames: 1, maxFrames: 4 });
  j.enqueue(pkt(1));
  j.destroy();
  assert.equal(j.readable, false);
  assert.equal(j.read(), null);
});
