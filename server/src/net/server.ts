import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  CLOSE,
  LIMITS,
  PROTOCOL_VERSION,
  decodeAudioPacket,
  type ApiStatus,
  type ServerMessage,
  type VoiceChannelInfo,
} from '@soundbridge/shared';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { AuthLimiter, tokensMatch } from '../auth/token.js';
import type { Config } from '../config/env.js';
import type { StreamHub, StreamOwner } from '../stream/hub.js';
import { SinkError } from '../stream/types.js';
import { createLogger } from '../util/logger.js';
import { SERVER_VERSION } from '../util/version.js';
import { parseClientMessage } from './validate.js';

const log = createLogger('net');

const STATS_INTERVAL_MS = 2000;
const HEARTBEAT_MS = 15_000;
const MAX_BODY_BYTES = 4096;

/** What the HTTP API needs from the Discord side. */
export interface BotControl {
  info(): ApiStatus['bot'];
  voice(): ApiStatus['voice'];
  channels(): VoiceChannelInfo[];
  join(channelId: string): Promise<{ id: string; name: string }>;
  leave(): boolean;
}

export const NO_BOT: BotControl = {
  info: () => ({ ready: false, tag: null, guild: null }),
  voice: () => null,
  channels: () => [],
  join: () => Promise.reject(new SinkError('DISCORD_DISABLED', 'Discord is disabled on this server.')),
  leave: () => false,
};

export interface AppServer {
  server: Server;
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

export function createAppServer(config: Config, hub: StreamHub, bot: BotControl): AppServer {
  const limiter = new AuthLimiter();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.maxMessageBytes,
    perMessageDeflate: false, // Opus is already compressed; deflate would only cost CPU
  });

  const clientIp = (req: IncomingMessage): string => {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  /** Browser origins allowed to talk to us. Non-browser clients send no Origin. */
  const originAllowed = (origin: string | undefined): boolean => {
    if (!origin) return true;
    if (config.allowedOrigins.has(origin)) return true;
    if (config.extensionId) return origin === `chrome-extension://${config.extensionId}`;
    return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  };

  const apiStatus = (): ApiStatus => ({
    serverVersion: SERVER_VERSION,
    bot: bot.info(),
    voice: bot.voice(),
    stream: hub.status(),
    channels: bot.channels(),
  });

  // ---------------- HTTP ----------------

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readJson = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (size === 0) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        } catch {
          reject(new Error('bad json'));
        }
      });
      req.on('error', reject);
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (url.pathname === '/health') return send(res, 200, { ok: true, version: SERVER_VERSION });
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not_found' });

    if (!originAllowed(origin)) return send(res, 403, { error: 'origin_not_allowed' });
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const ip = clientIp(req);
    if (limiter.isBlocked(ip)) return send(res, 429, { error: 'too_many_failed_attempts' });
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokensMatch(token, config.accessToken)) {
      limiter.fail(ip);
      log.warn(`HTTP auth failed from ${ip}`);
      return send(res, 401, { error: 'unauthorized' });
    }
    limiter.succeed(ip);

    try {
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /api/status':
          return send(res, 200, apiStatus());
        case 'POST /api/voice/join': {
          const body = await readJson(req);
          if (typeof body.channelId !== 'string' || !/^\d{17,20}$/.test(body.channelId)) {
            return send(res, 400, { error: 'bad_request', message: 'channelId required' });
          }
          const channel = await bot.join(body.channelId);
          return send(res, 200, { ok: true, channel });
        }
        case 'POST /api/voice/leave':
          await hub.forceStop('left voice');
          return send(res, 200, { ok: bot.leave() });
        case 'POST /api/stream/stop':
          return send(res, 200, { ok: await hub.forceStop('stopped via API') });
        default:
          return send(res, 404, { error: 'not_found' });
      }
    } catch (err) {
      if (err instanceof SinkError) return send(res, 409, { error: err.code, message: err.message });
      log.error('API error', err);
      return send(res, 500, { error: 'internal' });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  // ---------------- WebSocket ----------------

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/ws') return reject(404, 'Not Found');
    if (!originAllowed(req.headers.origin)) return reject(403, 'Forbidden');
    const ip = clientIp(req);
    if (limiter.isBlocked(ip)) return reject(429, 'Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => handleSocket(ws, ip));
  });

  const sockets = new Set<WebSocket>();

  function handleSocket(ws: WebSocket, ip: string): void {
    const id = randomUUID();
    let authed = false;
    let clientId = '';
    let alive = true;
    let windowStart = Date.now();
    let windowCount = 0;
    sockets.add(ws);

    const sendMsg = (m: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    const owner: StreamOwner = {
      id,
      get clientId() {
        return clientId;
      },
      close: (code, reason) => ws.close(code, reason),
    };

    const authTimer = setTimeout(() => ws.close(CLOSE.AUTH_TIMEOUT, 'Authentication timeout'), LIMITS.authTimeoutMs);
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    const statsTimer = setInterval(() => {
      if (!hub.isOwner(id)) return;
      const stats = hub.stats();
      if (stats) sendMsg({ type: 'stats', stats });
    }, STATS_INTERVAL_MS);
    ws.on('pong', () => (alive = true));

    ws.on('message', (data: RawData, isBinary: boolean) => {
      // Rate limit: protects the 1-CPU server from floods.
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        windowCount = 0;
      }
      if (++windowCount > LIMITS.maxMessagesPerSecond) {
        log.warn(`Rate limit exceeded by ${ip}`);
        return ws.close(CLOSE.RATE_LIMITED, 'Too many messages');
      }

      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);

      if (!authed) {
        const msg = isBinary ? null : parseClientMessage(buf.toString('utf8'));
        if (!msg || msg.type !== 'hello') return ws.close(CLOSE.PROTOCOL_ERROR, 'Expected hello');
        if (!tokensMatch(msg.token, config.accessToken)) {
          limiter.fail(ip);
          log.warn(`WebSocket auth failed from ${ip}`);
          return ws.close(CLOSE.AUTH_FAILED, 'Invalid access token');
        }
        if (msg.version !== PROTOCOL_VERSION) {
          return ws.close(CLOSE.VERSION_MISMATCH, `Server speaks protocol v${PROTOCOL_VERSION}`);
        }
        limiter.succeed(ip);
        clearTimeout(authTimer);
        authed = true;
        clientId = msg.clientId;
        log.info(`Extension connected from ${ip} (session ${id.slice(0, 8)})`);
        const b = bot.info();
        return sendMsg({
          type: 'welcome',
          sessionId: id,
          serverVersion: SERVER_VERSION,
          bot: { ready: b.ready, tag: b.tag },
        });
      }

      if (isBinary) {
        const pkt = decodeAudioPacket(buf);
        if (!pkt) return ws.close(CLOSE.PROTOCOL_ERROR, 'Malformed audio packet');
        hub.packet(id, pkt.seq, Buffer.from(pkt.payload));
        return;
      }

      const msg = parseClientMessage(buf.toString('utf8'));
      if (!msg || msg.type === 'hello') return ws.close(CLOSE.PROTOCOL_ERROR, 'Malformed message');
      switch (msg.type) {
        case 'ping':
          return sendMsg({ type: 'pong', t: msg.t });
        case 'start': {
          const bufferMs = Math.min(
            Math.max(msg.bufferMs ?? config.bufferMs, LIMITS.minBufferMs),
            config.maxBufferMs - 100,
          );
          hub
            .start(owner, { channelId: msg.channelId, bufferMs, source: msg.source })
            .then((r) => sendMsg({ type: 'started', channel: r.channel, sinks: r.sinks }))
            .catch((err: unknown) => {
              const e = err instanceof SinkError ? err : new SinkError('START_FAILED', String(err));
              log.warn(`Start refused: ${e.message}`);
              sendMsg({ type: 'error', code: e.code, message: e.message });
            });
          return;
        }
        case 'stop':
          void hub.stop(id, 'stopped by extension').then(() => sendMsg({ type: 'stopped', reason: 'stopped' }));
          return;
        case 'meta':
          return hub.updateSource(id, msg.source);
        case 'audible':
          return hub.setAudible(id, msg.audible);
      }
    });

    ws.on('close', (code) => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      clearInterval(statsTimer);
      sockets.delete(ws);
      if (authed) {
        log.info(`Extension disconnected (session ${id.slice(0, 8)}, code ${code})`);
        hub.ownerDisconnected(id);
      }
    });
    ws.on('error', (err) => log.warn(`WebSocket error from ${ip}: ${err.message}`));
  }

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : config.port;
          log.info(`Listening on http://${config.host}:${port} (WebSocket at /ws)`);
          resolve({ port });
        });
      }),
    close: async () => {
      for (const ws of sockets) ws.close(CLOSE.SERVER_SHUTDOWN, 'Server shutting down');
      await new Promise((r) => setTimeout(r, 300).unref());
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
