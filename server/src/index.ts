import { loadConfig } from './config/env.js';
import { createDiscordClient } from './discord/client.js';
import { createBotControl } from './discord/control.js';
import { VoiceManager } from './discord/voice.js';
import { createAppServer, NO_BOT, type BotControl } from './net/server.js';
import { DiscordSink } from './stream/discord-sink.js';
import { StreamHub } from './stream/hub.js';
import { RecorderSink } from './stream/recorder-sink.js';
import type { AudioSink } from './stream/types.js';
import { createLogger, setLogLevel } from './util/logger.js';
import { SERVER_VERSION } from './util/version.js';

const log = createLogger('main');

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  log.info(`SoundBridge server ${SERVER_VERSION} starting`);

  const sinks: AudioSink[] = [];
  const voice = new VoiceManager();
  let bot: BotControl = NO_BOT;
  let client: ReturnType<typeof createDiscordClient> | null = null;
  const hub = new StreamHub(sinks);

  if (config.discordEnabled) {
    client = createDiscordClient({ config, voice, hub });
    sinks.push(new DiscordSink(client, voice, config));
    bot = createBotControl(client, voice, config);
  } else {
    log.warn('DISCORD_ENABLED=false: running without the Discord bot (local test mode)');
  }
  if (config.recordDir) sinks.push(new RecorderSink(config.recordDir));
  if (sinks.length === 0) log.warn('No audio sinks: incoming audio will be discarded');

  const app = createAppServer(config, hub, bot);
  await app.listen();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    await hub.shutdown();
    await app.close();
    voice.leaveAll();
    await client?.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection', reason));

  if (client) await client.login(config.discordToken);
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : 'Fatal error', err instanceof Error ? undefined : err);
  process.exit(1);
});
