import type { ClientMessage, SourceInfo } from '@soundbridge/shared';

const SNOWFLAKE = /^\d{17,20}$/;

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length <= max ? v : null;

function parseSource(v: unknown): SourceInfo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const title = str(o.title, 300);
  const site = str(o.site, 200);
  if (title === null || site === null) return null;
  const src: SourceInfo = { title, site };
  const url = str(o.url, 2000);
  if (url) src.url = url;
  const fav = str(o.favIconUrl, 2000);
  if (fav && /^https?:\/\//.test(fav)) src.favIconUrl = fav;
  if (typeof o.audible === 'boolean') src.audible = o.audible;
  return src;
}

/** Strictly parses a JSON control message. Anything unexpected returns null. */
export function parseClientMessage(text: string): ClientMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  switch (o.type) {
    case 'hello': {
      const token = str(o.token, 512);
      const clientId = str(o.clientId, 64);
      if (!token || !clientId || typeof o.version !== 'number') return null;
      return { type: 'hello', token, clientId, version: o.version };
    }
    case 'start': {
      const source = parseSource(o.source);
      if (!source) return null;
      const msg: ClientMessage = { type: 'start', source };
      if (o.channelId !== undefined && o.channelId !== null && o.channelId !== '') {
        if (typeof o.channelId !== 'string' || !SNOWFLAKE.test(o.channelId)) return null;
        msg.channelId = o.channelId;
      }
      if (typeof o.bufferMs === 'number' && Number.isFinite(o.bufferMs)) msg.bufferMs = o.bufferMs;
      if (typeof o.bitrate === 'number' && Number.isFinite(o.bitrate)) msg.bitrate = o.bitrate;
      return msg;
    }
    case 'stop':
      return { type: 'stop' };
    case 'meta': {
      const source = parseSource(o.source);
      return source ? { type: 'meta', source } : null;
    }
    case 'audible':
      return typeof o.audible === 'boolean' ? { type: 'audible', audible: o.audible } : null;
    case 'ping':
      return typeof o.t === 'number' && Number.isFinite(o.t) ? { type: 'ping', t: o.t } : null;
    default:
      return null;
  }
}
