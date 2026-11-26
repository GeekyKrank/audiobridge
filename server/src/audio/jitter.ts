import { Readable } from 'node:stream';

export interface JitterOptions {
  /** Packets to collect before playback starts (and after every underrun). */
  targetFrames: number;
  /** If more than this many packets pile up, the oldest are dropped back to target. */
  maxFrames: number;
}

/**
 * A pull-based jitter buffer that @discordjs/voice reads directly.
 *
 * The voice AudioPlayer calls `read()` once every 20 ms and expects one Opus packet
 * (or null). We override `read()` so packets come straight from our own queue,
 * which lets us (a) wait until `targetFrames` are buffered before starting,
 * (b) re-buffer after a network stall, and (c) drop old packets if the browser
 * runs slightly faster than Discord's clock, so latency never grows unbounded.
 *
 * Ending: call `destroy()`. The player notices `readable === false`, plays a few
 * silence frames and goes Idle (the bot stops "speaking").
 */
export class OpusJitterStream extends Readable {
  private readonly queue: Buffer[] = [];
  private priming = true;
  private announced = false;
  readonly opts: JitterOptions;

  dropped = 0;
  underruns = 0;
  played = 0;

  constructor(opts: JitterOptions) {
    super({ objectMode: true, highWaterMark: 1 });
    if (opts.targetFrames < 1 || opts.maxFrames <= opts.targetFrames) {
      throw new Error('JitterOptions: need 1 <= targetFrames < maxFrames');
    }
    this.opts = opts;
  }

  get bufferedFrames(): number {
    return this.queue.length;
  }

  enqueue(packet: Buffer): void {
    if (this.destroyed) return;
    this.queue.push(packet);
    if (this.queue.length > this.opts.maxFrames) {
      const excess = this.queue.length - this.opts.targetFrames;
      this.queue.splice(0, excess);
      this.dropped += excess;
    }
    if (this.priming && this.queue.length >= this.opts.targetFrames) {
      this.priming = false;
      if (!this.announced) {
        this.announced = true;
        // Tells AudioResource/AudioPlayer that playback can start (Buffering -> Playing).
        this.emit('readable');
      }
    }
  }

  override read(size?: number): Buffer | null {
    // Node internally calls read(0) to probe; never consume a packet for that.
    if (size === 0 || this.destroyed || this.priming) return null;
    const packet = this.queue.shift();
    if (!packet) {
      this.priming = true; // network stall: re-buffer before continuing
      this.underruns++;
      return null;
    }
    this.played++;
    return packet;
  }

  override _read(): void {
    // Data is delivered only through our read() override.
  }

  override _destroy(err: Error | null, cb: (error?: Error | null) => void): void {
    this.queue.length = 0;
    cb(err);
  }
}
