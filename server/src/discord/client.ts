import { Client, Events, GatewayIntentBits, MessageFlags, type VoiceState } from 'discord.js';
import { createLogger } from '../util/logger.js';
import { commandMap, type CommandContext } from './commands/index.js';

const log = createLogger('discord');

/** Leave a voice channel after it has had no humans in it for this long. */
const EMPTY_CHANNEL_TIMEOUT_MS = 60_000;

export function createDiscordClient(ctx: CommandContext): Client {
  const client = new Client({
    // Guilds: slash commands + channel cache. GuildVoiceStates: required for voice
    // connections and for finding the user's current channel. No privileged intents.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  client.once(Events.ClientReady, (c) => {
    log.info(`Logged in as ${c.user.tag}`);
    const guild = c.guilds.cache.get(ctx.config.discordGuildId);
    if (!guild) {
      log.warn(
        `The bot is not in guild ${ctx.config.discordGuildId}. Invite it with the URL in docs/setup.md.`,
      );
    } else {
      log.info(`Serving guild "${guild.name}"`);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (!interaction.inCachedGuild() || interaction.guildId !== ctx.config.discordGuildId) {
      await interaction
        .reply({ content: 'SoundBridge only works in its configured server.', flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
      return;
    }

    const { allowedUserIds } = ctx.config;
    if (allowedUserIds.size > 0 && !allowedUserIds.has(interaction.user.id)) {
      log.warn(`Denied /${interaction.commandName} from ${interaction.user.tag} (${interaction.user.id})`);
      await interaction.reply({
        content: "You're not allowed to control SoundBridge.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const command = commandMap.get(interaction.commandName);
    if (!command) {
      await interaction.reply({
        content: 'Unknown command. Re-run `npm run deploy-commands`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    log.info(`/${interaction.commandName} by ${interaction.user.tag}`);
    try {
      await command.execute(interaction, ctx);
    } catch (err) {
      log.error(`/${interaction.commandName} failed`, err);
      const payload = { content: '❌ Something went wrong. Check the server logs.' };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => undefined);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      }
    }
  });

  // Auto-leave when everyone else has left the bot's channel.
  const emptyTimers = new Map<string, NodeJS.Timeout>();
  client.on(Events.VoiceStateUpdate, (oldState: VoiceState, newState: VoiceState) => {
    const guildId = newState.guild.id;
    const session = ctx.voice.getSession(guildId);
    if (!session) return;

    // Someone dragged the bot to another channel: keep the session info accurate.
    if (newState.id === client.user?.id && newState.channel && newState.channelId !== session.channelId) {
      session.channelId = newState.channel.id;
      session.channelName = newState.channel.name;
      log.info(`Moved to #${newState.channel.name}`);
    }

    if (oldState.channelId !== session.channelId && newState.channelId !== session.channelId) return;

    const channel = newState.guild.channels.cache.get(session.channelId);
    const humans = channel?.isVoiceBased() ? channel.members.filter((m) => !m.user.bot).size : 0;

    const pending = emptyTimers.get(guildId);
    if (humans > 0) {
      if (pending) {
        clearTimeout(pending);
        emptyTimers.delete(guildId);
      }
      return;
    }
    if (pending) return;
    emptyTimers.set(
      guildId,
      setTimeout(() => {
        emptyTimers.delete(guildId);
        const current = ctx.voice.getSession(guildId);
        const ch = current && newState.guild.channels.cache.get(current.channelId);
        const stillEmpty = ch?.isVoiceBased() ? ch.members.filter((m) => !m.user.bot).size === 0 : true;
        if (current && stillEmpty) {
          log.info(`Channel #${current.channelName} is empty, leaving`);
          ctx.voice.leave(guildId);
        }
      }, EMPTY_CHANNEL_TIMEOUT_MS),
    );
  });

  client.on(Events.Error, (err) => log.error('Discord client error', err));
  client.on(Events.Warn, (msg) => log.warn(msg));

  return client;
}
