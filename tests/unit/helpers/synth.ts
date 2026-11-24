// Deterministic test-signal synthesis (shared by unit tests and scripts/make-test-wavs.ts).

/** Small, fast, seedable PRNG (mulberry32). Returns uniform [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal generator (Box–Muller) from a seeded uniform source. */
export function gaussian(seed: number): () => number {
  const u = rng(seed);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let a = 0;
    while (a <= 1e-12) a = u();
    const b = u();
    const r = Math.sqrt(-2 * Math.log(a));
    spare = r * Math.sin(2 * Math.PI * b);
    return r * Math.cos(2 * Math.PI * b);
  };
}

export function sine(freq: number, sampleRate: number, length: number, amp = 0.5, phase = 0): Float32Array {
  const out = new Float32Array(length);
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < length; i++) out[i] = amp * Math.sin(w * i + phase);
  return out;
}

/**
 * Sum of harmonics: amps[h-1] is the amplitude of harmonic h. Harmonics at or above 0.48·fs
 * are dropped (band-limited). Phases are pseudo-random but deterministic.
 */
export function harmonicTone(
  f0: number,
  sampleRate: number,
  length: number,
  amps: number[],
  seed = 1,
  gain = 0.3,
): Float32Array {
  const out = new Float32Array(length);
  const r = rng(seed);
  for (let h = 1; h <= amps.length; h++) {
    const f = f0 * h;
    if (f >= 0.48 * sampleRate || amps[h - 1] === 0) continue;
    const w = (2 * Math.PI * f) / sampleRate;
    const ph = r() * 2 * Math.PI;
    const a = amps[h - 1] * gain;
    for (let i = 0; i < length; i++) out[i] += a * Math.sin(w * i + ph);
  }
  return out;
}

/** Band-limited sawtooth amplitudes (1/h) up to n harmonics. */
export function sawAmps(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 1 / (i + 1));
}

export function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

/** Add white Gaussian noise so that the result has the given SNR (dB) relative to x's RMS. */
export function addNoise(x: Float32Array, snrDb: number, seed = 7): Float32Array {
  const g = gaussian(seed);
  const sigma = rms(x) / Math.pow(10, snrDb / 20);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] + sigma * g();
  return out;
}

export interface KalimbaOptions {
  /** Seconds of signal (default 2). */
  duration?: number;
  /** Onset time within the signal in seconds (default 0.1, i.e. 100 ms of noise floor first). */
  onset?: number;
  /** Peak amplitude of the fundamental (default 0.3). */
  amp?: number;
  /** Fundamental decay time constant in seconds (default 0.8). */
  tau?: number;
  /** Ratio of the inharmonic 2nd bending mode to f0 (default 5.9). */
  partialRatio?: number;
  /** Initial amplitude of that mode relative to f0 (default 0.6). */
  partialAmp?: number;
  /** Its decay constant as a fraction of tau (default 0.25 → decays 4× faster). */
  partialTauRatio?: number;
  /** Relative amplitudes of the 2nd and 3rd harmonics (default 0.08, 0.04). */
  h2?: number;
  h3?: number;
  /** Peak amplitude of the attack noise burst / click relative to amp (default 1.0). */
  clickAmp?: number;
  /** Background white-noise floor in dBFS RMS (default −70). */
  noiseFloorDb?: number;
  seed?: number;
}

/**
 * Kalimba-like tone: exponentially decaying fundamental + inharmonic bending mode (≈5–7×f0)
 * that decays faster + a little 2×/3× content, a ~1 ms rise, and a percussive attack made of a
 * decaying broadband noise burst (≈5 ms) plus a short metallic click (≈3 kHz, ≈10 ms).
 * Returns the signal; f0 is exactly `f0`.
 */
export function kalimbaTone(f0: number, sampleRate: number, o: KalimbaOptions = {}): Float32Array {
  const duration = o.duration ?? 2;
  const n = Math.round(duration * sampleRate);
  const out = new Float32Array(n);
  addKalimbaNote(out, f0, sampleRate, o.onset ?? 0.1, o);
  const g = gaussian((o.seed ?? 3) * 977 + 13);
  const floor = Math.pow(10, (o.noiseFloorDb ?? -70) / 20);
  for (let i = 0; i < n; i++) out[i] += floor * g();
  return out;
}

/** Mixes one kalimba note (no noise floor) into `out` starting at `onset` seconds. */
export function addKalimbaNote(
  out: Float32Array,
  f0: number,
  sampleRate: number,
  onset: number,
  o: KalimbaOptions = {},
): void {
  const amp = o.amp ?? 0.3;
  const tau = o.tau ?? 0.8;
  const ratio = o.partialRatio ?? 5.9;
  const pAmp = o.partialAmp ?? 0.6;
  const pTau = tau * (o.partialTauRatio ?? 0.25);
  const h2 = o.h2 ?? 0.08;
  const h3 = o.h3 ?? 0.04;
  const click = (o.clickAmp ?? 1) * amp;
  const r = rng(o.seed ?? 3);
  const g = gaussian((o.seed ?? 3) * 31 + 5);
  const ph = [r(), r(), r(), r()].map((v) => v * 2 * Math.PI);
  const start = Math.round(onset * sampleRate);
  const nyq = sampleRate / 2;
  for (let i = start; i < out.length; i++) {
    const t = (i - start) / sampleRate;
    const rise = Math.min(1, t / 0.001);
    const e = Math.exp(-t / tau);
    let v = Math.sin(2 * Math.PI * f0 * t + ph[0]) * e;
    if (ratio * f0 < nyq * 0.95) v += pAmp * Math.exp(-t / pTau) * Math.sin(2 * Math.PI * ratio * f0 * t + ph[1]);
    if (2 * f0 < nyq * 0.95) v += h2 * e * e * Math.sin(2 * Math.PI * 2 * f0 * t + ph[2]);
    if (3 * f0 < nyq * 0.95) v += h3 * e * e * Math.sin(2 * Math.PI * 3 * f0 * t + ph[3]);
    v *= amp * rise;
    if (t < 0.04) {
      v += click * Math.exp(-t / 0.005) * g();
      v += 0.5 * click * Math.exp(-t / 0.01) * Math.sin(2 * Math.PI * 3100 * t);
    }
    out[i] += v;
  }
}
