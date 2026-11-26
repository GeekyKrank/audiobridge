import type { LogLevel } from '../util/logger.js';

export interface Config {
  discordToken: string;
  discordClientId: string;
  discordGuildId: string;
  /** Empty set = anyone in the guild may use the commands. */
  allowedUserIds: Set<string>;
  logLevel: LogLevel;
}

const SNOWFLAKE = /^\d{17,20}$/;

/** Reads and validates environment variables. Throws a readable error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is missing`);
    return value ?? '';
  };
  const snowflake = (name: string): string => {
    const value = required(name);
    if (value && !SNOWFLAKE.test(value)) problems.push(`${name} must be a numeric Discord ID`);
    return value;
  };

  const discordToken = required('DISCORD_TOKEN');
  const discordClientId = snowflake('DISCORD_CLIENT_ID');
  const discordGuildId = snowflake('DISCORD_GUILD_ID');

  const allowedUserIds = new Set(
    (env.ALLOWED_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const id of allowedUserIds) {
    if (!SNOWFLAKE.test(id)) problems.push(`ALLOWED_USER_IDS contains an invalid ID: "${id}"`);
  }

  const rawLevel = (env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  const logLevel = (['debug', 'info', 'warn', 'error'] as const).find((l) => l === rawLevel);
  if (!logLevel) problems.push(`LOG_LEVEL must be debug, info, warn or error (got "${rawLevel}")`);

  if (problems.length > 0) {
    throw new Error(
      `Invalid configuration:\n  - ${problems.join('\n  - ')}\n` +
        `Copy .env.example to server/.env and fill it in (see docs/setup.md).`,
    );
  }

  return { discordToken, discordClientId, discordGuildId, allowedUserIds, logLevel: logLevel! };
}
