/*
 * Pitch detector — pure and synchronous.
 *
 * Two stages, because no single classic method gives both robust octave decisions and
 * sub-cent precision on kalimba-like signals:
 *
 * 1. COARSE / octave decision — McLeod Pitch Method (MPM, McLeod & Wyvill 2005).
 *    NSDF n(τ) = 2·r(τ) / m(τ), with the autocorrelation r computed via FFT, then
 *    "key maxima" peak picking (first key maximum ≥ k·highest) and parabolic interpolation.
 *    MPM is very robust against octave errors on harmonic signals, but its *precision* is not
 *    good enough for us: (a) parabolic interpolation of the NSDF peak is biased by several
 *    cents at short periods (≈11 samples at 4.2 kHz), and (b) any time-domain periodicity
 *    method is biased by INHARMONIC partials — a kalimba's strong 2nd mode at ≈5.9·f0 shifts
 *    the NSDF peak at τ = 1/f0 by 10–30 cents (the partial's correlation has non-zero slope
 *    there). Both are unacceptable for a ±1 c / ±3 c target.
 *
 * 2. FINE — maximum of the windowed DTFT magnitude near the coarse f0, found by Newton
 *    iteration on log|X(ω)|² using analytic derivatives (Σ n·x·e^{-iωn}, Σ n²·x·e^{-iωn}).
 *    A 4-term Blackman-Harris window (−92 dB sidelobes) makes the estimate essentially
 *    unbiased once the window spans ≥ ~5 periods (we use ≥ 8): neighbouring harmonics, the
 *    negative-frequency image and far-away inharmonic partials leak in at < −90 dB.
 *    An exponentially decaying tone (real envelope) has a symmetric magnitude spectrum, so
 *    the kalimba's decay does not bias the peak either. The peak is first *located* on a 2×
 *    zero-padded FFT within ±10 % of the coarse value (an inharmonic mode can shift MPM's
 *    answer by several percent), then refined.
 *
 *    Spectral sanity guards fix MPM's remaining failure modes:
 *    • sub-multiple: MPM picked d·period (high notes where few samples per period blunt the
 *      NSDF; a strong inharmonic mode making the waveform repeat every few periods; a fading
 *      lower-octave note) — detected because the candidate's non-multiple-of-d harmonics are
 *      (almost) absent;
 *    • common subharmonic: two notes ringing together (C4 + E4) repeat only at a long common
 *      period (C2) with no energy there — re-centred on the strongest real component;
 *    • weak fundamental: combine harmonics 1..4 (f_h / h, weighted by amplitude², only those
 *      agreeing within a few cents, so an inharmonic partial can never pull f0).
 *
 * Clarity = MPM's NSDF peak (near the final period), or the spectral harmonic-energy fraction
 * if higher (a second ringing note depresses the NSDF far more than it should).
 *
 * Adaptive windows: the caller passes the most recent `analysisLength(sampleRate)` samples
 * (≈170 ms at 48 kHz). MPM first runs on the shortest window (base ≈ 43 ms) for fast
 * response; only if that finds nothing convincing or a long period (f0 ≲ 190 Hz) do we also
 * run it on the longest window, which is needed to see ≥ 2 periods of 30–47 Hz notes. The
 * refinement window is the shortest of {base, 2·base, 4·base} spanning ≥ 8 periods: notes
 * above ~141 Hz (all kalimba tines) are measured on a 43 ms window, so a newly plucked note
 * replaces the previous one quickly, while bass notes get the resolution they physically
 * need (frequency resolution ∝ 1/window length).
 */

import { fft, nextPowerOfTwo } from './fft.ts';

export interface PitchDetection {
  /** Fundamental frequency in Hz. */
  frequency: number;
  /**
   * Confidence 0..1: NSDF peak height near the final period, or the harmonic-energy fraction
   * if higher. ≈1 for clean tones, ≈SNR/(1+SNR) in noise, < 0.5 for noise / chords.
   */
  clarity: number;
}

export interface DetectOptions {
  /** Lowest detectable f0 in Hz (default 28). */
  minFrequency?: number;
  /** Highest detectable f0 in Hz (default 4500). */
  maxFrequency?: number;
  /** MPM key-maximum threshold k (default 0.9). */
  peakThreshold?: number;
  /** Shortest analysis window in samples (default: baseWindowSize(sampleRate)). */
  baseWindow?: number;
}

const DEFAULT_MIN_F = 28;
const DEFAULT_MAX_F = 4500;
const DEFAULT_K = 0.9;
/** Refinement needs this many periods inside the window for the BH4 main lobes to separate. */
const MIN_PERIODS_FOR_REFINE = 8;
/** Run the long MPM window when the short one sees fewer than this many periods. */
const MIN_PERIODS_SHORT_MPM = 8;

/** ≈40 ms rounded up to a power of two: 2048 at 44.1/48 kHz, 4096 at 88.2/96 kHz. */
export function baseWindowSize(sampleRate: number): number {
  return nextPowerOfTwo(Math.ceil(sampleRate * 0.04));
}

/** How many of the most recent samples `detectPitch` wants (4 × base window). */
export function analysisLength(sampleRate: number): number {
  return baseWindowSize(sampleRate) * 4;
}

/**
 * Detect the fundamental of the most recent samples (the END of `samples` is "now").
 * Pass at least `analysisLength(sampleRate)` samples for full low-frequency range; fewer
 * samples work but limit the lowest detectable note. Returns null when no periodicity is found.
 */
export function detectPitch(
  samples: Float32Array,
  sampleRate: number,
  opts: DetectOptions = {},
): PitchDetection | null {
  const minF = opts.minFrequency ?? DEFAULT_MIN_F;
  const maxF = opts.maxFrequency ?? DEFAULT_MAX_F;
  const k = opts.peakThreshold ?? DEFAULT_K;
  const base = Math.min(opts.baseWindow ?? baseWindowSize(sampleRate), samples.length);
  const longest = Math.min(base * 4, samples.length);
  if (base < 32) return null;

  // --- Stage 1: MPM, short window first, long window only when needed. ---
  const short = mpm(samples, base, sampleRate, minF, maxF, k, 0);
  let coarse = short;
  const needLong =
    longest > base &&
    (!short || short.clarity < 0.9 || short.period * MIN_PERIODS_SHORT_MPM > base);
  if (needLong) {
    const long = mpm(samples, longest, sampleRate, minF, maxF, k, 1);
    if (long) {
      if (!short) coarse = long;
      else if (long.period * MIN_PERIODS_SHORT_MPM > base && isMultiple(long.period, short.period)) {
        // Low note: the short window could only see one of its harmonics (or the same period
        // with fewer cycles) — trust the long window.
        coarse = long;
      } else if (short.clarity < 0.8 && long.clarity > short.clarity + 0.05) {
        coarse = long;
      }
    }
  }
  if (!coarse) return null;

  // --- Stage 2: spectral refinement on a window spanning ≥ 8 periods. ---
  let refineWin = base;
  while (refineWin < longest && refineWin < coarse.period * MIN_PERIODS_FOR_REFINE) refineWin *= 2;
  refineWin = Math.min(refineWin, longest);
  const coarseF = sampleRate / coarse.period;
  const refined = refine(samples, refineWin, sampleRate, coarseF, minF);
  const frequency = refined ? refined.frequency : coarseF;
  if (!(frequency >= minF * 0.97 && frequency <= maxF * 1.03)) return null;

  // Clarity: if the spectral stage moved away from MPM's period (snap / sub-multiple fix /
  // chord), use the periodicity actually found near the final period. A second ringing note
  // depresses the NSDF a lot (~0.6 for two equal notes), so the spectral harmonic-energy
  // fraction is used when it is higher.
  let clarity = coarse.clarity;
  if (Math.abs(frequency / coarseF - 1) > 0.02) {
    const c = clarityNear(coarse, sampleRate / frequency);
    if (c !== null) clarity = c;
  }
  if (refined && refined.hef > clarity) clarity = refined.hef;
  return { frequency, clarity };
}

/** Highest NSDF value within ±10 % of `period` (null if out of the computed lag range). */
function clarityNear(coarse: CoarseResult, period: number): number | null {
  const lo = Math.max(1, Math.floor(period * 0.9));
  const hi = Math.min(coarse.maxLag, Math.ceil(period * 1.1));
  if (hi <= lo) return null;
  const n = coarse.nsdf;
  let best = 0;
  for (let t = lo; t <= hi; t++) if (n[t] > best) best = n[t];
  return Math.min(1, best);
}

function isMultiple(longPeriod: number, shortPeriod: number): boolean {
  const r = longPeriod / shortPeriod;
  const m = Math.round(r);
  return m >= 1 && Math.abs(r - m) < 0.03 * m;
}

// ---------------------------------------------------------------------------------------
// Stage 1: McLeod Pitch Method
// ---------------------------------------------------------------------------------------

interface CoarseResult {
  /** Period in samples (fractional). */
  period: number;
  clarity: number;
  /** The NSDF it was picked from (valid for lags 0..maxLag). */
  nsdf: Float64Array;
  maxLag: number;
}

// Scratch buffers, grown on demand (detectPitch stays allocation-free in steady state).
let fftRe = new Float64Array(0);
let fftIm = new Float64Array(0);
let segBuf = new Float64Array(0);
/** One NSDF buffer per MPM pass (0 = short window, 1 = long window). */
const nsdfBufs = [new Float64Array(0), new Float64Array(0)];

function mpm(
  samples: Float32Array,
  W: number,
  fs: number,
  minF: number,
  maxF: number,
  k: number,
  slot: 0 | 1,
): CoarseResult | null {
  const start = samples.length - W;
  // NSDF needs lags up to the longest period (+5 % so its peak is not at the edge), but the
  // overlap must stay ≥ W/2 for a meaningful estimate.
  const maxLag = Math.min(Math.floor(W / 2) - 1, Math.ceil((fs / minF) * 1.05) + 2);
  const minLag = Math.max(2, Math.floor(fs / maxF));
  if (maxLag <= minLag + 2) return null;

  // Demeaned segment.
  if (segBuf.length < W) segBuf = new Float64Array(W);
  const x = segBuf;
  let mean = 0;
  for (let i = 0; i < W; i++) mean += samples[start + i];
  mean /= W;
  let energy = 0;
  for (let i = 0; i < W; i++) {
    const v = samples[start + i] - mean;
    x[i] = v;
    energy += v * v;
  }
  if (energy < 1e-12 * W) return null; // digital silence

  // Autocorrelation r(τ) via FFT (zero-padded so there is no circular wrap for τ ≤ maxLag).
  const N = nextPowerOfTwo(W + maxLag + 1);
  if (fftRe.length !== N) {
    fftRe = new Float64Array(N);
    fftIm = new Float64Array(N);
  }
  const re = fftRe;
  const im = fftIm;
  re.fill(0);
  im.fill(0);
  for (let i = 0; i < W; i++) re[i] = x[i];
  fft(re, im);
  for (let i = 0; i < N; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fft(re, im, true); // re[τ] = r(τ)

  // NSDF with incrementally updated m(τ) = Σ x_j² + x_{j+τ}² over the overlap.
  if (nsdfBufs[slot].length < maxLag + 2) nsdfBufs[slot] = new Float64Array(maxLag + 2);
  const n = nsdfBufs[slot];
  let m = 2 * energy;
  n[0] = 1;
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    m -= x[tau - 1] * x[tau - 1] + x[W - tau] * x[W - tau];
    n[tau] = m > 1e-12 ? (2 * re[tau]) / m : 0;
  }

  // Key maxima: the highest point of each positive lobe after the first negative-going zero
  // crossing. Lobes still open at maxLag are only accepted if the maximum is not at the edge.
  let tau = 1;
  while (tau <= maxLag && n[tau] > 0) tau++;
  peakCount = 0;
  let inLobe = false;
  let lobeTau = -1;
  let lobeVal = -Infinity;
  for (; tau <= maxLag; tau++) {
    const v = n[tau];
    if (v > 0) {
      if (!inLobe || v > lobeVal) {
        lobeTau = tau;
        lobeVal = v;
      }
      inLobe = true;
    } else if (inLobe) {
      if (lobeTau >= minLag) addPeak(n, lobeTau);
      inLobe = false;
    }
  }
  if (inLobe && lobeTau >= minLag && lobeTau < maxLag - 1) addPeak(n, lobeTau);
  if (peakCount === 0) return null;

  // Threshold on parabolically interpolated peak heights: at short periods (high notes with
  // strong upper harmonics) the integer-lag samples can miss the top of a narrow NSDF peak,
  // which would otherwise make the k-rule skip the true period in favour of 2·period.
  let best = 0;
  for (let i = 1; i < peakCount; i++) if (peakVal[i] > peakVal[best]) best = i;
  const threshold = k * peakVal[best];
  let chosen = best;
  for (let i = 0; i < peakCount; i++) {
    if (peakVal[i] >= threshold) {
      chosen = i;
      break;
    }
  }
  return { period: peakLag[chosen], clarity: Math.max(0, Math.min(1, peakVal[chosen])), nsdf: n, maxLag };
}

// Key-maximum storage (interpolated lag and height), reused across calls.
let peakLag = new Float64Array(64);
let peakVal = new Float64Array(64);
let peakCount = 0;

function addPeak(n: Float64Array, t: number): void {
  if (peakCount === peakLag.length) {
    const nl = new Float64Array(peakCount * 2);
    const nv = new Float64Array(peakCount * 2);
    nl.set(peakLag);
    nv.set(peakVal);
    peakLag = nl;
    peakVal = nv;
  }
  const a = n[t - 1];
  const b = n[t];
  const c = n[t + 1];
  const denom = a - 2 * b + c;
  let delta = denom < 0 ? (0.5 * (a - c)) / denom : 0;
  if (delta > 0.5) delta = 0.5;
  else if (delta < -0.5) delta = -0.5;
  peakLag[peakCount] = t + delta;
  peakVal[peakCount] = b - 0.25 * (a - c) * delta;
  peakCount++;
}

// ---------------------------------------------------------------------------------------
// Stage 2: spectral refinement
// ---------------------------------------------------------------------------------------

const windowCache = new Map<number, Float64Array>();

/** 4-term Blackman-Harris window (−92 dB sidelobes, main lobe ±4 bins). */
function blackmanHarris(W: number): Float64Array {
  let w = windowCache.get(W);
  if (w) return w;
  w = new Float64Array(W);
  const a0 = 0.35875;
  const a1 = 0.48829;
  const a2 = 0.14128;
  const a3 = 0.01168;
  for (let i = 0; i < W; i++) {
    const p = (2 * Math.PI * i) / (W - 1);
    w[i] = a0 - a1 * Math.cos(p) + a2 * Math.cos(2 * p) - a3 * Math.cos(3 * p);
  }
  windowCache.set(W, w);
  return w;
}

let winBuf = new Float64Array(0);

interface SpectralEval {
  /** |X(ω)|² */
  p: number;
  /** d/dω log|X|² */
  d1: number;
  /** d²/dω² log|X|² */
  d2: number;
}

/**
 * Evaluate |X(ω)|² of the windowed segment y and the first two derivatives of its log.
 * The time index is centred (m = n − (W−1)/2) to keep the moment sums well conditioned.
 * Phasors are advanced by complex rotation (error ~W·ε, negligible in float64).
 */
function evalSpectrum(y: Float64Array, W: number, omega: number): SpectralEval {
  const centre = (W - 1) / 2;
  const cw = Math.cos(omega);
  const sw = Math.sin(omega);
  // e^{-iωm} at m = −centre
  let c = Math.cos(omega * centre);
  let s = Math.sin(omega * centre);
  let xr = 0;
  let xi = 0;
  let x1r = 0;
  let x1i = 0;
  let x2r = 0;
  let x2i = 0;
  let mm = -centre;
  for (let i = 0; i < W; i++, mm++) {
    const v = y[i];
    const vc = v * c;
    const vs = v * s;
    xr += vc;
    xi += vs;
    // X' = Σ y·(−i m)·e^{-iωm}; with e^{-iωm} = c + i s → (m s) − i (m c)
    x1r += mm * vs;
    x1i -= mm * vc;
    // X'' = Σ y·(−m²)·e^{-iωm}
    const m2 = mm * mm;
    x2r -= m2 * vc;
    x2i -= m2 * vs;
    const nc = c * cw + s * sw;
    s = s * cw - c * sw;
    c = nc;
  }
  const p = xr * xr + xi * xi;
  const p1 = 2 * (xr * x1r + xi * x1i);
  const p2 = 2 * (x1r * x1r + x1i * x1i + xr * x2r + xi * x2i);
  if (p <= 0) return { p, d1: 0, d2: 0 };
  return { p, d1: p1 / p, d2: (p2 * p - p1 * p1) / (p * p) };
}

/** Newton search for the local maximum of log|X(ω)|² near omega0. Null if it wanders off. */
function peakSearch(y: Float64Array, W: number, omega0: number): { omega: number; amp: number } | null {
  const bin = (2 * Math.PI) / W;
  const maxStep = 0.5 * bin;
  let omega = omega0;
  let ev = evalSpectrum(y, W, omega);
  for (let iter = 0; iter < 12; iter++) {
    let step: number;
    if (ev.d2 < 0) step = -ev.d1 / ev.d2;
    else step = ev.d1 > 0 ? maxStep : -maxStep; // not concave here: walk uphill
    if (step > maxStep) step = maxStep;
    else if (step < -maxStep) step = -maxStep;
    omega += step;
    if (Math.abs(omega - omega0) > 2 * bin || omega <= 0 || omega >= Math.PI) return null;
    ev = evalSpectrum(y, W, omega);
    if (Math.abs(step) < 1e-6 * bin) break;
  }
  if (!(ev.d2 < 0)) return null;
  return { omega, amp: Math.sqrt(ev.p) };
}

/** Harmonics used for the weak-fundamental fallback. */
const MAX_HARMONIC = 4;
/** Harmonics inspected by the sub-multiple guard. */
const GUARD_HARMONICS = 12;
/** Largest period multiple the guard can undo (MPM picking d·period). */
const GUARD_MAX_DIVISOR = 6;

let specRe = new Float64Array(0);
let specIm = new Float64Array(0);

interface Spectrum {
  /** |X|² on a ≥2×-zero-padded grid (N points), bins 0..N/2. */
  pow: Float64Array;
  /** Hz per grid bin (fs / N). */
  binHz: number;
  /** Grid bins per analysis bin (N / W, ≥ 2). */
  zoom: number;
  /** Highest usable grid bin. */
  top: number;
  y: Float64Array;
  W: number;
  fs: number;
}

/** Amplitude of the strongest grid bin within f·(1 ± rel) (at least ±1 grid bin). */
function ampAt(sp: Spectrum, f: number, rel: number): number {
  const last = sp.top;
  const lo = Math.max(1, Math.min(Math.floor((f * (1 - rel)) / sp.binHz), Math.round(f / sp.binHz) - 1));
  const hi = Math.min(last, Math.max(Math.ceil((f * (1 + rel)) / sp.binHz), Math.round(f / sp.binHz) + 1));
  let best = 0;
  for (let k = lo; k <= hi; k++) if (sp.pow[k] > best) best = sp.pow[k];
  return Math.sqrt(best);
}

/**
 * Strongest spectral peak within f·(1 ± rel) (at least ±1.5 analysis bins), refined by Newton.
 * Null if the range holds no genuine local maximum (e.g. only the flank of a bigger peak).
 */
function peakNear(sp: Spectrum, f: number, rel: number): { f: number; amp: number } | null {
  const minHalf = Math.ceil(1.5 * sp.zoom); // ±1.5 analysis bins
  const c = f / sp.binHz;
  const lo = Math.max(1, Math.floor(Math.min(c * (1 - rel), c - minHalf)));
  const hi = Math.min(sp.top, Math.ceil(Math.max(c * (1 + rel), c + minHalf)));
  if (hi <= lo) return null;
  let k = lo;
  for (let i = lo + 1; i <= hi; i++) if (sp.pow[i] > sp.pow[k]) k = i;
  if (!(sp.pow[k] > sp.pow[k - 1] && sp.pow[k] >= sp.pow[k + 1])) return null;
  const pk = peakSearch(sp.y, sp.W, (2 * Math.PI * k * sp.binHz) / sp.fs);
  return pk ? { f: (pk.omega * sp.fs) / (2 * Math.PI), amp: pk.amp } : null;
}

interface Refined {
  frequency: number;
  /** Harmonic energy fraction of the result (spectral confidence 0..1). */
  hef: number;
}

function refine(samples: Float32Array, W: number, fs: number, fc: number, minF: number): Refined | null {
  const sp = buildSpectrum(samples, W, fs);
  if (!sp) return null;
  const f = estimateF0(sp, fc);
  if (f === null) return null;
  return { frequency: f, hef: harmonicEnergyFraction(sp, f, minF) };
}

/**
 * Fraction of the spectral energy (above minF) that lies on the harmonic series of f.
 * ≈1 for a clean tone, ≈SNR/(1+SNR) in noise, ≈ its share of the energy for one note of a
 * chord. Unlike the NSDF value it is not depressed by a second simultaneous note's
 * *interaction* with the first, only by that note's energy.
 */
function harmonicEnergyFraction(sp: Spectrum, f: number, minF: number): number {
  const kMin = Math.max(1, Math.floor(minF / sp.binHz));
  const kMax = Math.floor(sp.top * 0.95);
  let total = 0;
  for (let k = kMin; k <= kMax; k++) total += sp.pow[k];
  if (total <= 0) return 0;
  const spacing = f / sp.binHz;
  const halfWidth = Math.min(3 * sp.zoom, Math.floor(spacing / 2)); // ±3 analysis bins (BH4 main lobe)
  let harm = 0;
  for (let h = 1; h <= 16; h++) {
    const c = Math.round((h * f) / sp.binHz);
    if (c + halfWidth > kMax) break;
    for (let k = Math.max(kMin, c - halfWidth); k <= c + halfWidth; k++) harm += sp.pow[k];
  }
  return Math.min(1, harm / total);
}

function buildSpectrum(samples: Float32Array, W: number, fs: number): (Spectrum & { globalMax: number }) | null {
  // Windowed, demeaned segment.
  const start = samples.length - W;
  const win = blackmanHarris(W);
  if (winBuf.length < W) winBuf = new Float64Array(W);
  const y = winBuf;
  let mean = 0;
  for (let i = 0; i < W; i++) mean += samples[start + i];
  mean /= W;
  for (let i = 0; i < W; i++) y[i] = (samples[start + i] - mean) * win[i];

  // Coarse power spectrum on a 2× zero-padded grid: used to *locate* peaks (the coarse MPM
  // estimate can be off by up to ~10 % on strongly inharmonic tones) and to compare
  // harmonic strengths. Exact peak positions come from the Newton search on the DTFT.
  const N = nextPowerOfTwo(2 * W);
  if (specRe.length !== N) {
    specRe = new Float64Array(N);
    specIm = new Float64Array(N);
  }
  specRe.fill(0);
  specIm.fill(0);
  specRe.set(y.subarray(0, W));
  fft(specRe, specIm);
  const half = N / 2;
  for (let k = 0; k <= half; k++) specRe[k] = specRe[k] * specRe[k] + specIm[k] * specIm[k];
  let globalMax = 0;
  for (let k = 1; k < half * 0.95; k++) if (specRe[k] > globalMax) globalMax = specRe[k];
  if (globalMax <= 0) return null;
  return { pow: specRe, binHz: fs / N, zoom: N / W, top: half - 1, y, W, fs, globalMax };
}

/** Exact f0 near the coarse estimate fc, with octave / sub-multiple / mixture guards. */
function estimateF0(sp: Spectrum & { globalMax: number }, fc: number): number | null {
  const fs = sp.fs;
  const globalMax = sp.globalMax;

  // 1. Snap to the strongest spectral peak within ±10 % of the coarse estimate. An inharmonic
  //    mode (kalimba: ≈5–7·f0) can shift MPM's peak by several percent; the true fundamental
  //    is still the dominant peak nearby.
  let fund = peakNear(sp, fc, 0.1);
  let fRef = fund && fund.amp * fund.amp >= 0.0025 * globalMax ? fund.f : fc;

  // 2. Sub-multiple guard: MPM sometimes picks d·period (d = 2 at high notes where few samples
  //    per period blunt the NSDF peak; d up to ~6 when a strong inharmonic mode makes the
  //    waveform repeat only every few periods). Then the candidate's harmonics that are NOT
  //    multiples of d are ~absent. Undo the smallest such d.
  const H = Math.min(GUARD_HARMONICS, Math.floor((0.45 * fs) / fRef));
  if (H >= 2) {
    const amp2: number[] = [0];
    for (let h = 1; h <= H; h++) {
      const a = ampAt(sp, h * fRef, 0.015);
      amp2.push(a * a);
    }
    for (let d = 2; d <= Math.min(GUARD_MAX_DIVISOR, H); d++) {
      // Only harmonics up to 2·d: enough evidence, and an inharmonic mode (≥ 5·f0 = ≥ 5d·fc)
      // can never fall into the "other" set and veto the correction.
      let mult = 0;
      let other = 0;
      for (let h = 1; h <= Math.min(H, 2 * d); h++) {
        if (h % d === 0) mult += amp2[h];
        else other += amp2[h];
      }
      // The new fundamental (harmonic d of the candidate) must itself be a real component.
      // For d = 2 we accept up to −10 dB of odd-harmonic energy: that also resolves "new note
      // an octave above a previous one that is still ringing" (C4 fading + fresh C5 looks like
      // a C4 with a dominant 2nd harmonic) in favour of the louder, newer note. A tone whose
      // odd harmonics are all that weak is perceived at the upper octave anyway.
      const maxOther = d === 2 ? 0.1 : 0.01;
      if (amp2[d] >= 0.001 * globalMax && mult >= 0.05 * globalMax && other < maxOther * mult) {
        fund = peakNear(sp, d * fRef, 0.03);
        fRef = fund ? fund.f : d * fRef;
        break;
      }
    }
  }

  // 3. Common-subharmonic guard: two simultaneous notes (a previous tine still ringing) make
  //    the waveform repeat only at a long common period, so MPM can return a "virtual" pitch
  //    with no energy at all (C4 + E4 → C2). Unless the candidate's fundamental is really
  //    present, or harmonics 2 and 3 are both strong (a genuine missing-fundamental tone),
  //    re-centre on its strongest component — in practice the louder, usually newest, note.
  {
    const Hs = Math.min(GUARD_HARMONICS, Math.floor((0.45 * fs) / fRef));
    let strongestH = 1;
    let strongestA = 0;
    const a: number[] = [0];
    for (let h = 1; h <= Hs; h++) {
      const v = ampAt(sp, h * fRef, 0.015);
      a.push(v);
      if (v > strongestA) {
        strongestA = v;
        strongestH = h;
      }
    }
    const fundPresent = a[1] >= 0.03 * strongestA;
    const missingFundamental = Hs >= 3 && a[2] >= 0.1 * strongestA && a[3] >= 0.1 * strongestA;
    if (strongestH > 1 && !fundPresent && !missingFundamental) {
      const pk = peakNear(sp, strongestH * fRef, 0.03);
      if (pk) {
        fund = pk;
        fRef = pk.f;
      }
    }
  }

  // 4. Normal case: the fundamental is a clear spectral peak — use it alone. (Upper partials
  //    of stiff strings are slightly sharp, so the fundamental is the honest reading.)
  const amps: number[] = [fund ? fund.amp : 0];
  let maxAmp = amps[0];
  for (let h = 2; h <= MAX_HARMONIC; h++) {
    const a = h * fRef < 0.45 * fs ? ampAt(sp, h * fRef, 0.01) : 0;
    amps.push(a);
    if (a > maxAmp) maxAmp = a;
  }
  if (fund && fund.amp >= 0.5 * maxAmp) return fund.f;

  // 5. Weak fundamental: refine the strong harmonics and combine f_h/h weighted by amplitude²,
  //    keeping only estimates that agree within a few cents (an inharmonic partial can never
  //    pull the result).
  const cands: { f: number; a: number }[] = [];
  if (fund) cands.push({ f: fund.f, a: fund.amp });
  for (let h = 2; h <= MAX_HARMONIC; h++) {
    if (amps[h - 1] < 0.25 * maxAmp) continue;
    const pk = peakNear(sp, h * fRef, 0.01);
    if (pk) cands.push({ f: pk.f / h, a: pk.amp });
  }
  if (cands.length === 0) return null;
  let ref = cands[0];
  for (const cnd of cands) if (cnd.a > ref.a) ref = cnd;
  let sw = 0;
  let sf = 0;
  for (const cnd of cands) {
    if (Math.abs(1200 * Math.log2(cnd.f / ref.f)) > 8) continue;
    const w = cnd.a * cnd.a;
    sw += w;
    sf += w * cnd.f;
  }
  return sf / sw;
}
