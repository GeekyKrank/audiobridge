import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { OggOpusWriter } from '../audio/ogg.js';
import { createLogger } from '../util/logger.js';
import type { AudioSink } from './types.js';

const log = createLogger('recorder');

/** Writes every stream to `<dir>/soundbridge-<time>.ogg`. For debugging and the local test. */
export class RecorderSink implements AudioSink {
  readonly name = 'recorder';
  private writer: OggOpusWriter | null = null;
  lastFile: string | null = null;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async begin() {
    await this.end('restart');
    const file = join(this.dir, `soundbridge-${new Date().toISOString().replace(/[:.]/g, '-')}.ogg`);
    this.writer = new OggOpusWriter(file);
    this.lastFile = file;
    log.info(`Recording to ${file}`);
    return {};
  }

  packet(opus: Buffer): void {
    this.writer?.write(opus);
  }

  silence(): void {
    // Nothing to do: the recording simply skips silent stretches.
  }

  async end(_reason?: string): Promise<void> {
    const w = this.writer;
    this.writer = null;
    if (w) {
      await w.close();
      log.info(`Saved ${w.path} (${w.packets} packets, ${(w.packets * 0.02).toFixed(1)} s)`);
    }
  }

  stats() {
    return null;
  }
}
