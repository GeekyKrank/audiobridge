import type { Client } from 'discord.js';
import type { Config } from '../config/env.js';
import type { BotControl } from '../net/server.js';
import { SinkError } from '../stream/types.js';
import type { VoiceManager } from './voice.js';

/** Exposes the bot to the HTTP API used by the extension popup. */
export function createBotControl(client: Client, voice: VoiceManager, config: Config): BotControl {
  const guild = () => client.guilds.cache.get(config.discordGuildId) ?? null;

  return {
    info() {
      const g = guild();
      return {
        ready: client.isReady(),
        tag: client.user?.tag ?? null,
        guild: g ? { id: g.id, name: g.name } : null,
      };
    },
    voice() {
      const s = voice.getStatus(config.discordGuildId);
      return s
        ? { channelId: s.channelId, channelName: s.channelName, connection: s.connection, player: s.player }
        : null;
    },
    channels() {
      const g = guild();
      if (!g) return [];
      const me = g.members.me;
      return [...g.channels.cache.values()]
        .filter((c) => c.isVoiceBased())
        .filter((c) => !me || c.permissionsFor(me).has(['ViewChannel', 'Connect', 'Speak']))
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map((c) => ({ id: c.id, name: c.name, members: c.members.filter((m) => !m.user.bot).size }));
    },
    async join(channelId) {
      const g = guild();
      if (!client.isReady() || !g) throw new SinkError('BOT_OFFLINE', 'The Discord bot is not ready.');
      const ch = g.channels.cache.get(channelId);
      if (!ch?.isVoiceBased()) throw new SinkError('BAD_CHANNEL', 'That voice channel does not exist.');
      if (!ch.joinable) throw new SinkError('NO_PERMISSION', `Can't join #${ch.name} (permissions or full).`);
      await voice.join(ch, client.user.id);
      return { id: ch.id, name: ch.name };
    },
    leave() {
      return voice.leave(config.discordGuildId);
    },
  };
}
