import { EmbedBuilder, MessageFlags, SlashCommandBuilder, time, TimestampStyles } from 'discord.js';
import type { Command } from './types.js';

export const status: Command = {
  data: new SlashCommandBuilder().setName('status').setDescription('Show the current SoundBridge session'),

  async execute(interaction, { voice }) {
    const s = voice.getStatus(interaction.guildId);
    const embed = new EmbedBuilder().setTitle('SoundBridge status').setColor(0x7c5cff);

    if (!s) {
      embed.setDescription('Not connected to a voice channel. Use `/join`.');
    } else {
      embed.addFields(
        { name: 'Voice channel', value: `<#${s.channelId}>`, inline: true },
        { name: 'Connection', value: s.connection, inline: true },
        { name: 'Player', value: s.player, inline: true },
        { name: 'Joined', value: `${time(s.joinedAt, TimestampStyles.RelativeTime)} by <@${s.joinedBy}>` },
      );
    }
    // Honest about what exists: the browser stream arrives in later phases.
    embed.setFooter({ text: 'Browser audio streaming: not implemented yet (Phase 3–4)' });

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
