// Regression tests for room-noise robustness: mains hum, digital silence, muted / stalled input.
import { describe, expect, it } from 'vitest';
import { TunerPipeline } from '../../src/audio/pipeline.ts';
import { PitchStabilizer } from '../../src/audio/stabilizer.ts';
import type { TunerFrame } from '../../src/audio/types.ts';
import { addKalimbaNote, gaussian, harmonicTone, sawAmps } from './helpers/synth.ts';
import { runPipeline } from './helpers/run.ts';

const FS = 48000;
const midiOf = (f: number) => Math.round(69 + 12 * Math.log2(f / 440));
const centsErr = (f: number, f0: number) => Math.abs(1200 * Math.log2(f / f0));

function noise(seconds: number, db: number, seed = 5): Float32Array {
  const g = gaussian(seed);
  const a = Math.pow(10, db / 20);
  const x = new Float32Array(Math.round(seconds * FS));
  for (let i = 0; i < x.length; i++) x[i] = a * g();
  return x;
}

/** Mains hum at `db` dBFS RMS: fundamental + harmonics with the given relative amplitudes. */
function hum(seconds: number, f: number, db: number, harmonics = [1, 0.5, 0.3]): Float32Array {
  const x = new Float32Array(Math.round(seconds * FS));
  const norm = Math.sqrt(harmonics.reduce((s, h) => s + h * h, 0));
  const a = (Math.pow(10, db / 20) * Math.SQRT2) / norm;
  for (let i = 0; i < x.length; i++) {
    let v = 0;
    for (let k = 0; k < harmonics.length; k++) v += harmonics[k] * Math.sin((2 * Math.PI * f * (k + 1) * i) / FS + k);
    x[i] = a * v;
  }
  return x;
}

function mix(...xs: Float32Array[]): Float32Array {
  const out = new Float32Array(xs[0].length);
  for (const x of xs) for (let i = 0; i < out.length; i++) out[i] += x[i] ?? 0;
  return out;
}

const between = (frames: TunerFrame[], from: number, to: number) => frames.filter((f) => f.time >= from && f.time < to);

describe('mains hum', () => {
  it('a steady hum alone (50/60 Hz + harmonics, 100/120 Hz) never shows a note', () => {
    for (const [f, h] of [
      [50, [1, 0.5, 0.3]],
      [60, [1, 0.5, 0.3]],
      [100, [1]],
      [120, [1, 0.3]],
      [50, [0.3, 1, 0.5, 0.4, 0.3]], // strong 100 Hz buzz
    ] as const) {
      for (const db of [-48, -40]) {
        const frames = runPipeline(mix(hum(4, f, db, [...h]), noise(4, -70)), FS);
        const shown = between(frames, 300, 4000).filter((fr) => fr.status !== 'listening');
        expect(shown.length, `${f} Hz ${JSON.stringify(h)} @ ${db} dBFS`).toBe(0);
      }
    }
  });

  it('learns the hum and removes it', () => {
    const p = new TunerPipeline(FS);
    const x = mix(hum(2, 50, -48), noise(2, -70));
    const buf = new Float32Array(p.analysisLength);
    for (let t = 1000 / 60; t < 2000; t += 1000 / 60) {
      const end = Math.round((t / 1000) * FS);
      buf.fill(0);
      buf.set(x.subarray(Math.max(0, end - buf.length), end), Math.max(0, buf.length - end));
      p.process(buf, t);
    }
    expect(p.hum!.frequency).toBeCloseTo(50, 1);
    // The gate learns from the cleaned signal: the floor ends up near the −70 dBFS noise, not
    // at the hum level, so quiet plucks still open the gate.
    expect(p.stabilizer.noiseFloorDb).toBeLessThan(-60);
  });

  it('a quiet kalimba pluck (C4, peak 0.01–0.05) over a 50 Hz hum is shown through its sustain', () => {
    for (const onset of [1, 2]) {
      for (const amp of [0.05, 0.02, 0.01]) {
        const x = mix(hum(onset + 2.5, 50, -48), noise(onset + 2.5, -70));
        const f0 = 261.6256;
        addKalimbaNote(x, f0, FS, onset, { amp });
        const sustain = between(runPipeline(x, FS), onset * 1000 + 100, onset * 1000 + 2000);
        const ok = sustain.filter((fr) => fr.status === 'detected' && midiOf(fr.reading!.frequency) === 60);
        const label = `amp ${amp}, onset ${onset} s`;
        expect(ok.length / sustain.length, `${label}: share of sustain frames showing C4`).toBeGreaterThan(0.9);
        expect(Math.max(...ok.map((fr) => centsErr(fr.reading!.frequency, f0))), `${label}: error`).toBeLessThanOrEqual(1);
        expect(sustain.filter((fr) => fr.reading && midiOf(fr.reading.frequency) !== 60), `${label}: hum shown`).toHaveLength(0);
      }
    }
  });

  it('a plucked bass note (E1, E2, A1) is tuned normally through its long sustain', () => {
    for (const [f0, midi, hums] of [
      [41.2034, 28, [false, true]],
      [82.4069, 40, [false, true]],
      // A1 is < 1 analysis bin (5 Hz) from a 50 Hz hum: inseparable within the window, so over
      // a strong hum it is deliberately not shown (it would read several cents off).
      [55, 33, [false]],
    ] as const) {
      for (const withHum of hums) {
        const onset = withHum ? 2 : 0.5;
        const n = Math.round((onset + 5) * FS);
        const x = withHum ? mix(hum(onset + 5, 50, -48), noise(onset + 5, -70)) : noise(onset + 5, -70);
        const t0 = Math.round(onset * FS);
        const tone = harmonicTone(f0, FS, n - t0, sawAmps(15), 3, 0.3);
        for (let i = 0; i < tone.length; i++) x[t0 + i] += tone[i] * Math.exp(-i / FS / 2); // τ = 2 s
        const frames = runPipeline(x, FS);
        const sustain = between(frames, onset * 1000 + 200, onset * 1000 + 5000);
        const ok = sustain.filter((fr) => fr.status === 'detected' && midiOf(fr.reading!.frequency) === midi);
        const label = `midi ${midi}${withHum ? ' over 50 Hz hum' : ''}`;
        expect(ok.length / sustain.length, `${label}: detected share`).toBeGreaterThan(0.95);
        // Error once the 170 ms analysis window holds only the note (+ smoothing settled).
        const settled = ok.filter((fr) => fr.time >= onset * 1000 + 400);
        expect(Math.max(...settled.map((fr) => centsErr(fr.reading!.frequency, f0))), `${label}: error`).toBeLessThanOrEqual(3);
      }
    }
  }, 30_000);

  it('a bass note on the hum’s own pitch is shown while it rings, then not held forever', () => {
    const x = mix(hum(8, 50, -48), noise(8, -70));
    const f0 = 49; // G1-ish, < 1 analysis bin from the 50 Hz hum
    const t0 = 2 * FS;
    const tone = harmonicTone(f0, FS, x.length - t0, sawAmps(10), 3, 0.3);
    for (let i = 0; i < tone.length; i++) x[t0 + i] += tone[i] * Math.exp(-i / FS / 0.7);
    const frames = runPipeline(x, FS);
    const early = between(frames, 2300, 3000).filter((fr) => fr.status === 'detected');
    expect(early.length).toBeGreaterThan(20);
    expect(between(frames, 7000, 8000).filter((fr) => fr.status !== 'listening')).toHaveLength(0);
  });
});

describe('noise floor vs digital silence and muted input', () => {
  /** Brown-ish rumble (1-pole low-pass of white noise) scaled to `db` dBFS RMS. */
  function rumble(seconds: number, db: number): Float32Array {
    const g = gaussian(11);
    const x = new Float32Array(Math.round(seconds * FS));
    let y = 0;
    for (let i = 0; i < x.length; i++) x[i] = y = 0.995 * y + g();
    let s = 0;
    for (const v of x) s += v * v;
    const k = Math.pow(10, db / 20) / Math.sqrt(s / x.length);
    for (let i = 0; i < x.length; i++) x[i] *= k;
    return x;
  }

  it('initial zero frames + room rumble (−50 / −40 dBFS) produce no sustained false notes', () => {
    for (const db of [-50, -40]) {
      const sig = rumble(12, db);
      const p = new TunerPipeline(FS);
      const buf = new Float32Array(p.analysisLength);
      const frames: TunerFrame[] = [];
      let k = 0;
      for (let t = 1000 / 60; ; t += 1000 / 60, k++) {
        const end = Math.round((t / 1000) * FS);
        if (end > sig.length) break;
        if (k < 3) buf.fill(0); // a starting device delivers digital silence first
        else {
          buf.fill(0);
          buf.set(sig.subarray(Math.max(0, end - buf.length), end), Math.max(0, buf.length - end));
        }
        frames.push(p.process(buf, t));
      }
      // (Before the fix: 150+ detected and 670 holding frames of random low "notes", the floor
      // stuck near −126 dB. A few frames of brown-noise "pitch" right at the start remain, the
      // same as without the zero frames.)
      const detected = frames.filter((fr) => fr.status === 'detected');
      expect(detected.length, `${db} dBFS: detected frames`).toBeLessThan(15);
      expect(between(frames, 2000, 12000).filter((fr) => fr.status !== 'listening'), `${db} dBFS late`).toHaveLength(0);
      // The floor tracks the room, it is not stuck near −200 dB after the zero frames.
      expect(p.stabilizer.noiseFloorDb).toBeGreaterThan(db - 10);
    }
  });

  it('digital-silence frames never pull the noise floor down', () => {
    const s = new PitchStabilizer();
    let t = 0;
    for (let i = 0; i < 120; i++) s.push({ time: (t += 16.7), rms: 0.003, detection: null }); // −50 dBFS room
    const floor = s.noiseFloorDb;
    expect(floor).toBeGreaterThan(-52);
    for (let i = 0; i < 5; i++) s.push({ time: (t += 16.7), rms: 0, detection: null });
    expect(s.noiseFloorDb).toBe(floor);
  });

  it('muted / ignored frames neither move the floor nor show a note; the reading is held then released', () => {
    const fs = FS;
    const room = noise(30, -45);
    const p = new TunerPipeline(fs);
    const buf = new Float32Array(p.analysisLength);
    let floorBeforeMute = 0;
    const frames: TunerFrame[] = [];
    for (let t = 1000 / 60; t < 30000; t += 1000 / 60) {
      const end = Math.round((t / 1000) * fs);
      buf.fill(0);
      buf.set(room.subarray(Math.max(0, end - buf.length), end), Math.max(0, buf.length - end));
      if (t >= 3000 && t < 5000) {
        if (!floorBeforeMute) floorBeforeMute = p.stabilizer.noiseFloorDb;
        p.setMuted(true, t);
      } else p.setMuted(false, t);
      frames.push(p.process(buf, t));
      if (t > 4900 && t < 5000) expect(p.stabilizer.noiseFloorDb).toBe(floorBeforeMute);
    }
    expect(frames.filter((fr) => fr.status === 'detected')).toHaveLength(0);
    expect(p.stabilizer.noiseFloorDb).toBeGreaterThan(-50);
  });

  it('pipeline.idle() (stalled / suspended input) holds the last reading, then listens; level falls to 0', () => {
    const p = new TunerPipeline(FS);
    const tone = harmonicTone(440, FS, p.analysisLength, sawAmps(5));
    const quiet = noise(0.2, -70).subarray(0, p.analysisLength);
    let t = 0;
    for (let i = 0; i < 10; i++) p.process(quiet, (t += 16.7));
    let f = p.process(tone, (t += 16.7));
    for (let i = 0; i < 20; i++) f = p.process(tone, (t += 16.7));
    expect(f.status).toBe('detected');
    const statuses: string[] = [];
    for (let i = 0; i < 120; i++) {
      f = p.idle((t += 16.7));
      statuses.push(f.status);
    }
    expect(statuses[10]).toBe('holding');
    expect(statuses.at(-1)).toBe('listening');
    expect(f.level).toBeLessThan(0.01);
    expect(statuses.slice(7)).not.toContain('detected'); // only the 100 ms grace shows 'detected'
  });
});
