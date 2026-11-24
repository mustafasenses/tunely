import { describe, expect, it } from 'vitest';
import { centsToHz, hzToCents, PitchStabilizer, type StabilizerOutput } from '../../src/audio/stabilizer.ts';
import { gaussian } from './helpers/synth.ts';

const HOP = 1000 / 60; // ~60 frames/s like the engine
const LOUD = 0.05; // −26 dBFS RMS, well above the gate
const A4 = 440;

/** Small driver: feeds frames at HOP spacing. */
function driver(start = 0) {
  const s = new PitchStabilizer();
  let t = start;
  return {
    s,
    get time() {
      return t;
    },
    push(freq: number | null, rms = LOUD, clarity = 0.97): StabilizerOutput {
      t += HOP;
      return s.push({ time: t, rms, detection: freq === null ? null : { frequency: freq, clarity } });
    },
    /** Push n frames; returns the outputs. */
    run(n: number, f: (i: number) => number | null, rms = LOUD, clarity = 0.97): StabilizerOutput[] {
      const out: StabilizerOutput[] = [];
      for (let i = 0; i < n; i++) out.push(this.push(f(i), rms, clarity));
      return out;
    },
  };
}

const centsOf = (o: StabilizerOutput, ref: number) => 1200 * Math.log2(o.reading!.frequency / ref);

/** Bring the stabiliser into a settled state on `freq` (quiet lead-in, then the tone). */
function settled(freq: number) {
  const d = driver();
  d.run(10, () => null, 1e-5); // silence: gate closed, noise floor learnt
  d.run(30, () => freq);
  return d;
}

describe('PitchStabilizer', () => {
  it('converts Hz ↔ cents consistently', () => {
    expect(hzToCents(440)).toBe(0);
    expect(hzToCents(880)).toBeCloseTo(1200, 10);
    expect(centsToHz(hzToCents(261.63))).toBeCloseTo(261.63, 10);
  });

  it('starts in listening with no reading', () => {
    const d = driver();
    const o = d.push(null, 1e-5);
    expect(o).toEqual({ status: 'listening', reading: null });
  });

  it('acquires a clear tone within 2 frames (~33 ms)', () => {
    const d = driver();
    d.run(10, () => null, 1e-5);
    // First loud frame is an onset → only very clear frames count; 0.97 qualifies.
    const out = d.run(2, () => A4);
    expect(out[0].status).toBe('listening');
    expect(out[1].status).toBe('detected');
    expect(out[1].reading!.frequency).toBeCloseTo(A4, 6);
  });

  it('keeps jitter on a steady tone ≤ 1 c (input: independent 1 c rms per-frame noise)', () => {
    // Harsher than the real detector at 20 dB SNR (≤ 0.5 c rms, and correlated between
    // overlapping frames), see pipeline.test.ts for the end-to-end figure.
    const g = gaussian(42);
    const d = settled(A4);
    const out = d.run(300, () => A4 * Math.pow(2, g() / 1200));
    const c = out.map((o) => centsOf(o, A4));
    expect(out.every((o) => o.status === 'detected')).toBe(true);
    expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(1);
    expect(Math.max(...c.map(Math.abs))).toBeLessThanOrEqual(0.6);
  });

  it('ignores single-frame outliers: octave jumps, fifths, random notes', () => {
    const d = settled(A4);
    for (const spike of [880, 220, 660, 1320, 523.25, 3000]) {
      const o = d.push(spike);
      expect(o.status).toBe('detected');
      expect(Math.abs(centsOf(o, A4))).toBeLessThan(0.01);
      const back = d.push(A4);
      expect(Math.abs(centsOf(back, A4))).toBeLessThan(0.01);
    }
  });

  it('ignores a 2-frame octave error burst but follows a sustained octave change', () => {
    const d = settled(A4);
    let out = d.run(2, () => 880);
    expect(out.every((o) => Math.abs(centsOf(o, A4)) < 0.01)).toBe(true);
    d.run(5, () => A4);
    out = d.run(3, () => 880);
    expect(Math.abs(centsOf(out[1], A4))).toBeLessThan(0.01);
    expect(Math.abs(centsOf(out[2], 880))).toBeLessThan(0.01); // switched after 3 frames (50 ms)
  });

  it('responds to a genuine new note without lag (< 150 ms, no smoothing tail)', () => {
    const d = settled(A4);
    const target = 493.88; // B4
    const out = d.run(10, () => target);
    const firstIdx = out.findIndex((o) => Math.abs(centsOf(o, target)) < 0.5);
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect((firstIdx + 1) * HOP).toBeLessThanOrEqual(150);
    // Reset on a new note: the first reading of the new note is already exact.
    expect(Math.abs(centsOf(out[firstIdx], target))).toBeLessThan(0.01);
  });

  it('responds within 150 ms at 30 frames/s as well', () => {
    const s = new PitchStabilizer();
    let t = 0;
    for (let i = 0; i < 30; i++) s.push({ time: (t += 33.3), rms: LOUD, detection: { frequency: A4, clarity: 0.97 } });
    const t0 = t;
    let switched = -1;
    for (let i = 0; i < 10 && switched < 0; i++) {
      const o = s.push({ time: (t += 33.3), rms: LOUD, detection: { frequency: 523.25, clarity: 0.97 } });
      if (Math.abs(1200 * Math.log2(o.reading!.frequency / 523.25)) < 0.5) switched = t - t0;
    }
    expect(switched).toBeGreaterThan(0);
    expect(switched).toBeLessThanOrEqual(150);
  });

  it('follows a slow pitch change (tuning a peg) within the same note', () => {
    const d = settled(A4);
    // +20 c over 1 s
    const out = d.run(60, (i) => A4 * Math.pow(2, ((20 * (i + 1)) / 60) / 1200));
    expect(out.every((o) => o.status === 'detected')).toBe(true);
    expect(centsOf(out[59], A4)).toBeGreaterThan(16); // ≤ ~4 c behind a fast 20 c/s glide
  });

  it('holds the last reading for ~1.5 s after the signal drops, then listens', () => {
    const d = settled(A4);
    const last = d.push(A4);
    const tLast = d.time;
    const after: { t: number; o: StabilizerOutput }[] = [];
    for (let i = 0; i < 120; i++) after.push({ t: d.time + HOP, o: d.push(null, 1e-5) });
    const holding = after.filter((a) => a.o.status === 'holding');
    expect(holding.length).toBeGreaterThan(0);
    for (const h of holding) expect(h.o.reading!.frequency).toBe(last.reading!.frequency);
    // brief grace (≤ 100 ms) keeps 'detected' to avoid flicker
    expect(after.filter((a) => a.o.status === 'detected').every((a) => a.t - tLast <= 100)).toBe(true);
    const lastHold = holding[holding.length - 1].t - tLast;
    const firstListen = after.find((a) => a.o.status === 'listening')!.t - tLast;
    expect(lastHold).toBeGreaterThan(1450);
    expect(lastHold).toBeLessThanOrEqual(1500);
    expect(firstListen).toBeGreaterThan(1500);
    expect(firstListen).toBeLessThan(1520);
    expect(after.find((a) => a.o.status === 'listening')!.o.reading).toBeNull();
  });

  it('treats loss of clarity like loss of signal (holding)', () => {
    const d = settled(A4);
    const out = d.run(30, () => A4, LOUD, 0.3);
    expect(out[out.length - 1].status).toBe('holding');
  });

  it('gate: quiet frames never produce readings; hysteresis keeps a decaying tone', () => {
    const d = driver();
    d.run(10, () => null, 1e-5);
    // −70 dBFS: below the −56 dB open threshold.
    expect(d.run(20, () => A4, 0.0003).every((o) => o.status === 'listening')).toBe(true);
    // Open at −40 dBFS …
    expect(d.run(5, () => A4, 0.01).some((o) => o.status === 'detected')).toBe(true);
    // … then −59 dBFS (between close −62 and open −56): stays open.
    expect(d.run(30, () => A4, 0.0011).every((o) => o.status === 'detected')).toBe(true);
    // below −62 dBFS → closed → holding
    expect(d.run(10, () => A4, 0.0006).slice(-1)[0].status).toBe('holding');
  });

  it('raises the gate in a noisy room (relative to the learnt noise floor)', () => {
    const d = driver();
    // 2 s of unpitched −40 dBFS room noise → floor estimate climbs to ≈ −40 dB.
    d.run(120, () => null, 0.01);
    expect(d.s.noiseFloorDb).toBeGreaterThan(-42);
    // A tone barely above the noise (−37 dBFS) does not open the gate (needs floor + 10 dB)…
    expect(d.run(10, () => A4, 0.014, 0.9).every((o) => o.status === 'listening')).toBe(true);
    // …a clearly louder one does.
    expect(d.run(5, () => A4, 0.05).some((o) => o.status === 'detected')).toBe(true);
  });

  it('onset guard: attack-transient frames (clarity < 0.95) right after a pluck are ignored', () => {
    const d = driver();
    d.run(10, () => null, 1e-5);
    // Plucked note: first frames are a periodic-looking but wrong transient at clarity 0.9.
    const attack = d.run(3, () => 1567, LOUD, 0.9);
    expect(attack.every((o) => o.status === 'listening')).toBe(true);
    const tone = d.run(4, () => A4, LOUD, 0.99);
    expect(tone.some((o) => o.status === 'detected' && Math.abs(centsOf(o, A4)) < 0.01)).toBe(true);
  });

  it('acquires a lower-clarity note (e.g. two tines ringing) with one extra confirming frame', () => {
    const d = driver();
    d.run(10, () => null, 1e-5);
    d.run(6, () => null, LOUD); // level already up: no onset in the window below
    for (let i = 0; i < 10; i++) d.push(null, LOUD);
    const out = d.run(3, () => A4, LOUD, 0.7);
    expect(out[1].status).toBe('listening');
    expect(out[2].status).toBe('detected');
  });

  it('re-confirms a held note after a gap (fresh history, no lag from the previous pluck)', () => {
    const d = settled(A4);
    d.run(30, () => null, 1e-5); // 0.5 s gap → holding
    const sharp = A4 * Math.pow(2, 8 / 1200); // re-plucked after tuning: +8 c
    const out = d.run(4, () => sharp);
    const det = out.filter((o) => o.status === 'detected');
    expect(det.length).toBeGreaterThan(0);
    expect(Math.abs(centsOf(det[0], sharp))).toBeLessThan(0.01);
  });

  it('reset() returns to the initial state', () => {
    const d = settled(A4);
    d.s.reset();
    expect(d.push(null, 1e-5).status).toBe('listening');
  });
});
