// End-to-end test of the real audio pipeline without Discord:
//   synthetic tone -> extension AudioEngine (AudioWorklet + WebCodecs Opus) -> StreamClient
//   -> SoundBridge server (DISCORD_ENABLED=false, RECORD_DIR) -> .ogg file -> ffprobe/ffmpeg checks.
// Also loads the unpacked extension and checks the service worker + popup render.
//
// Usage: npm run e2e        (needs Playwright + Chromium, and ffmpeg)

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const TOKEN = 'e2e-token-abcdefghijklmnopqrstuvwxyz';
const SERVER_PORT = 18787;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (s) => console.log(`\n▶ ${s}`);
const ok = (s) => console.log(`  ✓ ${s}`);

// ---------- static server for the harness page ----------
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' };
const HARNESS = `<!doctype html><meta charset="utf-8"><script type="module">
import { AudioEngine } from '/extension/src/audio/engine.js';
import { StreamClient } from '/extension/src/net/stream-client.js';
import { toWebSocketUrl } from '/extension/src/lib/protocol.js';
window.setup = async ({ serverUrl, token }) => {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const osc = ctx.createOscillator(); osc.frequency.value = 440;
  const gain = ctx.createGain(); gain.gain.value = 0.3;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dest); osc.start();
  const log = [];
  const engine = new AudioEngine({ workletUrl: '/extension/src/audio/capture-worklet.js', bitrate: 128000,
    monitor: false, monitorVolume: 0, silenceHoldMs: 1000 });
  const client = new StreamClient({ url: toWebSocketUrl(serverUrl), token, clientId: 'e2e', autoReconnect: true,
    start: { bufferMs: 300, source: { title: 'E2E tone', site: 'localhost' } } });
  engine.onPacket = (d, s) => client.sendAudio(d, s);
  engine.onAudibleChange = (a) => { log.push('audible:' + a); client.setAudible(a); };
  engine.onError = (e) => log.push('engine-error:' + e.message);
  client.onChange = () => log.push('state:' + client.state + (client.error ? ' (' + client.error + ')' : ''));
  await engine.start(dest.stream);
  client.connect();
  window.sb = { engine, client, gain, log };
  return engine.stats.codec;
};
</script>`;
const web = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/harness.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(HARNESS);
  }
  const file = join(ROOT, url.pathname);
  if (!file.startsWith(join(ROOT, 'extension')) || !existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const webOrigin = `http://127.0.0.1:${web.address().port}`;

// ---------- SoundBridge server ----------
const recordDir = mkdtempSync(join(tmpdir(), 'sb-e2e-'));
let serverLog = '';
function startServer() {
  const p = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: join(ROOT, 'server'),
    env: {
      ...process.env,
      DISCORD_ENABLED: 'false',
      ACCESS_TOKEN: TOKEN,
      PORT: String(SERVER_PORT),
      RECORD_DIR: recordDir,
      ALLOWED_ORIGINS: webOrigin,
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => (serverLog += d));
  p.stderr.on('data', (d) => (serverLog += d));
  return p;
}
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${SERVER_PORT}/health`)).ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('server did not start\n' + serverLog);
}
const status = async () =>
  (await fetch(`http://127.0.0.1:${SERVER_PORT}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();

let server = startServer();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

try {
  await waitForServer();

  step('Audio engine + WebSocket stream');
  const page = await browser.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log('  [page]', m.text()));
  await page.goto(`${webOrigin}/harness.html`);
  const codec = await page.evaluate((o) => window.setup(o), { serverUrl: `http://127.0.0.1:${SERVER_PORT}`, token: TOKEN });
  ok(`encoder configured: ${codec}`);
  await page.waitForFunction(() => window.sb.client.state === 'live', null, { timeout: 5000 });
  ok('client is live');
  await sleep(2000);
  let s = await status();
  assert.equal(s.stream.active, true);
  assert.equal(s.stream.audible, true);
  assert.ok(s.stream.stats.packetsReceived > 70, `packets ${s.stream.stats.packetsReceived}`);
  assert.ok(s.stream.stats.kbps > 60 && s.stream.stats.kbps < 200, `kbps ${s.stream.stats.kbps}`);
  ok(`server receiving: ${s.stream.stats.packetsReceived} packets, ${s.stream.stats.kbps} kbit/s, gaps ${s.stream.stats.sequenceGaps}`);

  step('Pause detection (tone muted)');
  await page.evaluate(() => (window.sb.gain.gain.value = 0));
  await sleep(1600);
  s = await status();
  assert.equal(s.stream.audible, false, 'server should know the source is silent');
  const before = s.stream.stats.packetsReceived;
  await sleep(500);
  assert.equal((await status()).stream.stats.packetsReceived, before, 'no packets while paused');
  ok('extension stopped sending, server marked stream silent');

  step('Resume');
  await page.evaluate(() => (window.sb.gain.gain.value = 0.3));
  await sleep(1500);
  s = await status();
  assert.equal(s.stream.audible, true);
  assert.ok(s.stream.stats.packetsReceived > before + 40);
  ok('audio flowing again');

  step('Server restart -> automatic reconnect');
  server.kill('SIGTERM');
  await page.waitForFunction(() => window.sb.client.state === 'reconnecting', null, { timeout: 5000 });
  ok('client noticed and is reconnecting');
  server = startServer();
  await waitForServer();
  await page.waitForFunction(() => window.sb.client.state === 'live', null, { timeout: 15000 });
  await sleep(1500);
  s = await status();
  assert.ok(s.stream.active && s.stream.stats.packetsReceived > 40);
  ok(`live again after restart (${s.stream.stats.packetsReceived} packets)`);

  step('Stop');
  await page.evaluate(async () => {
    window.sb.client.close();
    await window.sb.engine.stop();
  });
  await sleep(500);
  assert.equal((await status()).stream.active, false);
  ok('stream stopped on server');
  console.log('  client log:', (await page.evaluate(() => window.sb.log)).join(', '));

  step('Recorded audio is valid Opus with the tone in it');
  const files = readdirSync(recordDir).filter((f) => f.endsWith('.ogg')).sort();
  assert.ok(files.length >= 2, `recordings: ${files}`);
  for (const f of files) {
    const path = join(recordDir, f);
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path]));
    const st = info.streams[0];
    assert.equal(st.codec_name, 'opus');
    assert.equal(st.channels, 2);
    const meanDb = (filter) => {
      const r = spawnSync('ffmpeg', ['-v', 'info', '-i', path, '-af', `${filter}volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
      return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1] ?? Number.NaN);
    };
    const mean = meanDb('');
    // Spectrum check: almost all energy must be in a narrow band around 440 Hz.
    const band = meanDb('bandpass=f=440:width_type=h:w=60,');
    assert.ok(mean > -25, `mean volume ${mean}`);
    assert.ok(mean - band < 3, `440 Hz band ${band} dB vs total ${mean} dB`);
    ok(`${f}: opus ${st.sample_rate} Hz ${st.channels}ch, ${Number(info.format.duration).toFixed(1)} s, mean ${mean} dB, 440 Hz band ${band} dB`);
  }
  await page.close();

  step('Unpacked extension loads (service worker + popup)');
  const profile = mkdtempSync(join(tmpdir(), 'sb-profile-'));
  const ext = join(ROOT, 'extension');
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent('serviceworker', { timeout: 10000 });
    const extId = new URL(sw.url()).host;
    ok(`service worker running (${extId})`);
    const popup = await ctx.newPage();
    const errors = [];
    popup.on('pageerror', (e) => errors.push(e.message));
    popup.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await popup.setViewportSize({ width: 380, height: 600 });
    await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
    await popup.waitForSelector('#view-settings:not([hidden])');
    ok('first run opens Settings');
    const shots = join(ROOT, 'docs', 'screenshots');
    mkdirSync(shots, { recursive: true });
    await popup.screenshot({ path: join(shots, 'popup-settings.png') });
    await popup.evaluate(
      ([url, token]) => chrome.storage.local.set({ settings: { serverUrl: url, accessToken: token } }),
      [`http://127.0.0.1:${SERVER_PORT}`, TOKEN],
    );
    const site = await ctx.newPage();
    await site.goto(`${webOrigin}/harness.html`);
    await popup.reload();
    await popup.waitForFunction(() => document.querySelector('#conn').dataset.state === 'connected', null, { timeout: 8000 });
    ok('popup talks to the server API (CORS + token)');
    await popup.screenshot({ path: join(shots, 'popup-main.png') });
    assert.deepEqual(errors, [], `popup errors: ${errors}`);
    ok('no errors in popup; screenshots in docs/screenshots/');
  } finally {
    await ctx.close();
  }

  console.log('\nE2E PASSED');
} catch (err) {
  console.error('\nE2E FAILED:', err);
  console.error('--- server log ---\n' + serverLog.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
  web.close();
}
