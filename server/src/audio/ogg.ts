import { createWriteStream, type WriteStream } from 'node:fs';

// Minimal Ogg Opus muxer (RFC 7845) so a stream can be saved and played back with
// any media player. Used for debugging/recording only; the Discord path doesn't need it.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(buf: Buffer): number {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]!) & 0xff]!) >>> 0;
  return crc >>> 0;
}

export class OggOpusWriter {
  private readonly out: WriteStream;
  private readonly serial = (Math.random() * 0xffffffff) >>> 0;
  private seq = 0;
  private granule = 0n;
  private closed = false;
  packets = 0;

  constructor(readonly path: string, channels = 2, private readonly samplesPerPacket = 960) {
    this.out = createWriteStream(path);
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'ascii');
    head[8] = 1; // version
    head[9] = channels;
    head.writeUInt16LE(312, 10); // pre-skip (typical encoder delay at 48 kHz)
    head.writeUInt32LE(48000, 12); // original input sample rate
    head.writeInt16LE(0, 16); // output gain
    head[18] = 0; // channel mapping family 0 (mono/stereo)
    this.writePage([head], 0x02, 0n);

    const vendor = Buffer.from('SoundBridge');
    const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write('OpusTags', 0, 'ascii');
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendor.length);
    this.writePage([tags], 0x00, 0n);
  }

  /** Writes one Opus packet (each in its own page: simple, and fine for debugging). */
  write(packet: Buffer): void {
    if (this.closed) return;
    this.granule += BigInt(this.samplesPerPacket);
    this.writePage([packet], 0x00, this.granule);
    this.packets++;
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    // End-of-stream page with no packets.
    this.writePage([], 0x04, this.granule);
    return new Promise((resolve) => this.out.end(resolve));
  }

  private writePage(packets: Buffer[], headerType: number, granule: bigint): void {
    const lacing: number[] = [];
    for (const p of packets) {
      let n = p.length;
      while (n >= 255) {
        lacing.push(255);
        n -= 255;
      }
      lacing.push(n);
    }
    const header = Buffer.alloc(27 + lacing.length);
    header.write('OggS', 0, 'ascii');
    header[4] = 0;
    header[5] = headerType;
    header.writeBigUInt64LE(granule, 6);
    header.writeUInt32LE(this.serial, 14);
    header.writeUInt32LE(this.seq++, 18);
    header.writeUInt32LE(0, 22); // CRC placeholder
    header[26] = lacing.length;
    lacing.forEach((v, i) => (header[27 + i] = v));
    const page = Buffer.concat([header, ...packets]);
    page.writeUInt32LE(oggCrc(page), 22);
    this.out.write(page);
  }
}
