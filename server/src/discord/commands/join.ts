import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type VoiceBasedChannel,
} from 'discord.js';
import type { Command } from './types.js';

export const join: Command = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join a voice channel (defaults to the one you are in)')
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Voice channel to join')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(false),
    ),

  async execute(interaction, { voice }) {
    const picked = interaction.options.getChannel('channel', false, [
      ChannelType.GuildVoice,
      ChannelType.GuildStageVoice,
    ]) as VoiceBasedChannel | null;
    const channel = picked ?? interaction.member.voice.channel;

    if (!channel) {
      await interaction.reply({
        content: 'Join a voice channel first, or pass one with `/join channel:`.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const me = interaction.guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect])) {
      await interaction.reply({
        content: `I don't have permission to connect to ${channel}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!perms.has(PermissionFlagsBits.Speak)) {
      await interaction.reply({
        content: `I can connect to ${channel} but I'm not allowed to **Speak** there.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!channel.joinable) {
      await interaction.reply({
        content: `I can't join ${channel} (it may be full).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Connecting can take a few seconds; Discord requires a reply within 3s, so defer.
    await interaction.deferReply();
    try {
      await voice.join(channel, interaction.user.id);
      await interaction.editReply(`🔊 Joined ${channel}.`);
    } catch (err) {
      await interaction.editReply(`❌ ${err instanceof Error ? err.message : 'Failed to join.'}`);
    }
  },
};
