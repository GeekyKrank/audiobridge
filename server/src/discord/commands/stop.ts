import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';

export const stop: Command = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop the current audio stream but stay in the channel'),

  async execute(interaction, { voice }) {
    if (!voice.getSession(interaction.guildId)) {
      await interaction.reply({ content: "I'm not in a voice channel.", flags: MessageFlags.Ephemeral });
      return;
    }
    const stopped = voice.stopPlayback(interaction.guildId);
    await interaction.reply(
      stopped
        ? { content: '⏹️ Stopped the audio stream.' }
        : { content: 'Nothing is playing right now.', flags: MessageFlags.Ephemeral },
    );
  },
};
