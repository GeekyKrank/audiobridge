import type { LogLevel } from '../util/logger.js';

export interface Config {
  discordEnabled: boolean;
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  /** Empty set = anyone in the guild may use the slash commands. */
  allowedUserIds: Set<string>;
  defaultVoiceChannelId: string | null;
  leaveOnStop: boolean;

  host: string;
  port: number;
  /** Shared secret the extension must present. */
  accessToken: string;
  /** Trust X-Forwarded-For (only when behind our own reverse proxy). */
  trustProxy: boolean;
  /** Extra allowed browser origins besides chrome-extension://*. */
  allowedOrigins: Set<string>;
  /** If set, only this chrome-extension:// ID may connect. */
  extensionId: string | null;

  bufferMs: number;
  maxBufferMs: number;
  /** If set, every stream is also written to an .ogg file here (debugging). */
  recordDir: string | null;

  logLevel: LogLevel;
}

const SNOWFLAKE = /^\d{17,20}$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const get = (name: string) => env[name]?.trim() ?? '';
  const bool = (name: string, def: boolean) => {
    const v = get(name).toLowerCase();
    if (!v) return def;
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    problems.push(`${name} must be true or false`);
    return def;
  };
  const int = (name: string, def: number, min: number, max: number) => {
    const v = get(name);
    if (!v) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return def;
    }
    return n;
  };
  const snowflake = (name: string, required: boolean) => {
    const v = get(name);
    if (!v) {
      if (required) problems.push(`${name} is missing`);
      return '';
    }
    if (!SNOWFLAKE.test(v)) problems.push(`${name} must be a numeric Discord ID`);
    return v;
  };

  const discordEnabled = bool('DISCORD_ENABLED', true);
  const discordToken = get('DISCORD_TOKEN');
  if (discordEnabled && !discordToken) problems.push('DISCORD_TOKEN is missing');
  const discordClientId = snowflake('DISCORD_CLIENT_ID', discordEnabled);
  const discordGuildId = snowflake('DISCORD_GUILD_ID', discordEnabled);
  const defaultVoiceChannelId = snowflake('DEFAULT_VOICE_CHANNEL_ID', false) || null;

  const allowedUserIds = new Set(get('ALLOWED_USER_IDS').split(',').map((s) => s.trim()).filter(Boolean));
  for (const id of allowedUserIds) {
    if (!SNOWFLAKE.test(id)) problems.push(`ALLOWED_USER_IDS contains an invalid ID: "${id}"`);
  }

  const accessToken = get('ACCESS_TOKEN');
  if (!accessToken) problems.push('ACCESS_TOKEN is missing (generate one with `npm run gen-token`)');
  else if (accessToken.length < 24) problems.push('ACCESS_TOKEN must be at least 24 characters');

  const extensionId = get('EXTENSION_ID') || null;
  if (extensionId && !/^[a-p]{32}$/.test(extensionId)) {
    problems.push('EXTENSION_ID must be the 32-letter ID shown on chrome://extensions');
  }
  const allowedOrigins = new Set(get('ALLOWED_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean));

  const bufferMs = int('BUFFER_MS', 400, 100, 3000);
  const maxBufferMs = int('MAX_BUFFER_MS', 1500, 200, 5000);
  if (maxBufferMs <= bufferMs) problems.push('MAX_BUFFER_MS must be larger than BUFFER_MS');

  const rawLevel = (get('LOG_LEVEL') || 'info').toLowerCase();
  const logLevel = (['debug', 'info', 'warn', 'error'] as const).find((l) => l === rawLevel);
  if (!logLevel) problems.push(`LOG_LEVEL must be debug, info, warn or error (got "${rawLevel}")`);

  const config: Config = {
    discordEnabled,
    discordToken,
    discordClientId,
    discordGuildId,
    allowedUserIds,
    defaultVoiceChannelId,
    leaveOnStop: bool('LEAVE_ON_STOP', false),
    host: get('HOST') || '127.0.0.1',
    port: int('PORT', 8787, 0, 65535), // 0 = pick a free port (tests)
    accessToken,
    trustProxy: bool('TRUST_PROXY', false),
    allowedOrigins,
    extensionId,
    bufferMs,
    maxBufferMs,
    recordDir: get('RECORD_DIR') || null,
    logLevel: logLevel ?? 'info',
  };

  if (problems.length > 0) {
    throw new Error(
      `Invalid configuration:\n  - ${problems.join('\n  - ')}\n` +
        'Copy .env.example to server/.env and fill it in (see docs/setup.md).',
    );
  }
  return config;
}
