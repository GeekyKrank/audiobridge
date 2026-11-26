import { AudioPlayerStatus, createAudioResource, StreamType, type AudioResource } from '@discordjs/voice';
import type { Client, VoiceBasedChannel } from 'discord.js';
import { OpusJitterStream } from '../audio/jitter.js';
import type { Config } from '../config/env.js';
import type { VoiceManager } from '../discord/voice.js';
import { createLogger } from '../util/logger.js';
import { SinkError, type AudioSink, type StreamStartRequest } from './types.js';

const log = createLogger('discord-sink');
const FRAME_MS = 20;

/**
 * Plays the incoming Opus packets in the bot's voice channel without transcoding:
 * packets -> OpusJitterStream -> AudioResource(StreamType.Opus) -> AudioPlayer.
 */
export class DiscordSink implements AudioSink {
  readonly name = 'discord';
  private pipe: OpusJitterStream | null = null;
  private resource: AudioResource | null = null;
  private targetFrames = 20;
  private maxFrames = 75;
  private droppedTotal = 0;
  private underrunsTotal = 0;

  constructor(
    private readonly client: Client,
    private readonly voice: VoiceManager,
    private readonly config: Config,
  ) {}

  private get guildId() {
    return this.config.discordGuildId;
  }

  async begin(req: StreamStartRequest) {
    this.targetFrames = Math.max(5, Math.round(req.bufferMs / FRAME_MS));
    this.maxFrames = Math.max(this.targetFrames + 10, Math.round(this.config.maxBufferMs / FRAME_MS));
    this.closePipe();

    if (!this.client.isReady()) throw new SinkError('BOT_OFFLINE', 'The Discord bot is not connected yet.');
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new SinkError('NO_GUILD', 'The bot is not in the configured Discord server.');

    const current = this.voice.getSession(this.guildId);
    let channel: VoiceBasedChannel | null = null;

    const pick = (id: string | null | undefined) => {
      if (!id) return null;
      const ch = guild.channels.cache.get(id);
      return ch?.isVoiceBased() ? ch : null;
    };

    if (req.channelId) {
      channel = pick(req.channelId);
      if (!channel) throw new SinkError('BAD_CHANNEL', 'That voice channel does not exist.');
    } else if (current) {
      channel = pick(current.channelId);
    }
    channel ??= pick(this.config.defaultVoiceChannelId);
    if (!channel) {
      // Fall back to the voice channel an allowed user is sitting in.
      for (const [, state] of guild.voiceStates.cache) {
        if (!state.channel || state.member?.user.bot) continue;
        if (this.config.allowedUserIds.size === 0 || this.config.allowedUserIds.has(state.id)) {
          channel = state.channel;
          break;
        }
      }
    }
    if (!channel) {
      throw new SinkError('NO_CHANNEL', 'Pick a voice channel in the extension, or join one in Discord first.');
    }

    await this.voice.join(channel, this.client.user.id);
    return { channel: { id: channel.id, name: channel.name } };
  }

  packet(opus: Buffer): void {
    const session = this.voice.getSession(this.guildId);
    // Not in voice (e.g. someone disconnected the bot): drop audio until /join or the
    // extension's Join button. We deliberately don't force our way back in.
    if (!session) return;

    const player = session.player;
    const stale =
      !this.pipe ||
      this.pipe.destroyed ||
      player.state.status === AudioPlayerStatus.Idle ||
      player.state.resource !== this.resource;

    if (stale) {
      this.closePipe();
      this.pipe = new OpusJitterStream({ targetFrames: this.targetFrames, maxFrames: this.maxFrames });
      this.resource = createAudioResource(this.pipe, {
        inputType: StreamType.Opus,
        silencePaddingFrames: 5,
      });
      player.play(this.resource);
      log.debug(`New playback pipe (buffer ${this.targetFrames * FRAME_MS} ms)`);
    }
    this.pipe!.enqueue(opus);
  }

  silence(): void {
    this.closePipe();
  }

  async end(reason: string): Promise<void> {
    this.closePipe();
    this.voice.getSession(this.guildId)?.player.stop(true);
    if (this.config.leaveOnStop && reason !== 'replaced') this.voice.leave(this.guildId);
  }

  stats() {
    const player = this.voice.getSession(this.guildId)?.player;
    const p = this.pipe && !this.pipe.destroyed ? this.pipe : null;
    return {
      bufferMs: (p?.bufferedFrames ?? 0) * FRAME_MS,
      packetsDropped: this.droppedTotal + (p?.dropped ?? 0),
      underruns: this.underrunsTotal + (p?.underruns ?? 0),
      playing: player?.state.status === AudioPlayerStatus.Playing,
    };
  }

  private closePipe(): void {
    if (this.pipe) {
      this.droppedTotal += this.pipe.dropped;
      this.underrunsTotal += this.pipe.underruns;
      if (!this.pipe.destroyed) this.pipe.destroy();
    }
    this.pipe = null;
    this.resource = null;
  }

}
