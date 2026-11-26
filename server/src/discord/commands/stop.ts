import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';

export const stop: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop the browser audio stream but stay in the channel'),

  async execute(interaction, { voice, hub }) {
    const hadStream = await hub.forceStop(`/stop by ${interaction.user.tag}`);
    const hadAudio = voice.stopPlayback(interaction.guildId);
    await interaction.reply(
      hadStream || hadAudio
        ? { content: '⏹️ Stopped the audio stream. Press **Share Audio** in the extension to start again.' }
        : { content: 'Nothing is streaming right now.', flags: MessageFlags.Ephemeral },
    );
  },
};
