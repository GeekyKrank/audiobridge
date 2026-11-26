import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeAudioPacket, encodeAudioPacket, PACKET, toWebSocketUrl } from '@soundbridge/shared';
import { parseClientMessage } from '../src/net/validate.js';

test('audio packet round trip', () => {
  const opus = new Uint8Array([1, 2, 3, 4, 5]);
  const buf = encodeAudioPacket(65535, PACKET.FLAG_SILENT, opus);
  const p = decodeAudioPacket(buf)!;
  assert.equal(p.seq, 65535);
  assert.equal(p.flags, PACKET.FLAG_SILENT);
  assert.deepEqual([...p.payload], [1, 2, 3, 4, 5]);
});

test('malformed audio packets are rejected', () => {
  assert.equal(decodeAudioPacket(new Uint8Array([1, 0, 0, 0])), null); // empty payload
  assert.equal(decodeAudioPacket(new Uint8Array([2, 0, 0, 0, 9])), null); // wrong kind
  assert.equal(decodeAudioPacket(new Uint8Array(4 + 1276).fill(1)), null); // too big
});

test('websocket url derivation', () => {
  assert.equal(toWebSocketUrl('https://sb.example.com'), 'wss://sb.example.com/ws');
  assert.equal(toWebSocketUrl('http://localhost:8787/'), 'ws://localhost:8787/ws');
});

test('control message validation', () => {
  assert.deepEqual(parseClientMessage('{"type":"ping","t":5}'), { type: 'ping', t: 5 });
  assert.equal(parseClientMessage('nope'), null);
  assert.equal(parseClientMessage('{"type":"start"}'), null);
  assert.equal(parseClientMessage('{"type":"start","channelId":"abc","source":{"title":"a","site":"b"}}'), null);
  assert.equal(parseClientMessage('{"type":"hello","token":"x","clientId":"y"}'), null);
  assert.equal(parseClientMessage('{"type":"drop_tables"}'), null);
  const s = parseClientMessage('{"type":"start","source":{"title":"t","site":"s","favIconUrl":"javascript:x"}}');
  assert.deepEqual(s, { type: 'start', source: { title: 't', site: 's' } });
});

test('extension copy of the protocol is identical to shared/protocol.js', () => {
  const a = readFileSync(new URL('../../shared/protocol.js', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../../extension/src/lib/protocol.js', import.meta.url), 'utf8');
  assert.equal(b, a, 'run `npm run sync-protocol`');
});
