import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from './types.js';

export const help: Command = {
  data: new SlashCommandBuilder().setName('help').setDescription('List SoundBridge commands'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('SoundBridge commands')
      .setColor(0x7c5cff)
      .setDescription(
        [
          '`/join [channel]` — join your voice channel (or the one given)',
          '`/leave` — leave the voice channel',
          '`/stop` — stop the current audio stream, stay connected',
          '`/status` — show the current session',
          '`/help` — this list',
          '',
          'The SoundBridge Chrome extension is the main control: pick a tab, press **Share Audio**.',
        ].join('\n'),
      );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
