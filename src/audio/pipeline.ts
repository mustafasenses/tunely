// Per-frame analysis pipeline (pure; no Web Audio). The engine feeds it the newest samples at
// ~60 Hz; tests drive it with synthetic audio exactly the same way.

import type { TunerFrame } from './types.ts';
import { analysisLength, baseWindowSize, detectPitch, type DetectOptions } from './detect.ts';
import { PitchStabilizer, type StabilizerOptions } from './stabilizer.ts';
import { dbToLevel, rmsOf, rmsToDb } from './level.ts';
import { HumCanceller, type HumOptions } from './hum.ts';

export interface PipelineOptions {
  detect?: DetectOptions;
  stabilizer?: Partial<StabilizerOptions>;
  /** Keep ignoring input this long after unmuting (reference-tone tail / room echo). */
  unmuteGuardMs?: number;
  /** Level-meter release time constant (attack is instant). */
  levelReleaseMs?: number;
  /** Mains-hum canceller options (`false` disables it). */
  hum?: Partial<HumOptions> | false;
}

export class TunerPipeline {
  readonly sampleRate: number;
  /** Number of newest samples `process` expects. */
  readonly analysisLength: number;
  readonly stabilizer: PitchStabilizer;
  readonly hum: HumCanceller | null;
  private readonly baseWindow: number;
  private readonly opts: PipelineOptions;
  private muted = false;
  private ignoreUntil = -Infinity;
  private level = 0;
  private lastTime: number | null = null;
  /** Frequency of the note currently shown (fed to the hum canceller's joint fit). */
  private noteHz: number | null = null;

  constructor(sampleRate: number, opts: PipelineOptions = {}) {
    this.sampleRate = sampleRate;
    this.opts = opts;
    this.analysisLength = analysisLength(sampleRate);
    this.baseWindow = baseWindowSize(sampleRate);
    this.stabilizer = new PitchStabilizer(opts.stabilizer);
    this.hum = opts.hum === false ? null : new HumCanceller(sampleRate, opts.hum || {});
  }

  setMuted(muted: boolean, time: number): void {
    if (this.muted && !muted) this.ignoreUntil = time + (this.opts.unmuteGuardMs ?? 250);
    this.muted = muted;
  }

  /** Forget the stabiliser state (keeps the learnt hum model: the room has not changed). */
  reset(): void {
    this.stabilizer.reset();
    this.level = 0;
    this.lastTime = null;
    this.noteHz = null;
  }

  private updateLevel(db: number, time: number): void {
    const dt = this.lastTime === null ? 0 : Math.max(0, time - this.lastTime);
    this.lastTime = time;
    const target = dbToLevel(db);
    if (target >= this.level) this.level = target;
    else this.level += (target - this.level) * (1 - Math.exp(-dt / (this.opts.levelReleaseMs ?? 250)));
  }

  /**
   * A frame without fresh audio (input suspended / interrupted / muted by the OS): nothing is
   * analysed — the last reading is held, then released — and the level meter falls to 0.
   */
  idle(time: number): TunerFrame {
    this.updateLevel(-Infinity, time);
    const out = this.stabilizer.push({ time, rms: 0, detection: null, ignored: true });
    this.noteHz = out.reading ? out.reading.frequency : null;
    return { status: out.status, reading: out.reading, level: this.level, time };
  }

  /** `samples`: the newest audio, most recent sample last (ideally `analysisLength` long). */
  process(samples: Float32Array, time: number): TunerFrame {
    if (this.muted || time < this.ignoreUntil) return this.idle(time);

    // Level over the newest ~43 ms (same span as the shortest detection window); the meter
    // shows the raw input, the gate / detector see it with any learnt mains hum removed.
    const rawRms = rmsOf(samples, this.baseWindow);
    const rawDb = rmsToDb(rawRms);
    this.updateLevel(rawDb, time);
    const hum = this.hum;
    const clean = hum ? hum.clean(samples, time, this.noteHz) : samples;
    const rms = clean === samples ? rawRms : rmsOf(clean, this.baseWindow);
    const gated = this.stabilizer.isBelowGate(rmsToDb(rms));
    let detection = gated ? null : detectPitch(clean, this.sampleRate, this.opts.detect);
    // A pitch that is just a hum harmonic the canceller had to leave in place (a note decayed
    // into the hum at the same frequency) is not a reading.
    if (detection && hum?.isHum(detection.frequency)) detection = null;
    const out = this.stabilizer.push({ time, rms, detection });
    this.hum?.observe(detection, rawDb, time);
    this.noteHz = out.reading ? out.reading.frequency : null;
    return { status: out.status, reading: out.reading, level: this.level, time };
  }
}
