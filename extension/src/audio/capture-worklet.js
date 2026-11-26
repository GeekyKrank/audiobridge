// Runs on the audio rendering thread. Collects exactly 20 ms (960 frames) of
// stereo PCM, computes its loudness, and hands it to the main thread.
// Batching to 20 ms means 50 messages/s instead of 375 (one per 128-frame quantum).

const FRAMES = 960;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(FRAMES * 2); // planar: [L x 960][R x 960]
    this.pos = 0;
    this.sumSq = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const left = input && input[0];
    const right = (input && input[1]) || left;
    const n = left ? left.length : 128;
    let i = 0;
    while (i < n) {
      const take = Math.min(n - i, FRAMES - this.pos);
      for (let k = 0; k < take; k++) {
        const l = left ? left[i + k] : 0;
        const r = right ? right[i + k] : 0;
        this.buf[this.pos + k] = l;
        this.buf[FRAMES + this.pos + k] = r;
        this.sumSq += l * l + r * r;
      }
      this.pos += take;
      i += take;
      if (this.pos === FRAMES) {
        const rms = Math.sqrt(this.sumSq / (FRAMES * 2));
        this.port.postMessage({ pcm: this.buf, rms }, [this.buf.buffer]);
        this.buf = new Float32Array(FRAMES * 2);
        this.pos = 0;
        this.sumSq = 0;
      }
    }
    return true;
  }
}

registerProcessor('sb-capture', CaptureProcessor);
