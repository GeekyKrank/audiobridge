import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { CLOSE, PROTOCOL_VERSION, encodeAudioPacket, type ServerMessage } from '@soundbridge/shared';
import WebSocket from 'ws';
import { loadConfig } from '../src/config/env.js';
import { createAppServer, NO_BOT, type AppServer } from '../src/net/server.js';
import { StreamHub } from '../src/stream/hub.js';
import type { AudioSink } from '../src/stream/types.js';
import { sleep } from './helpers.js';

const TOKEN = 'test-token-0123456789abcdefghij';

class FakeSink implements AudioSink {
  readonly name = 'fake';
  packets: Buffer[] = [];
  events: string[] = [];
  async begin() {
    this.events.push('begin');
    return { channel: { id: '1', name: 'general' } };
  }
  packet(p: Buffer) {
    this.packets.push(p);
  }
  silence() {
    this.events.push('silence');
  }
  async end(reason: string) {
    this.events.push(`end:${reason}`);
  }
  stats() {
    return null;
  }
}

let app: AppServer;
let base: string;
let wsUrl: string;
const sink = new FakeSink();
const hub = new StreamHub([sink]);

before(async () => {
  const config = loadConfig({ DISCORD_ENABLED: 'false', ACCESS_TOKEN: TOKEN, PORT: '0', LOG_LEVEL: 'error' });
  app = createAppServer(config, hub, NO_BOT);
  const { port } = await app.listen();
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
after(async () => {
  await hub.shutdown();
  await app.close();
});

/** Opens a socket and collects JSON messages + the close code. */
function connect(origin?: string) {
  const ws = new WebSocket(wsUrl, origin ? { origin } : {});
  const messages: ServerMessage[] = [];
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  ws.on('message', (d, bin) => !bin && messages.push(JSON.parse(d.toString())));
  const opened = new Promise<void>((r, j) => {
    ws.on('open', () => r());
    ws.on('error', j);
  });
  const waitFor = async (type: string, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = messages.find((x) => x.type === type);
      if (m) return m;
      await sleep(10);
    }
    throw new Error(`timeout waiting for ${type}; got ${JSON.stringify(messages)}`);
  };
  const json = (o: unknown) => ws.send(JSON.stringify(o));
  return { ws, messages, closed, opened, waitFor, json };
}

test('health endpoint is public', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
});

test('API requires the token', async () => {
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  const ok = await fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.stream.active, false);
});

test('API CORS: extension origins allowed, websites rejected', async () => {
  const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
  const pre = await fetch(`${base}/api/status`, { method: 'OPTIONS', headers: { Origin: ext } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ext);
  const evil = await fetch(`${base}/api/status`, { headers: { Origin: 'https://evil.example', Authorization: `Bearer ${TOKEN}` } });
  assert.equal(evil.status, 403);
});

test('websocket: wrong token is rejected', async () => {
  const c = connect();
  await c.opened;
  c.json({ type: 'hello', token: 'wrong', version: PROTOCOL_VERSION, clientId: 'a' });
  assert.equal(await c.closed, CLOSE.AUTH_FAILED);
});

test('websocket: audio before hello is a protocol error', async () => {
  const c = connect();
  await c.opened;
  c.ws.send(encodeAudioPacket(0, 0, new Uint8Array([1, 2, 3])));
  assert.equal(await c.closed, CLOSE.PROTOCOL_ERROR);
});

test('websocket: website origins cannot connect', async () => {
  const c = connect('https://evil.example');
  await assert.rejects(c.opened);
});

test('websocket: full stream lifecycle, then takeover by a second session', async () => {
  const a = connect();
  await a.opened;
  a.json({ type: 'hello', token: TOKEN, version: PROTOCOL_VERSION, clientId: 'tab-1' });
  await a.waitFor('welcome');
  a.json({ type: 'start', source: { title: 'Song', site: 'soundcloud.com' } });
  const started = await a.waitFor('started');
  assert.deepEqual((started as { channel: unknown }).channel, { id: '1', name: 'general' });

  for (let i = 0; i < 10; i++) a.ws.send(encodeAudioPacket(i, 0, new Uint8Array([i, 0xaa])));
  a.json({ type: 'ping', t: 42 });
  await a.waitFor('pong');
  assert.equal(sink.packets.length, 10);
  assert.equal(hub.status().stats?.sequenceGaps, 0);

  a.json({ type: 'audible', audible: false });
  await sleep(50);
  assert.equal(hub.status().audible, false);
  assert.ok(sink.events.includes('silence'));

  // Second session takes over: first gets REPLACED, packets from first are ignored.
  const b = connect();
  await b.opened;
  b.json({ type: 'hello', token: TOKEN, version: PROTOCOL_VERSION, clientId: 'tab-2' });
  await b.waitFor('welcome');
  b.json({ type: 'start', source: { title: 'Other', site: 'youtube.com' } });
  await b.waitFor('started');
  assert.equal(await a.closed, CLOSE.REPLACED);
  assert.equal(hub.status().source?.title, 'Other');

  b.json({ type: 'stop' });
  await b.waitFor('stopped');
  assert.equal(hub.isActive, false);
  b.ws.close();
  await b.closed;
});

test('websocket: disconnect keeps the stream for a grace period, reconnect resumes it', async () => {
  const a = connect();
  await a.opened;
  a.json({ type: 'hello', token: TOKEN, version: PROTOCOL_VERSION, clientId: 'tab-x' });
  await a.waitFor('welcome');
  a.json({ type: 'start', source: { title: 'Song', site: 'soundcloud.com' } });
  await a.waitFor('started');
  a.ws.terminate();
  await a.closed;
  await sleep(50);
  assert.equal(hub.isActive, true, 'still active during grace period');

  const b = connect();
  await b.opened;
  b.json({ type: 'hello', token: TOKEN, version: PROTOCOL_VERSION, clientId: 'tab-x' });
  await b.waitFor('welcome');
  b.json({ type: 'start', source: { title: 'Song', site: 'soundcloud.com' } });
  await b.waitFor('started');
  assert.equal(hub.isActive, true);
  b.ws.close();
  await b.closed;
});

test('websocket: flooding is rate limited', async () => {
  const c = connect();
  await c.opened;
  c.json({ type: 'hello', token: TOKEN, version: PROTOCOL_VERSION, clientId: 'flood' });
  await c.waitFor('welcome');
  for (let i = 0; i < 400; i++) c.json({ type: 'ping', t: i });
  assert.equal(await c.closed, CLOSE.RATE_LIMITED);
});
