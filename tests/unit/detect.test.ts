import { describe, expect, it } from 'vitest';
import { analysisLength, baseWindowSize, detectPitch } from '../../src/audio/detect.ts';
import { addNoise, gaussian, harmonicTone, sawAmps, sine } from './helpers/synth.ts';

const RATES = [44100, 48000];
const cents = (f: number, ref: number) => 1200 * Math.log2(f / ref);

/** Log-spaced frequencies in [lo, hi]. */
function sweep(lo: number, hi: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => lo * Math.pow(hi / lo, i / (n - 1)));
}

/** Max |error| (cents) of detectPitch over a sweep; any miss / octave error counts as Infinity. */
function maxError(fs: number, freqs: number[], make: (f: number, i: number) => Float32Array): number {
  let worst = 0;
  freqs.forEach((f, i) => {
    const d = detectPitch(make(f, i), fs);
    const e = d ? Math.abs(cents(d.frequency, f)) : Infinity;
    worst = Math.max(worst, e);
  });
  return worst;
}

describe('window sizing', () => {
  it('uses ~40 ms power-of-two base windows and 4× for analysis', () => {
    expect(baseWindowSize(44100)).toBe(2048);
    expect(baseWindowSize(48000)).toBe(2048);
    expect(baseWindowSize(96000)).toBe(4096);
    expect(analysisLength(48000)).toBe(8192);
  });
});

describe.each(RATES)('detectPitch @ %i Hz', (fs) => {
  const L = analysisLength(fs);

  it('pure sines 40 Hz – 2.5 kHz: ≤ ±1 c (spec) — holds ≤ 0.1 c', () => {
    const e = maxError(fs, sweep(40, 2500, 240), (f, i) => sine(f, fs, L, 0.5, i * 0.77));
    expect(e).toBeLessThanOrEqual(0.1);
  });

  it('pure sines 30–40 Hz and 2.5–4.2 kHz (outside the ±1 c band): ≤ 0.1 c', () => {
    expect(maxError(fs, sweep(30, 40, 30), (f, i) => sine(f, fs, L, 0.5, i))).toBeLessThanOrEqual(0.1);
    expect(maxError(fs, sweep(2500, 4200, 60), (f, i) => sine(f, fs, L, 0.5, i))).toBeLessThanOrEqual(0.1);
  });

  it('exact equal-tempered notes A0…C8 are read within 0.1 c', () => {
    const freqs = Array.from({ length: 88 }, (_, k) => 27.5 * Math.pow(2, k / 12)).filter((f) => f >= 30 && f <= 4200);
    expect(maxError(fs, freqs, (f, i) => sine(f, fs, L, 0.3, i))).toBeLessThanOrEqual(0.1);
  });

  it('is amplitude independent (−60 dBFS to full scale)', () => {
    for (const amp of [0.001, 0.01, 0.1, 0.99]) {
      expect(maxError(fs, [82.41, 261.63, 1046.5], (f) => sine(f, fs, L, amp, 1))).toBeLessThanOrEqual(0.1);
    }
  });

  it('band-limited sawtooth 40 Hz – 2.5 kHz: ≤ 0.1 c, correct octave', () => {
    const e = maxError(fs, sweep(40, 2500, 120), (f, i) => harmonicTone(f, fs, L, sawAmps(200), i));
    expect(e).toBeLessThanOrEqual(0.1);
  });

  it('sawtooth 30–40 Hz and 2.5–4.2 kHz: ≤ 0.1 c', () => {
    expect(maxError(fs, sweep(30, 40, 20), (f, i) => harmonicTone(f, fs, L, sawAmps(200), i))).toBeLessThanOrEqual(0.1);
    expect(maxError(fs, sweep(2500, 4200, 40), (f, i) => harmonicTone(f, fs, L, sawAmps(200), i))).toBeLessThanOrEqual(0.1);
  });

  it('square (odd harmonics only), strong-2nd-harmonic and even-heavy tones: ≤ 0.1 c', () => {
    const shapes = [
      [1, 0, 1 / 3, 0, 1 / 5, 0, 1 / 7, 0, 1 / 9],
      [0.3, 1, 0.3, 0.5, 0.2],
      [1, 0.9, 0.1, 0.6],
    ];
    for (const amps of shapes) {
      expect(maxError(fs, sweep(40, 2500, 80), (f, i) => harmonicTone(f, fs, L, amps, i))).toBeLessThanOrEqual(0.1);
    }
  });

  it('weak fundamental (−20 dB) across the range: ≤ 0.1 c, correct octave', () => {
    const amps = [0.1, 1, 0.7, 0.5, 0.3];
    expect(maxError(fs, sweep(40, 4200, 120), (f, i) => harmonicTone(f, fs, L, amps, i))).toBeLessThanOrEqual(0.1);
  });

  it('missing fundamental (harmonics 2–6 only) reads the virtual pitch: ≤ 0.1 c', () => {
    const amps = [0, 1, 0.8, 0.6, 0.4, 0.3];
    expect(maxError(fs, sweep(60, 2000, 80), (f, i) => harmonicTone(f, fs, L, amps, i))).toBeLessThanOrEqual(0.1);
  });

  it('sine + white noise at 20 dB SNR, 40 Hz – 2.5 kHz: ≤ ±3 c, correct octave', () => {
    const e = maxError(fs, sweep(40, 2500, 160), (f, i) => addNoise(sine(f, fs, L, 0.5, i), 20, 1000 + i));
    expect(e).toBeLessThanOrEqual(3);
  });

  it('sawtooth + white noise at 20 dB SNR, 30 Hz – 4.2 kHz: ≤ ±3 c, correct octave', () => {
    const e = maxError(fs, sweep(30, 4200, 160), (f, i) =>
      addNoise(harmonicTone(f, fs, L, sawAmps(60), i), 20, 2000 + i),
    );
    expect(e).toBeLessThanOrEqual(3);
  });

  // Beyond the spec (20 dB). Single-frame precision at 10 dB SNR is noise-limited (≈2 c rms
  // near 150 Hz on the 43 ms window); the point here is that the octave/note stays right.
  it('harmonic tone + white noise at 10 dB SNR: still the correct note (≤ 10 c)', () => {
    const e = maxError(fs, sweep(40, 2500, 100), (f, i) =>
      addNoise(harmonicTone(f, fs, L, [1, 0.5, 0.3, 0.2], i), 10, 3000 + i),
    );
    expect(e).toBeLessThanOrEqual(10);
  });

  it('reports high clarity for clean tones and low clarity for noise', () => {
    expect(detectPitch(sine(440, fs, L, 0.5), fs)!.clarity).toBeGreaterThan(0.98);
    const g = gaussian(9);
    const noise = Float32Array.from({ length: L }, () => 0.1 * g());
    const d = detectPitch(noise, fs);
    expect(d === null || d.clarity < 0.6).toBe(true);
  });
});

describe('detectPitch edge cases', () => {
  it('returns null for digital silence and tiny buffers', () => {
    expect(detectPitch(new Float32Array(8192), 48000)).toBeNull();
    expect(detectPitch(new Float32Array(16), 48000)).toBeNull();
  });

  it('ignores DC offset', () => {
    const x = sine(220, 48000, 8192, 0.2);
    for (let i = 0; i < x.length; i++) x[i] += 0.3;
    expect(Math.abs(cents(detectPitch(x, 48000)!.frequency, 220))).toBeLessThan(0.1);
  });

  it('works with buffers shorter than analysisLength (mid/high notes)', () => {
    const d = detectPitch(sine(659.26, 48000, 3000, 0.5), 48000);
    expect(Math.abs(cents(d!.frequency, 659.26))).toBeLessThan(0.1);
  });

  it('supports other sample rates (22.05 / 96 kHz)', () => {
    for (const fs of [22050, 96000]) {
      const d = detectPitch(sine(110, fs, analysisLength(fs), 0.5), fs);
      expect(Math.abs(cents(d!.frequency, 110))).toBeLessThan(0.1);
    }
  });
});

describe('performance', () => {
  it('one detection pass on the largest window is well under 8 ms', () => {
    const fs = 48000;
    const L = analysisLength(fs);
    // A 35 Hz bass note exercises the slowest path (both MPM windows + 8192-sample refinement).
    const x = addNoise(harmonicTone(35, fs, L, sawAmps(50), 1), 20, 1);
    for (let i = 0; i < 30; i++) detectPitch(x, fs); // warm up the JIT
    const n = 100;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) detectPitch(x, fs);
    const perCall = (performance.now() - t0) / n;
    expect(perCall).toBeLessThan(8);
  });
});

describe('detectPitch memory', () => {
  it('allocates no new buffers per frame when the FFT size alternates (short / long window)', () => {
    const fs = 48000;
    const L = analysisLength(fs);
    const low = harmonicTone(82.41, fs, L, sawAmps(10), 1); // short + long MPM windows each frame
    const high = harmonicTone(440, fs, L, sawAmps(10), 1);
    for (let i = 0; i < 20; i++) {
      detectPitch(low, fs);
      detectPitch(high, fs);
    }
    const before = process.memoryUsage().arrayBuffers;
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      detectPitch(low, fs);
      detectPitch(high, fs);
      peak = Math.max(peak, process.memoryUsage().arrayBuffers - before);
    }
    // Before the fix: ~27 MB of Float64Array churn over 200 low-note frames.
    expect(peak).toBeLessThan(1e6);
  });
});
