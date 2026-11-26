// The offscreen document owns everything that must keep running while the popup
// is closed: the captured tab stream, the encoder and the WebSocket.
// (Offscreen documents may only use chrome.runtime, so it reports to the service worker.)

import { AudioEngine } from './audio/engine.js';
import { StreamClient } from './net/stream-client.js';
import { toWebSocketUrl } from './lib/protocol.js';

let engine = null;
let client = null;
let reportTimer = null;
let startedAt = null;
let lastSnapshot = '';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.to !== 'offscreen') return false;
  handle(msg).then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => sendResponse({ ok: false, error: e?.message ?? String(e) }),
  );
  return true;
});

async function handle(msg) {
  switch (msg.cmd) {
    case 'start':
      return start(msg);
    case 'stop':
      // Requested by the service worker, which already knows: don't echo 'ended' back.
      await stop(msg.reason ?? 'stopped', false);
      return {};
    case 'meta':
      client?.updateSource(msg.source);
      return {};
    case 'monitor':
      engine?.setMonitor(msg.monitor, msg.monitorVolume);
      return {};
    case 'ping':
      return { alive: true, live: !!engine };
    default:
      throw new Error(`unknown command ${msg.cmd}`);
  }
}

async function start({ streamId, settings, source, clientId }) {
  await stop('restart', false);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });

  engine = new AudioEngine({
    workletUrl: chrome.runtime.getURL('src/audio/capture-worklet.js'),
    bitrate: settings.bitrate,
    monitor: settings.monitor,
    monitorVolume: settings.monitorVolume,
    silenceHoldMs: settings.silenceHoldMs,
  });
  client = new StreamClient({
    url: toWebSocketUrl(settings.serverUrl),
    token: settings.accessToken,
    clientId,
    autoReconnect: settings.autoReconnect,
    start: {
      channelId: settings.channelId || undefined,
      bufferMs: settings.bufferMs,
      bitrate: settings.bitrate,
      source,
    },
  });

  engine.onPacket = (data, silent) => client?.sendAudio(data, silent);
  engine.onAudibleChange = (audible) => {
    client?.setAudible(audible);
    report(true);
  };
  engine.onEnded = () => void stop('The tab stopped being captured.');
  engine.onError = (err) => void stop(`Encoder error: ${err.message}`);
  client.onChange = () => {
    report(true);
    if (client && (client.state === 'error' || client.state === 'closed')) {
      void stop(client.error ?? 'Disconnected');
    }
  };

  try {
    await engine.start(stream);
  } catch (e) {
    for (const t of stream.getTracks()) t.stop();
    engine = null;
    client = null;
    throw e;
  }
  startedAt = Date.now();
  client.connect();
  reportTimer = setInterval(() => report(false), 1000);
  return {};
}

async function stop(reason, notify = true) {
  clearInterval(reportTimer);
  reportTimer = null;
  const c = client;
  const e = engine;
  client = null;
  engine = null;
  if (c) {
    c.onChange = () => {};
    c.close();
  }
  if (e) await e.stop();
  if (notify && (c || e)) {
    chrome.runtime.sendMessage({ to: 'bg', event: 'ended', reason }).catch(() => {});
  }
}

function snapshot() {
  if (!client || !engine) return null;
  return {
    state: client.state,
    error: client.error,
    audible: engine.audible,
    rttMs: client.rttMs,
    channel: client.channel,
    server: client.serverStats,
    sent: client.sent,
    droppedNetwork: client.droppedBackpressure,
    encoderDrops: engine.stats.encoderDrops,
    codec: engine.stats.codec,
    bitrate: engine.opts.bitrate,
    startedAt,
  };
}

/** Sends status to the service worker: immediately on changes, else at most once per second. */
function report(force) {
  const s = snapshot();
  if (!s) return;
  const key = JSON.stringify(s);
  if (!force && key === lastSnapshot) return;
  lastSnapshot = key;
  chrome.runtime.sendMessage({ to: 'bg', event: 'status', status: s }).catch(() => {});
}
