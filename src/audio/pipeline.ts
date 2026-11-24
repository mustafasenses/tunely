// Per-frame analysis pipeline (pure; no Web Audio). The engine feeds it the newest samples at
// ~60 Hz; tests drive it with synthetic audio exactly the same way.

import type { TunerFrame } from './types.ts';
import { analysisLength, baseWindowSize, detectPitch, type DetectOptions } from './detect.ts';
import { PitchStabilizer, type StabilizerOptions } from './stabilizer.ts';
import { dbToLevel, rmsOf, rmsToDb } from './level.ts';

export interface PipelineOptions {
  detect?: DetectOptions;
  stabilizer?: Partial<StabilizerOptions>;
  /** Keep ignoring input this long after unmuting (reference-tone tail / room echo). */
  unmuteGuardMs?: number;
  /** Level-meter release time constant (attack is instant). */
  levelReleaseMs?: number;
}

export class TunerPipeline {
  readonly sampleRate: number;
  /** Number of newest samples `process` expects. */
  readonly analysisLength: number;
  readonly stabilizer: PitchStabilizer;
  private readonly baseWindow: number;
  private readonly opts: PipelineOptions;
  private muted = false;
  private ignoreUntil = -Infinity;
  private level = 0;
  private lastTime: number | null = null;

  constructor(sampleRate: number, opts: PipelineOptions = {}) {
    this.sampleRate = sampleRate;
    this.opts = opts;
    this.analysisLength = analysisLength(sampleRate);
    this.baseWindow = baseWindowSize(sampleRate);
    this.stabilizer = new PitchStabilizer(opts.stabilizer);
  }

  setMuted(muted: boolean, time: number): void {
    if (this.muted && !muted) this.ignoreUntil = time + (this.opts.unmuteGuardMs ?? 250);
    this.muted = muted;
  }

  reset(): void {
    this.stabilizer.reset();
    this.level = 0;
    this.lastTime = null;
  }

  /** `samples`: the newest audio, most recent sample last (ideally `analysisLength` long). */
  process(samples: Float32Array, time: number): TunerFrame {
    const dt = this.lastTime === null ? 0 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    const ignore = this.muted || time < this.ignoreUntil;

    // Level over the newest ~43 ms (same span as the shortest detection window).
    const rms = ignore ? 0 : rmsOf(samples, this.baseWindow);
    const db = rmsToDb(rms);
    const target = dbToLevel(db);
    if (target >= this.level) this.level = target;
    else this.level += (target - this.level) * (1 - Math.exp(-dt / (this.opts.levelReleaseMs ?? 250)));

    const detection =
      ignore || this.stabilizer.isBelowGate(db) ? null : detectPitch(samples, this.sampleRate, this.opts.detect);
    const out = this.stabilizer.push({ time, rms, detection });
    return { status: out.status, reading: out.reading, level: this.level, time };
  }
}
