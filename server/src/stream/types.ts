import type { SourceInfo } from '@soundbridge/shared';

export interface StreamStartRequest {
  channelId?: string;
  bufferMs: number;
  source: SourceInfo;
}

export interface SinkStats {
  bufferMs: number;
  packetsDropped: number;
  underruns: number;
  playing: boolean;
}

/** Something that consumes the incoming Opus stream (Discord voice, a recorder, ...). */
export interface AudioSink {
  readonly name: string;
  /** Prepare for a new stream. May throw a SinkError to refuse it. */
  begin(req: StreamStartRequest): Promise<{ channel?: { id: string; name: string } }>;
  /** One 20 ms Opus packet. Must be cheap: called 50 times per second. */
  packet(opus: Buffer): void;
  /** The source went silent (paused) or the connection dropped: stop sounding now. */
  silence(): void;
  /** The stream is over. */
  end(reason: string): Promise<void>;
  stats(): SinkStats | null;
}

export class SinkError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
