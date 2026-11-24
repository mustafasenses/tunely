// Signal-level helpers (pure).

/** dBFS (RMS) mapped to level 0. */
export const LEVEL_MIN_DB = -66;
/** dBFS (RMS) mapped to level 1. */
export const LEVEL_MAX_DB = -6;

/** RMS of the last `count` samples of `x` (all of x by default). */
export function rmsOf(x: Float32Array, count = x.length): number {
  const n = Math.min(count, x.length);
  if (n <= 0) return 0;
  let mean = 0;
  for (let i = x.length - n; i < x.length; i++) mean += x[i];
  mean /= n;
  let s = 0;
  for (let i = x.length - n; i < x.length; i++) {
    const v = x[i] - mean; // ignore DC offset of cheap mics
    s += v * v;
  }
  return Math.sqrt(s / n);
}

export function rmsToDb(rms: number): number {
  return rms > 1e-10 ? 20 * Math.log10(rms) : -200;
}

/**
 * Perceptual (dB-linear) level for a meter: LEVEL_MIN_DB → 0, LEVEL_MAX_DB → 1, clamped.
 * A full-scale sine (−3 dBFS RMS) reads 1; a quiet room is typically ~0–0.1.
 */
export function dbToLevel(db: number): number {
  const v = (db - LEVEL_MIN_DB) / (LEVEL_MAX_DB - LEVEL_MIN_DB);
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}
