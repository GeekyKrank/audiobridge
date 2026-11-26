import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';

export const leave: Command = {
  data: new SlashCommandBuilder().setName('leave').setDescription('Leave the voice channel'),

  async execute(interaction, { voice }) {
    const left = voice.leave(interaction.guildId);
    await interaction.reply(
      left
        ? { content: '👋 Left the voice channel.' }
        : { content: "I'm not in a voice channel.", flags: MessageFlags.Ephemeral },
    );
  },
};
