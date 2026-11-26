import { EmbedBuilder, MessageFlags, SlashCommandBuilder, time, TimestampStyles } from 'discord.js';
import type { Command } from './types.js';

export const status: Command = {
  data: new SlashCommandBuilder().setName('status').setDescription('Show the current SoundBridge session'),

  async execute(interaction, { voice, hub }) {
    const v = voice.getStatus(interaction.guildId);
    const st = hub.status();
    const embed = new EmbedBuilder().setTitle('SoundBridge status').setColor(0x7c5cff);

    embed.addFields({
      name: 'Voice',
      value: v ? `<#${v.channelId}> — connection \`${v.connection}\`, player \`${v.player}\`` : 'Not in a voice channel. Use `/join`.',
    });

    if (st.active && st.source) {
      const s = st.stats;
      embed.addFields(
        { name: 'Sharing', value: `**${st.source.title || 'Untitled tab'}**\n${st.source.site}` },
        { name: 'State', value: st.audible ? '▶️ playing' : '⏸️ silent / paused', inline: true },
        { name: 'Since', value: st.since ? time(new Date(st.since), TimestampStyles.RelativeTime) : '—', inline: true },
      );
      if (s) {
        embed.addFields({
          name: 'Stream',
          value: `${s.kbps} kbit/s · buffer ${s.bufferMs} ms · ${s.packetsDropped} dropped · ${s.underruns} stalls`,
        });
      }
    } else {
      embed.addFields({ name: 'Sharing', value: 'No browser tab is being shared.' });
    }
    if (v) embed.setTimestamp(v.joinedAt);

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
