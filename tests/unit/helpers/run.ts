// Drive the analysis pipeline over a synthetic signal exactly like the engine does:
// every `hopMs` take the newest `analysisLength` samples (zero-padded before t = 0).

import { TunerPipeline, type PipelineOptions } from '../../../src/audio/pipeline.ts';
import type { TunerFrame } from '../../../src/audio/types.ts';

export function runPipeline(
  signal: Float32Array,
  sampleRate: number,
  hopMs = 1000 / 60,
  opts?: PipelineOptions,
): TunerFrame[] {
  const p = new TunerPipeline(sampleRate, opts);
  const L = p.analysisLength;
  const buf = new Float32Array(L);
  const frames: TunerFrame[] = [];
  for (let t = hopMs; ; t += hopMs) {
    const end = Math.round((t / 1000) * sampleRate);
    if (end > signal.length) break;
    const start = end - L;
    if (start >= 0) buf.set(signal.subarray(start, end));
    else {
      buf.fill(0, 0, -start);
      buf.set(signal.subarray(0, end), -start);
    }
    frames.push(p.process(buf, t));
  }
  return frames;
}

export interface NoteMetrics {
  /** ms from onset to the first `detected` frame showing the right note (−1 = never). */
  latencyMs: number;
  /** Max |cents error| vs the true f0 over `detected` frames from onset + settleMs. */
  maxErrCents: number;
  /** Frames (detected or holding) whose reading is not the expected MIDI note. */
  wrongNoteFrames: number;
  /** Number of `detected` frames used for maxErrCents. */
  sustainFrames: number;
}

/** Score frames of a single-note signal (true fundamental f0, onset at onsetMs). */
export function scoreNote(
  frames: TunerFrame[],
  f0: number,
  midi: number,
  onsetMs: number,
  settleMs = 100,
  untilMs = Infinity,
): NoteMetrics {
  let latencyMs = -1;
  let maxErrCents = 0;
  let wrongNoteFrames = 0;
  let sustainFrames = 0;
  for (const fr of frames) {
    if (fr.time < onsetMs || fr.time >= untilMs || !fr.reading) continue;
    const exact = 69 + 12 * Math.log2(fr.reading.frequency / 440);
    const ok = Math.round(exact) === midi;
    if (!ok) wrongNoteFrames++;
    if (fr.status !== 'detected') continue;
    if (ok && latencyMs < 0) latencyMs = fr.time - onsetMs;
    if (fr.time >= onsetMs + settleMs) {
      sustainFrames++;
      maxErrCents = Math.max(maxErrCents, Math.abs(1200 * Math.log2(fr.reading.frequency / f0)));
    }
  }
  return { latencyMs, maxErrCents, wrongNoteFrames, sustainFrames };
}
