import {
  AudioPlayer,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('voice');

/** How long we wait for Discord to finish the voice handshake. */
const READY_TIMEOUT_MS = 20_000;
/** After an unexpected disconnect, how long we give Discord to start reconnecting. */
const RECONNECT_GRACE_MS = 5_000;

export interface GuildVoiceSession {
  guildId: string;
  channelId: string;
  channelName: string;
  joinedAt: Date;
  joinedBy: string;
  connection: VoiceConnection;
  /**
   * One player per guild. Phase 4 feeds the browser's Opus stream into it.
   * Keeping a single player guarantees we never play two streams at once.
   */
  player: AudioPlayer;
}

export interface VoiceStatus {
  channelId: string;
  channelName: string;
  connection: VoiceConnectionStatus;
  player: AudioPlayerStatus;
  joinedAt: Date;
  joinedBy: string;
}

/**
 * Owns the bot's voice connections. All join/leave logic lives here so slash
 * commands and (later) the extension's WebSocket API share one source of truth.
 */
export class VoiceManager {
  private readonly sessions = new Map<string, GuildVoiceSession>();

  /** Joins (or moves to) the given voice channel and waits until the connection is ready. */
  async join(channel: VoiceBasedChannel, requestedBy: string): Promise<GuildVoiceSession> {
    const guildId = channel.guild.id;
    const existing = this.sessions.get(guildId);

    if (existing && existing.channelId === channel.id &&
        existing.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      return existing;
    }

    // joinVoiceChannel reuses an existing connection for the guild and just moves it,
    // so there is never more than one connection per guild.
    const connection = joinVoiceChannel({
      guildId,
      channelId: channel.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true, // the bot never needs to hear anyone
      selfMute: false,
    });

    let session: GuildVoiceSession;
    if (existing && existing.connection === connection) {
      // Same connection, just moved to another channel.
      session = existing;
      session.channelId = channel.id;
      session.channelName = channel.name;
      session.joinedBy = requestedBy;
    } else {
      const player = createAudioPlayer({
        // Short network stalls are bridged by the jitter buffer (silence is sent);
        // after 1 s with no audio the player stops and the bot stops "speaking".
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 50 },
      });
      player.on('error', (err) => log.error(`Audio player error in guild ${guildId}`, err));
      player.on('stateChange', (o, n) => {
        if (o.status !== n.status) log.debug(`player ${guildId}: ${o.status} -> ${n.status}`);
      });
      session = {
        guildId,
        channelId: channel.id,
        channelName: channel.name,
        joinedAt: new Date(),
        joinedBy: requestedBy,
        connection,
        player,
      };
      this.attachConnectionHandlers(session);
      connection.subscribe(player);
      this.sessions.set(guildId, session);
    }

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    } catch (err) {
      log.error(`Voice connection to #${channel.name} did not become ready`, err);
      this.leave(guildId);
      throw new Error(
        'Could not connect to the voice channel within 20 seconds. ' +
          'Check that the bot has the Connect and Speak permissions there.',
      );
    }
    log.info(`Joined voice channel #${channel.name} (${channel.id}) in guild ${guildId}`);
    return session;
  }

  /** Leaves the voice channel in this guild. Returns false if the bot was not connected. */
  leave(guildId: string): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    session.player.stop(true);
    if (session.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      session.connection.destroy();
    }
    this.sessions.delete(guildId);
    log.info(`Left voice in guild ${guildId}`);
    return true;
  }

  /** Stops whatever is playing but stays in the channel. Returns false if nothing was playing. */
  stopPlayback(guildId: string): boolean {
    const session = this.sessions.get(guildId);
    if (!session) return false;
    if (session.player.state.status === AudioPlayerStatus.Idle) return false;
    return session.player.stop(true);
  }

  getSession(guildId: string): GuildVoiceSession | undefined {
    return this.sessions.get(guildId);
  }

  getStatus(guildId: string): VoiceStatus | undefined {
    const s = this.sessions.get(guildId);
    if (!s) return undefined;
    return {
      channelId: s.channelId,
      channelName: s.channelName,
      connection: s.connection.state.status,
      player: s.player.state.status,
      joinedAt: s.joinedAt,
      joinedBy: s.joinedBy,
    };
  }

  /** Called on shutdown. */
  leaveAll(): void {
    for (const guildId of [...this.sessions.keys()]) this.leave(guildId);
  }

  private attachConnectionHandlers(session: GuildVoiceSession): void {
    const { connection, guildId } = session;

    connection.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        log.debug(`connection ${guildId}: ${oldState.status} -> ${newState.status}`);
      }
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      // Recommended pattern from the discord.js voice guide: a disconnect is either a
      // channel move / region change (Discord reconnects us by itself, so we see
      // Signalling or Connecting quickly) or a real kick/channel deletion (it doesn't).
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_GRACE_MS),
          entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_GRACE_MS),
        ]);
        log.info(`Voice connection in guild ${guildId} is reconnecting`);
      } catch {
        log.warn(`Voice connection in guild ${guildId} was lost (kicked or channel removed)`);
        if (this.sessions.get(guildId)?.connection === connection) this.leave(guildId);
        else if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      if (this.sessions.get(guildId)?.connection === connection) {
        session.player.stop(true);
        this.sessions.delete(guildId);
      }
    });

    connection.on('error', (err) => log.error(`Voice connection error in guild ${guildId}`, err));
  }
}
