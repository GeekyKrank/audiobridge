// WebSocket connection to the SoundBridge server: auth, start, audio, keepalive, reconnect.

import { CLOSE, FATAL_CLOSE_CODES, PACKET, PROTOCOL_VERSION, encodeAudioPacket } from '../lib/protocol.js';

const PING_MS = 3000;
/** Never queue more than ~2 s of audio in the socket; drop instead (keeps latency low). */
const MAX_BUFFERED_BYTES = 48 * 1024;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

/**
 * States: idle -> connecting -> starting -> live
 *         live -> reconnecting -> connecting ...
 *         any  -> error | closed
 */
export class StreamClient {
  /**
   * @param {{ url: string, token: string, clientId: string, autoReconnect: boolean, start: object }} opts
   *   `start` is the `start` message body (without type), re-sent after every reconnect.
   */
  constructor(opts) {
    this.opts = opts;
    this.ws = null;
    this.state = 'idle';
    this.error = null;
    this.seq = 0;
    this.attempt = 0;
    this.rttMs = null;
    this.serverStats = null;
    this.channel = null;
    this.audible = true;
    this.sent = 0;
    this.droppedBackpressure = 0;
    this.pingTimer = null;
    this.retryTimer = null;
    /** @type {() => void} */
    this.onChange = () => {};
  }

  setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.onChange();
  }

  connect() {
    clearTimeout(this.retryTimer);
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ws;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.setState('error', `Bad server URL: ${e.message}`);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      this.send({ type: 'hello', token: this.opts.token, version: PROTOCOL_VERSION, clientId: this.opts.clientId });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = (ev) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.state === 'closed' || this.state === 'error') return;
      if (FATAL_CLOSE_CODES.includes(ev.code)) {
        const why =
          ev.code === CLOSE.AUTH_FAILED ? 'The server rejected the access token.'
          : ev.code === CLOSE.REPLACED ? 'Another SoundBridge session took over the stream.'
          : ev.reason || `Closed (${ev.code})`;
        this.setState('error', why);
        return;
      }
      if (ev.code === CLOSE.NORMAL && ev.reason) {
        this.setState('closed', ev.reason);
        return;
      }
      if (!this.opts.autoReconnect) {
        this.setState('error', 'Connection to the server was lost.');
        return;
      }
      const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
      this.attempt++;
      this.setState('reconnecting', `Connection lost, retrying in ${Math.round(delay / 1000)} s`);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      // onclose follows and handles it.
    };
  }

  handle(msg) {
    switch (msg.type) {
      case 'welcome':
        this.setState('starting');
        this.send({ type: 'start', ...this.opts.start });
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send({ type: 'ping', t: performance.now() }), PING_MS);
        this.send({ type: 'ping', t: performance.now() });
        break;
      case 'started':
        this.attempt = 0;
        this.channel = msg.channel;
        this.setState('live');
        if (!this.audible) this.send({ type: 'audible', audible: false });
        break;
      case 'pong':
        this.rttMs = Math.round(performance.now() - msg.t);
        break;
      case 'stats':
        this.serverStats = msg.stats;
        break;
      case 'error':
        this.setState('error', msg.message || msg.code);
        this.ws?.close(1000);
        break;
      case 'stopped':
        break;
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** @param {Uint8Array} opus @param {boolean} silent */
  sendAudio(opus, silent) {
    const ws = this.ws;
    if (this.state !== 'live' || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.droppedBackpressure++;
      return;
    }
    ws.send(encodeAudioPacket(this.seq, silent ? PACKET.FLAG_SILENT : 0, opus));
    this.seq = (this.seq + 1) & 0xffff;
    this.sent++;
  }

  setAudible(audible) {
    this.audible = audible;
    if (this.state === 'live') this.send({ type: 'audible', audible });
  }

  updateSource(source) {
    this.opts.start = { ...this.opts.start, source };
    if (this.state === 'live') this.send({ type: 'meta', source });
  }

  close() {
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.state = 'closed';
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
      setTimeout(() => ws.close(1000), 100);
    } else ws?.close();
  }
}
