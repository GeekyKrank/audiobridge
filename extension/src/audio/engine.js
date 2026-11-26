// Tab MediaStream -> (speakers) + (AudioWorklet -> WebCodecs Opus encoder) -> packets.
// Works in the offscreen document and in a normal page (used by the e2e test).

import { AUDIO } from '../lib/protocol.js';

/** Below this RMS (~ -70 dBFS) a 20 ms frame counts as silence. */
const SILENCE_RMS = 0.0003;
/** If the encoder falls behind this much (CPU starved, e.g. during a game), drop input. */
const MAX_ENCODE_QUEUE = 10;

export class AudioEngine {
  /**
   * @param {{ workletUrl: string, bitrate: number, monitor: boolean, monitorVolume: number, silenceHoldMs: number }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.ctx = null;
    this.encoder = null;
    this.stream = null;
    this.monitorGain = null;
    this.audible = true;
    this.silentRun = 0;
    this.timestampUs = 0;
    this.silentByTs = new Map();
    this.running = false;
    this.stats = { framesIn: 0, packetsOut: 0, encoderDrops: 0, level: 0, codec: '' };
    /** @type {(data: Uint8Array, silent: boolean) => void} */
    this.onPacket = () => {};
    /** @type {(audible: boolean) => void} */
    this.onAudibleChange = () => {};
    /** @type {() => void} */
    this.onEnded = () => {};
    /** @type {(err: Error) => void} */
    this.onError = () => {};
  }

  static isSupported() {
    return typeof AudioEncoder !== 'undefined' && typeof AudioWorkletNode !== 'undefined';
  }

  /** @param {MediaStream} stream */
  async start(stream) {
    if (!AudioEngine.isSupported()) throw new Error('This browser lacks WebCodecs AudioEncoder or AudioWorklet.');
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('The captured stream has no audio track.');
    track.addEventListener('ended', () => this.onEnded());

    // Force 48 kHz: the AudioContext resamples 44.1 kHz sources for us, so the
    // encoder always gets exactly Discord's format.
    const ctx = new AudioContext({ sampleRate: AUDIO.sampleRate, latencyHint: 'playback' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(this.opts.workletUrl);

    const source = ctx.createMediaStreamSource(stream);

    // Local monitoring: tabCapture mutes the tab, so we play it back ourselves.
    this.monitorGain = ctx.createGain();
    this.setMonitor(this.opts.monitor, this.opts.monitorVolume);
    source.connect(this.monitorGain).connect(ctx.destination);

    // Capture branch. Connected to the destination through a muted gain so the
    // graph pulls it; it adds no sound.
    const node = new AudioWorkletNode(ctx, 'sb-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: AUDIO.channels,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node).connect(mute).connect(ctx.destination);
    node.port.onmessage = (e) => this.onFrame(e.data);
    this.node = node;

    this.encoder = new AudioEncoder({
      output: (chunk) => this.onChunk(chunk),
      error: (err) => this.onError(err instanceof Error ? err : new Error(String(err))),
    });
    this.encoder.configure(await this.pickConfig());

    if (ctx.state === 'suspended') await ctx.resume();
    this.running = true;
  }

  async pickConfig() {
    const base = {
      codec: 'opus',
      sampleRate: AUDIO.sampleRate,
      numberOfChannels: AUDIO.channels,
      bitrate: this.opts.bitrate,
    };
    const candidates = [
      { ...base, opus: { frameDuration: AUDIO.frameDurationMs * 1000, application: 'audio', signal: 'music' } },
      { ...base, opus: { frameDuration: AUDIO.frameDurationMs * 1000 } },
    ];
    for (const c of candidates) {
      const r = await AudioEncoder.isConfigSupported(c);
      if (r.supported) {
        this.stats.codec = `opus ${Math.round(c.bitrate / 1000)}k`;
        return r.config ?? c;
      }
    }
    throw new Error('This browser cannot encode Opus with WebCodecs.');
  }

  setMonitor(enabled, volume) {
    if (!this.monitorGain) return;
    const v = enabled ? Math.max(0, Math.min(1, Number(volume) || 0)) : 0;
    this.monitorGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** @param {{ pcm: Float32Array, rms: number }} frame */
  onFrame({ pcm, rms }) {
    if (!this.running || !this.encoder || this.encoder.state !== 'configured') return;
    this.stats.framesIn++;
    this.stats.level = rms;
    const silent = rms < SILENCE_RMS;

    // Pause detection: after a stretch of silence, stop sending until sound returns.
    if (silent) {
      this.silentRun++;
      if (this.audible && this.silentRun * AUDIO.frameDurationMs >= this.opts.silenceHoldMs) {
        this.audible = false;
        this.onAudibleChange(false);
      }
    } else {
      this.silentRun = 0;
      if (!this.audible) {
        this.audible = true;
        this.onAudibleChange(true);
      }
    }

    const ts = this.timestampUs;
    this.timestampUs += AUDIO.frameDurationMs * 1000;
    if (this.encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
      this.stats.encoderDrops++;
      return;
    }
    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: AUDIO.sampleRate,
      numberOfFrames: AUDIO.frameSamples,
      numberOfChannels: AUDIO.channels,
      timestamp: ts,
      data: pcm,
    });
    this.silentByTs.set(ts, silent);
    try {
      this.encoder.encode(data);
    } finally {
      data.close();
    }
    if (this.silentByTs.size > 200) this.silentByTs.clear();
  }

  /** @param {EncodedAudioChunk} chunk */
  onChunk(chunk) {
    const silent = this.silentByTs.get(chunk.timestamp) ?? false;
    this.silentByTs.delete(chunk.timestamp);
    if (!this.audible) return; // paused: withhold packets entirely
    const buf = new Uint8Array(chunk.byteLength);
    chunk.copyTo(buf);
    this.stats.packetsOut++;
    this.onPacket(buf, silent);
  }

  async stop() {
    this.running = false;
    try {
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    } catch {}
    if (this.node) this.node.port.onmessage = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close();
    this.encoder = null;
    this.ctx = null;
    this.stream = null;
  }
}
