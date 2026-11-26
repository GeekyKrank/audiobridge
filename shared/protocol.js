// SoundBridge wire protocol — shared by the extension and the server.
// SOURCE OF TRUTH. The extension keeps an identical copy at
// extension/src/lib/protocol.js (run `npm run sync-protocol` after editing;
// a test fails if the copies differ). Plain JS so the extension needs no build step.

export const PROTOCOL_VERSION = 1;

/** Discord voice format. The browser encodes exactly this so the server never transcodes. */
export const AUDIO = Object.freeze({
  sampleRate: 48000,
  channels: 2,
  frameDurationMs: 20,
  frameSamples: 960, // 48000 * 0.020
});

/**
 * Binary audio message layout (one Opus packet per WebSocket message):
 *   byte 0     kind   (0x01 = audio)
 *   byte 1     flags  (bit 0 = frame is silent)
 *   bytes 2-3  sequence number, uint16 big-endian, wraps at 65535
 *   bytes 4..  one raw Opus packet (20 ms, 48 kHz, stereo)
 */
export const PACKET = Object.freeze({
  HEADER_BYTES: 4,
  KIND_AUDIO: 0x01,
  FLAG_SILENT: 0x01,
  MAX_OPUS_BYTES: 1275, // RFC 6716 maximum for one frame
});

export const LIMITS = Object.freeze({
  /** Max size of any WebSocket message (JSON control or audio). */
  maxMessageBytes: 8192,
  /** Audio is 50 packets/s; allow bursts after network hiccups. */
  maxMessagesPerSecond: 200,
  /** The first message must be a valid `hello` within this time. */
  authTimeoutMs: 5000,
  /** Accepted range for the client's requested jitter buffer. */
  minBufferMs: 100,
  maxBufferMs: 3000,
});

/** WebSocket close codes used by SoundBridge (4000-4999 is the application range). */
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  AUTH_FAILED: 4001,
  AUTH_TIMEOUT: 4002,
  REPLACED: 4003,
  PROTOCOL_ERROR: 4004,
  RATE_LIMITED: 4005,
  SERVER_SHUTDOWN: 4006,
  VERSION_MISMATCH: 4007,
});

/** Close codes after which the client must NOT auto-reconnect. */
export const FATAL_CLOSE_CODES = Object.freeze([
  CLOSE.AUTH_FAILED,
  CLOSE.REPLACED,
  CLOSE.VERSION_MISMATCH,
]);

/**
 * @param {number} seq
 * @param {number} flags
 * @param {Uint8Array} opus
 * @returns {Uint8Array}
 */
export function encodeAudioPacket(seq, flags, opus) {
  const out = new Uint8Array(PACKET.HEADER_BYTES + opus.byteLength);
  out[0] = PACKET.KIND_AUDIO;
  out[1] = flags & 0xff;
  out[2] = (seq >>> 8) & 0xff;
  out[3] = seq & 0xff;
  out.set(opus, PACKET.HEADER_BYTES);
  return out;
}

/**
 * Validates and parses a binary audio message. Returns null for anything malformed.
 * @param {Uint8Array} buf
 * @returns {{ seq: number, flags: number, payload: Uint8Array } | null}
 */
export function decodeAudioPacket(buf) {
  if (!(buf instanceof Uint8Array)) return null;
  const payloadLength = buf.byteLength - PACKET.HEADER_BYTES;
  if (payloadLength < 1 || payloadLength > PACKET.MAX_OPUS_BYTES) return null;
  if (buf[0] !== PACKET.KIND_AUDIO) return null;
  return {
    flags: buf[1],
    seq: (buf[2] << 8) | buf[3],
    payload: buf.subarray(PACKET.HEADER_BYTES),
  };
}

/** Returns a URL for the audio WebSocket given the configured server base URL. */
export function toWebSocketUrl(serverUrl) {
  const u = new URL(serverUrl);
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  u.pathname = u.pathname.replace(/\/+$/, '') + '/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}
