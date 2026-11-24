/*
 * Mains-hum canceller — pure, frame-driven (the caller supplies time), no Web Audio.
 *
 * Why: a cheap mic / interface in a quiet room often picks up a steady low tone — mains hum at
 * 50/60 Hz and harmonics (100/120 Hz …). Left alone it (a) reads as a note ("G1") although
 * nothing is played, and (b) masks quiet plucks: the detector locks on the louder, steady hum
 * instead of a fading kalimba tine on top of it.
 *
 * How:
 *  1. LEARN. A low pitch (< ~135 Hz) that the detector reports steadily (±12 c) for ≥ 700 ms
 *     WITHOUT having started with a level rise is not a played note — plucked / bowed / sung
 *     notes start with an attack — so it is taken as a stationary hum at f_h.
 *     (The stabiliser independently refuses to *display* such no-attack low pitches; see
 *     `lowNoteHz` in stabilizer.ts. This class removes them so quieter notes become visible.)
 *  2. CANCEL. Every frame, hum harmonics h·f_h up to `fitMaxHz` (+ DC) are fitted to the
 *     analysis window by exact least squares (precomputed Gram inverse; the hum is stationary
 *     over the ~170 ms window) and subtracted before pitch detection.
 *     Per harmonic, the fitted amplitude is compared with the amplitude learnt while only hum
 *     was present: if it is much larger, a real note sits on/near that harmonic (e.g. a bass
 *     string at ~50 Hz, or a kalimba tine close to 250 Hz) and that harmonic is left alone,
 *     so a played note is never subtracted by the canceller. While the stabiliser tracks a
 *     note close to a hum harmonic, the note itself is part of the fit (sinusoid with a
 *     linearly changing amplitude), so the hum estimate is not contaminated by the note and
 *     its removal does not bias the reading.
 *  3. FORGET. When the fitted hum stays well below its learnt amplitude for a few seconds
 *     (hum gone, or mains frequency drifted), the model is dropped and re-learnt if needed.
 */

import type { PitchDetection } from './detect.ts';

export interface HumOptions {
  /** Highest frequency a hum fundamental (as reported by the detector) may have. */
  maxHumHz: number;
  /** A steady, attack-less low pitch must persist this long to be learnt as hum. */
  learnMs: number;
  /** Frames within this distance (cents) of the run's pitch continue the run. */
  runCents: number;
  /** Max gap (ms) between agreeing frames inside one run. */
  maxGapMs: number;
  /** A run that starts this many dB above the preceding level is a played note (never hum). */
  riseDb: number;
  /** Look-back window (ms) for that preceding level. */
  riseLookbackMs: number;
  /** Fit / subtract hum harmonics up to this frequency. */
  fitMaxHz: number;
  maxHarmonics: number;
  /** A harmonic whose fitted amplitude exceeds ratio × learnt (+ eps) holds a note: keep it. */
  consistentRatio: number;
  consistentEps: number;
  /** Closer than this many fit bins (fs / window) a note and a hum harmonic are inseparable… */
  nearBins: number;
  /** …and within this many bins a reading is dropped unless the note is clearly louder than
   *  the hum there (so that the hum pulls it by at most `maxBiasCents`). */
  maskBins: number;
  maxBiasCents: number;
  /** A tracked note this close (Hz) to a hum harmonic is fitted jointly with the hum. */
  jointHz: number;
  /** Forget the model after the hum has been (nearly) absent this long. */
  forgetMs: number;
}

export const DEFAULT_HUM_OPTIONS: HumOptions = {
  maxHumHz: 135,
  learnMs: 700,
  runCents: 12,
  maxGapMs: 150,
  riseDb: 6,
  riseLookbackMs: 300,
  fitMaxHz: 400,
  maxHarmonics: 8,
  consistentRatio: 2,
  consistentEps: 2e-5,
  nearBins: 1,
  maskBins: 1.5,
  maxBiasCents: 1.5,
  jointHz: 40,
  forgetMs: 3000,
};

interface Run {
  start: number;
  last: number;
  ref: number; // cents re A4 of the first frame
  freqs: number[];
  played: boolean;
}

interface Model {
  hz: number;
  length: number;
  harmonics: number;
  /** Basis vectors: [cos h=1, sin h=1, cos h=2, …, DC]. */
  basis: Float32Array[];
  /** Gram matrix of the basis and its inverse (row-major, n×n). */
  gram: Float64Array;
  inv: Float64Array;
  /** Learnt per-harmonic amplitude (EMA while consistent) and at learn time. */
  amp: Float64Array;
  amp0: Float64Array;
  /** 1 for harmonics that carry a meaningful part of the hum. */
  present: Uint8Array;
  initialised: boolean;
  quietSince: number | null;
}

const cents = (f: number): number => 1200 * Math.log2(f / 440);

function invert(a: Float64Array, n: number): Float64Array | null {
  // Gauss–Jordan with partial pivoting on [A | I].
  const m = new Float64Array(n * 2 * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) m[r * 2 * n + c] = a[r * n + c];
    m[r * 2 * n + n + r] = 1;
  }
  const w = 2 * n;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r * w + col]) > Math.abs(m[piv * w + col])) piv = r;
    const p = m[piv * w + col];
    if (Math.abs(p) < 1e-9) return null;
    if (piv !== col) {
      for (let c = 0; c < w; c++) {
        const t = m[col * w + c];
        m[col * w + c] = m[piv * w + c];
        m[piv * w + c] = t;
      }
    }
    for (let c = 0; c < w; c++) m[col * w + c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r * w + col];
      if (f === 0) continue;
      for (let c = 0; c < w; c++) m[r * w + c] -= f * m[col * w + c];
    }
  }
  const inv = new Float64Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) inv[r * n + c] = m[r * w + n + c];
  return inv;
}

export class HumCanceller {
  readonly options: HumOptions;
  private readonly fs: number;
  private run: Run | null = null;
  private hist: { time: number; db: number }[] = [];
  private model: Model | null = null;
  private out = new Float32Array(0);
  private coef = new Float64Array(0);
  private proj = new Float64Array(0);
  private noteCols: Float32Array[] = [];
  private fitAmp = new Float64Array(0);
  private keep = new Uint8Array(0);
  /** Model used by the last `clean` call (null if none ran), for `isHum`. */
  private lastFit: Model | null = null;
  private lastCleanTime = NaN;

  constructor(sampleRate: number, options: Partial<HumOptions> = {}) {
    this.fs = sampleRate;
    this.options = { ...DEFAULT_HUM_OPTIONS, ...options };
  }

  /** Frequency of the modelled hum (Hz), or null. */
  get frequency(): number | null {
    return this.model?.hz ?? null;
  }

  reset(): void {
    this.run = null;
    this.hist = [];
    this.model = null;
    this.lastFit = null;
  }

  /**
   * Returns `samples` with the modelled hum removed (a scratch buffer, valid until the next
   * call), or `samples` itself when no hum is modelled.
   */
  clean(samples: Float32Array, time: number, noteHz: number | null = null): Float32Array {
    const md = this.model;
    this.lastFit = null;
    if (!md) return samples;
    const L = samples.length;
    if (md.length !== L) {
      this.model = this.buildModel(md.hz, L);
      if (!this.model) return samples;
      return this.clean(samples, time, noteHz);
    }
    const again = time === this.lastCleanTime; // second pass of the same frame: no state updates
    this.lastCleanTime = time;
    const o = this.options;
    const H = md.harmonics;
    const nh = md.basis.length;

    // 1. Hum-only least-squares fit (precomputed inverse): per-harmonic amplitudes.
    const b = this.dots(md.basis, samples, 0);
    const c = this.solve(md.inv, b, nh, 0);
    if (this.fitAmp.length < H) this.fitAmp = new Float64Array(H);
    const fitAmp = this.fitAmp;
    let total = 0;
    let total0 = 0;
    for (let h = 0; h < H; h++) {
      const a = Math.hypot(c[2 * h], c[2 * h + 1]);
      if (!md.initialised && !again) {
        md.amp[h] = a;
        md.amp0[h] = a;
      }
      fitAmp[h] = a;
      total += a;
      total0 += md.amp0[h];
    }
    if (!md.initialised && !again) {
      // Harmonics carrying hardly any hum are never touched (no joint fit, no subtraction).
      let max = 0;
      for (let h = 0; h < H; h++) max = Math.max(max, md.amp0[h]);
      for (let h = 0; h < H; h++) md.present[h] = md.amp0[h] >= Math.max(0.05 * max, 3 * o.consistentEps) ? 1 : 0;
    }
    md.initialised = true;
    this.lastFit = md;
    if (again) {
      /* timers already updated this frame */
    } else if (total < 0.25 * total0) {
      md.quietSince ??= time;
      if (time - md.quietSince >= o.forgetMs) {
        this.model = null;
        this.lastFit = null;
        return samples;
      }
    } else {
      md.quietSince = null;
    }

    // 2. Which harmonics to remove. A harmonic carrying much more than its learnt hum
    //    amplitude holds a note: keep it. A harmonic (nearly) on top of the tracked note cannot
    //    be separated from it within one window: keep it too (`isHum` then tells when the
    //    note has decayed into it).
    const keep = this.keep.length >= H ? this.keep : (this.keep = new Uint8Array(H));
    let joint = false;
    for (let h = 0; h < H; h++) {
      if (!md.present[h]) {
        keep[h] = 1; // (practically) no hum there: nothing to remove
        continue;
      }
      const consistent = fitAmp[h] <= o.consistentRatio * md.amp[h] + o.consistentEps;
      const d = noteHz !== null && noteHz > 0 ? Math.abs((h + 1) * md.hz - noteHz) : Infinity;
      keep[h] = d < (o.nearBins * this.fs) / L ? 1 : 0;
      if (d < o.jointHz && !keep[h]) joint = true; // near the note: fit note + hum together
      else if (!consistent) keep[h] = 1;
      if (consistent && d >= o.jointHz && !again) md.amp[h] += 0.03 * (fitAmp[h] - md.amp[h]);
    }

    // 3. Joint fit when the tracked note is close to a removable harmonic: the note (a
    //    sinusoid with linearly changing amplitude, i.e. a decaying tine) is fitted together
    //    with the hum so the hum estimate does not absorb part of it.
    let coef = c;
    const cols: Float32Array[] = [];
    const idx: number[] = []; // basis index → column
    if (joint) {
      for (let h = 0; h < H; h++) {
        if (keep[h]) continue;
        idx[2 * h] = cols.length;
        cols.push(md.basis[2 * h]);
        idx[2 * h + 1] = cols.length;
        cols.push(md.basis[2 * h + 1]);
      }
      cols.push(md.basis[nh - 1], ...this.noteColumns(noteHz!, L));
      const n = cols.length;
      const g = new Float64Array(n * n);
      for (let r = 0; r < n; r++) {
        for (let k = r; k < n; k++) {
          const x = cols[r];
          const y = cols[k];
          let v = 0;
          for (let i = 0; i < L; i++) v += x[i] * y[i];
          g[r * n + k] = v;
          g[k * n + r] = v;
        }
      }
      const gi = invert(g, n);
      if (gi) coef = this.solve(gi, this.dots(cols, samples, nh), n, nh);
      else joint = false;
    }

    if (this.out.length !== L) this.out = new Float32Array(L);
    const out = this.out;
    out.set(samples);
    for (let h = 0; h < H; h++) {
      if (keep[h]) continue;
      const cc = joint ? coef[idx[2 * h]] : coef[2 * h];
      const cs = joint ? coef[idx[2 * h + 1]] : coef[2 * h + 1];
      const vc = md.basis[2 * h];
      const vs = md.basis[2 * h + 1];
      for (let i = 0; i < L; i++) out[i] -= cc * vc[i] + cs * vs[i];
    }
    return out;
  }

  /**
   * True if a pitch at `hz` sits on a hum harmonic that the last `clean` had to leave in place
   * and the note there is not clearly louder than the learnt hum: then the reading is the hum
   * itself, or a note so weak that the unresolved hum would pull it by more than ~1.5 cents.
   */
  isHum(hz: number): boolean {
    const md = this.lastFit;
    if (!md || hz <= 0) return false;
    const h = Math.round(hz / md.hz);
    if (h < 1 || h > md.harmonics || !md.present[h - 1] || !this.keep[h - 1]) return false;
    const o = this.options;
    const df = Math.abs(hz - h * md.hz);
    const T = md.length / this.fs;
    if (df * T >= o.maskBins) return false;
    // Two unresolved components pull the reading by up to ≈ (A_hum / A_note) · Δf: allow
    // ≤ maxBiasCents (conservative: the fitted amplitude here under-reads an offset note).
    const ratio = Math.max(o.consistentRatio, (1731 * df) / (hz * o.maxBiasCents));
    return this.fitAmp[h - 1] <= ratio * md.amp[h - 1] + o.consistentEps;
  }

  private dots(cols: Float32Array[], x: Float32Array, offset: number): Float64Array {
    const n = cols.length;
    if (this.proj.length < offset + n) {
      const p = new Float64Array(offset + n);
      p.set(this.proj);
      this.proj = p;
    }
    const L = x.length;
    for (let j = 0; j < n; j++) {
      const v = cols[j];
      let s = 0;
      for (let i = 0; i < L; i++) s += v[i] * x[i];
      this.proj[offset + j] = s;
    }
    return this.proj;
  }

  private solve(inv: Float64Array, b: Float64Array, n: number, offset: number): Float64Array {
    if (this.coef.length < offset + n) {
      const c = new Float64Array(offset + n);
      c.set(this.coef);
      this.coef = c;
    }
    const out = this.coef.subarray(offset, offset + n);
    for (let r = 0; r < n; r++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += inv[r * n + k] * b[offset + k];
      out[r] = s;
    }
    return out;
  }

  /** [cos, sin, t·cos, t·sin] of the note (scratch arrays, reused). */
  private noteColumns(hz: number, L: number): Float32Array[] {
    if (this.noteCols.length !== 4 || this.noteCols[0].length !== L) {
      this.noteCols = [0, 1, 2, 3].map(() => new Float32Array(L));
    }
    const [vc, vs, tc, ts] = this.noteCols;
    const w = (2 * Math.PI * hz) / this.fs;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    let cr = 1;
    let sr = 0;
    for (let i = 0; i < L; i++) {
      const t = (2 * i) / (L - 1) - 1; // −1 … 1 keeps the system well conditioned
      vc[i] = cr;
      vs[i] = sr;
      tc[i] = t * cr;
      ts[i] = t * sr;
      const nc = cr * cw - sr * sw;
      sr = sr * cw + cr * sw;
      cr = nc;
    }
    return this.noteCols;
  }

  /** Feed back this frame's raw detection (made on the cleaned signal) and raw input level (dBFS). */
  observe(detection: PitchDetection | null, db: number, time: number): void {
    const o = this.options;
    while (this.hist.length > 0 && time - this.hist[0].time > o.riseLookbackMs) this.hist.shift();
    let before = Infinity;
    for (const r of this.hist) if (r.db < before) before = r.db;
    this.hist.push({ time, db });

    const f = detection?.frequency ?? 0;
    const low = detection !== null && f > 0 && f <= o.maxHumHz && detection.clarity >= 0.5;
    let run = this.run;
    if (run && time - run.last > o.maxGapMs) run = this.run = null;
    if (!low) return;
    const c = cents(f);
    if (!run || Math.abs(c - run.ref) > o.runCents) {
      // A run starting with a level rise is a played note: never learn it as hum.
      run = this.run = { start: time, last: time, ref: c, freqs: [], played: db - before >= o.riseDb };
    }
    run.last = time;
    run.freqs.push(f);
    if (run.freqs.length > 64) run.freqs.shift();
    if (run.played || time - run.start < o.learnMs) return;
    const sorted = run.freqs.slice().sort((a, b) => a - b);
    const hz = sorted[sorted.length >> 1];
    if (this.model && Math.abs(cents(hz) - cents(this.model.hz)) < 2) return;
    this.model = this.buildModel(hz, this.model?.length ?? 0);
    this.run = null;
  }

  private buildModel(hz: number, length: number): Model | null {
    const o = this.options;
    const H = Math.max(1, Math.min(o.maxHarmonics, Math.floor(o.fitMaxHz / hz)));
    const m: Model = {
      hz,
      length,
      harmonics: H,
      basis: [],
      gram: new Float64Array(0),
      inv: new Float64Array(0),
      amp: new Float64Array(H),
      amp0: new Float64Array(H),
      present: new Uint8Array(H),
      initialised: false,
      quietSince: null,
    };
    if (length === 0) return m; // built lazily once the window length is known
    for (let h = 1; h <= H; h++) {
      const w = (2 * Math.PI * h * hz) / this.fs;
      const vc = new Float32Array(length);
      const vs = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        vc[i] = Math.cos(w * i);
        vs[i] = Math.sin(w * i);
      }
      m.basis.push(vc, vs);
    }
    m.basis.push(new Float32Array(length).fill(1));
    const nb = m.basis.length;
    const g = new Float64Array(nb * nb);
    for (let r = 0; r < nb; r++) {
      for (let k = r; k < nb; k++) {
        let s = 0;
        const a = m.basis[r];
        const b = m.basis[k];
        for (let i = 0; i < length; i++) s += a[i] * b[i];
        g[r * nb + k] = s;
        g[k * nb + r] = s;
      }
    }
    const inv = invert(g, nb);
    if (!inv) return null;
    m.gram = g;
    m.inv = inv;
    return m;
  }
}
