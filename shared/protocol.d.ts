export declare const PROTOCOL_VERSION: 1;
export declare const AUDIO: Readonly<{ sampleRate: 48000; channels: 2; frameDurationMs: 20; frameSamples: 960 }>;
export declare const PACKET: Readonly<{ HEADER_BYTES: 4; KIND_AUDIO: 1; FLAG_SILENT: 1; MAX_OPUS_BYTES: 1275 }>;
export declare const LIMITS: Readonly<{
  maxMessageBytes: number;
  maxMessagesPerSecond: number;
  authTimeoutMs: number;
  minBufferMs: number;
  maxBufferMs: number;
}>;
export declare const CLOSE: Readonly<{
  NORMAL: 1000;
  AUTH_FAILED: 4001;
  AUTH_TIMEOUT: 4002;
  REPLACED: 4003;
  PROTOCOL_ERROR: 4004;
  RATE_LIMITED: 4005;
  SERVER_SHUTDOWN: 4006;
  VERSION_MISMATCH: 4007;
}>;
export declare const FATAL_CLOSE_CODES: readonly number[];
export declare function encodeAudioPacket(seq: number, flags: number, opus: Uint8Array): Uint8Array;
export declare function decodeAudioPacket(buf: Uint8Array): { seq: number; flags: number; payload: Uint8Array } | null;
export declare function toWebSocketUrl(serverUrl: string): string;

// ---------- Control messages (JSON text frames) ----------

export interface SourceInfo {
  title: string;
  site: string;
  url?: string;
  favIconUrl?: string;
  /** Chrome's own "this tab is making sound" flag. */
  audible?: boolean;
}

/** Extension -> server */
export type ClientMessage =
  | { type: 'hello'; token: string; version: number; clientId: string }
  | { type: 'start'; channelId?: string; bufferMs?: number; bitrate?: number; source: SourceInfo }
  | { type: 'stop' }
  | { type: 'meta'; source: SourceInfo }
  /** Sent when the tab goes silent (paused) for a while, or starts making sound again. */
  | { type: 'audible'; audible: boolean }
  | { type: 'ping'; t: number };

export interface ServerStats {
  /** Audio currently buffered on the server, in ms. */
  bufferMs: number;
  /** Incoming audio bitrate measured on the server, kbit/s. */
  kbps: number;
  packetsReceived: number;
  /** Packets dropped to keep latency bounded. */
  packetsDropped: number;
  /** Times the buffer ran empty (network stalls). */
  underruns: number;
  /** Sequence gaps detected (lost or skipped packets). */
  sequenceGaps: number;
  playing: boolean;
}

/** Server -> extension */
export type ServerMessage =
  | { type: 'welcome'; sessionId: string; serverVersion: string; bot: { ready: boolean; tag: string | null } }
  | { type: 'started'; channel: { id: string; name: string } | null; sinks: string[] }
  | { type: 'stopped'; reason: string }
  | { type: 'stats'; stats: ServerStats }
  | { type: 'pong'; t: number }
  | { type: 'error'; code: string; message: string };

// ---------- HTTP API (Authorization: Bearer <ACCESS_TOKEN>) ----------

export interface VoiceChannelInfo {
  id: string;
  name: string;
  members: number;
}

export interface ApiStatus {
  serverVersion: string;
  bot: { ready: boolean; tag: string | null; guild: { id: string; name: string } | null };
  voice: { channelId: string; channelName: string; connection: string; player: string } | null;
  stream: { active: boolean; since: string | null; source: SourceInfo | null; audible: boolean; stats: ServerStats | null };
  channels: VoiceChannelInfo[];
}
