// AudioWorklet processor: forwards mono input to the main thread in ~10 ms chunks.
// Loaded by engine.ts via `?worker&url`, so Vite bundles it into a standalone script (no
// imports may be added here: AudioWorkletGlobalScope has no dynamic import and no DOM).

// AudioWorkletGlobalScope declarations (not in lib.dom).
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

const CHUNK = 512;

class TunelyCaptureProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(CHUNK);
  private fill = 0;
  private alive = true;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === 'stop') this.alive = false;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    if (channels && channels.length > 0) {
      const first = channels[0];
      const n = first.length;
      const nch = channels.length;
      for (let i = 0; i < n; i++) {
        // Average channels (the node is configured for mono, but be defensive).
        let v = first[i];
        for (let c = 1; c < nch; c++) v += channels[c][i];
        this.buf[this.fill++] = nch > 1 ? v / nch : v;
        if (this.fill === CHUNK) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(CHUNK);
          this.fill = 0;
        }
      }
    }
    return this.alive;
  }
}

registerProcessor('tunely-capture', TunelyCaptureProcessor);
