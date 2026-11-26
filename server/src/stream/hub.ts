import { CLOSE, type ServerStats, type SourceInfo } from '@soundbridge/shared';
import { createLogger } from '../util/logger.js';
import { SinkError, type AudioSink, type StreamStartRequest } from './types.js';

const log = createLogger('hub');

/** How long a stream survives its WebSocket dropping, waiting for the extension to reconnect. */
export const RECONNECT_GRACE_MS = 15_000;

export interface StreamOwner {
  id: string;
  clientId: string;
  /** Close this owner's connection (e.g. when another session replaces it). */
  close(code: number, reason: string): void;
}

interface ActiveStream {
  owner: StreamOwner | null;
  clientId: string;
  since: Date;
  source: SourceInfo;
  audible: boolean;
  lastSeq: number | null;
  packetsReceived: number;
  sequenceGaps: number;
  bytesWindow: { t: number; bytes: number }[];
  graceTimer: NodeJS.Timeout | null;
}

export interface StartResult {
  channel: { id: string; name: string } | null;
  sinks: string[];
}

/**
 * Routes the single active browser stream to all sinks. Guarantees there is at
 * most one stream at a time: a new `start` replaces whatever was there before.
 */
export class StreamHub {
  private active: ActiveStream | null = null;
  private startQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly sinks: AudioSink[],
    private readonly onChange: () => void = () => undefined,
  ) {}

  get isActive(): boolean {
    return this.active !== null;
  }

  isOwner(ownerId: string): boolean {
    return this.active?.owner?.id === ownerId;
  }

  /** Starts (or takes over) the stream. Serialized so two starts can't interleave. */
  start(owner: StreamOwner, req: StreamStartRequest): Promise<StartResult> {
    const run = async (): Promise<StartResult> => {
      const prev = this.active;
      if (prev) {
        if (prev.graceTimer) clearTimeout(prev.graceTimer);
        if (prev.owner && prev.owner.id !== owner.id) {
          log.info(`Stream taken over by a new session (${owner.id})`);
          prev.owner.close(CLOSE.REPLACED, 'Replaced by a newer session');
        }
        for (const s of this.sinks) s.silence();
      }

      let channel: StartResult['channel'] = null;
      const started: string[] = [];
      for (const sink of this.sinks) {
        try {
          const r = await sink.begin(req);
          if (r.channel) channel = r.channel;
          started.push(sink.name);
        } catch (err) {
          // A sink refusing (e.g. Discord: no channel) fails the whole start.
          for (const s of this.sinks) await s.end('failed').catch(() => undefined);
          this.active = null;
          this.onChange();
          throw err instanceof SinkError ? err : new SinkError('SINK_FAILED', String(err));
        }
      }

      this.active = {
        owner,
        clientId: owner.clientId,
        since: prev?.clientId === owner.clientId ? prev.since : new Date(),
        source: req.source,
        audible: true,
        lastSeq: null,
        packetsReceived: prev?.clientId === owner.clientId ? prev.packetsReceived : 0,
        sequenceGaps: prev?.clientId === owner.clientId ? prev.sequenceGaps : 0,
        bytesWindow: [],
        graceTimer: null,
      };
      log.info(`Stream started: "${req.source.title}" (${req.source.site}) -> ${started.join(', ')}`);
      this.onChange();
      return { channel, sinks: started };
    };
    const p = this.startQueue.then(run, run);
    this.startQueue = p.catch(() => undefined);
    return p;
  }

  packet(ownerId: string, seq: number, opus: Buffer): void {
    const a = this.active;
    if (!a || a.owner?.id !== ownerId) return;
    if (a.lastSeq !== null && seq !== ((a.lastSeq + 1) & 0xffff)) a.sequenceGaps++;
    a.lastSeq = seq;
    a.packetsReceived++;
    const now = Date.now();
    a.bytesWindow.push({ t: now, bytes: opus.length });
    while (a.bytesWindow.length > 0 && now - a.bytesWindow[0]!.t > 2000) a.bytesWindow.shift();
    if (!a.audible) {
      a.audible = true;
      this.onChange();
    }
    for (const s of this.sinks) s.packet(opus);
  }

  setAudible(ownerId: string, audible: boolean): void {
    const a = this.active;
    if (!a || a.owner?.id !== ownerId || a.audible === audible) return;
    a.audible = audible;
    if (!audible) for (const s of this.sinks) s.silence();
    log.debug(`Source is now ${audible ? 'audible' : 'silent'}`);
    this.onChange();
  }

  updateSource(ownerId: string, source: SourceInfo): void {
    const a = this.active;
    if (!a || a.owner?.id !== ownerId) return;
    a.source = source;
    this.onChange();
  }

  /** The owner's socket closed. Keep the stream alive briefly so a reconnect can resume it. */
  ownerDisconnected(ownerId: string): void {
    const a = this.active;
    if (!a || a.owner?.id !== ownerId) return;
    a.owner = null;
    for (const s of this.sinks) s.silence();
    a.graceTimer = setTimeout(() => {
      if (this.active === a && !a.owner) void this.stop(null, 'disconnected');
    }, RECONNECT_GRACE_MS);
    a.graceTimer.unref();
    log.info(`Extension disconnected; waiting ${RECONNECT_GRACE_MS / 1000}s for it to reconnect`);
    this.onChange();
  }

  /** Stops the stream. With an ownerId, only if that owner holds it. */
  async stop(ownerId: string | null, reason: string): Promise<boolean> {
    const a = this.active;
    if (!a) return false;
    if (ownerId !== null && a.owner?.id !== ownerId) return false;
    if (a.graceTimer) clearTimeout(a.graceTimer);
    this.active = null;
    for (const s of this.sinks) await s.end(reason).catch((err) => log.warn(`${s.name}.end failed`, err));
    log.info(`Stream stopped (${reason})`);
    this.onChange();
    return true;
  }

  /** Stops the stream and closes its owner's connection (used by /stop and the API). */
  async forceStop(reason: string): Promise<boolean> {
    const owner = this.active?.owner;
    const stopped = await this.stop(null, reason);
    owner?.close(CLOSE.NORMAL, 'Stopped from Discord');
    return stopped;
  }

  status(): { active: boolean; since: string | null; source: SourceInfo | null; audible: boolean; stats: ServerStats | null } {
    const a = this.active;
    if (!a) return { active: false, since: null, source: null, audible: false, stats: null };
    return { active: true, since: a.since.toISOString(), source: a.source, audible: a.audible, stats: this.stats() };
  }

  stats(): ServerStats | null {
    const a = this.active;
    if (!a) return null;
    const now = Date.now();
    const recent = a.bytesWindow.filter((b) => now - b.t <= 2000);
    const bytes = recent.reduce((n, b) => n + b.bytes, 0);
    const sink = this.sinks.map((s) => s.stats()).find((s) => s !== null) ?? null;
    return {
      bufferMs: sink?.bufferMs ?? 0,
      kbps: Math.round((bytes * 8) / 2000),
      packetsReceived: a.packetsReceived,
      packetsDropped: sink?.packetsDropped ?? 0,
      underruns: sink?.underruns ?? 0,
      sequenceGaps: a.sequenceGaps,
      playing: sink?.playing ?? recent.length > 0,
    };
  }

  async shutdown(): Promise<void> {
    const owner = this.active?.owner;
    await this.stop(null, 'shutdown');
    owner?.close(CLOSE.SERVER_SHUTDOWN, 'Server shutting down');
  }
}
