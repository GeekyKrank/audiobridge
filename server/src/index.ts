import { loadConfig } from './config/env.js';
import { createDiscordClient } from './discord/client.js';
import { VoiceManager } from './discord/voice.js';
import { createLogger, setLogLevel } from './util/logger.js';

const log = createLogger('main');

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const voice = new VoiceManager();
  const client = createDiscordClient({ config, voice });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    voice.leaveAll();
    await client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection', reason));

  await client.login(config.discordToken);
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : 'Fatal error', err instanceof Error ? undefined : err);
  process.exit(1);
});
