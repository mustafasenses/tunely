/*
 * Pitch stabiliser — pure, frame-driven state machine (no timers; the caller supplies time).
 *
 * Raw per-frame detections → stable readings:
 *  • Level gate with hysteresis (absolute dBFS thresholds, raised relative to a slowly
 *    adapting noise-floor estimate in noisy rooms).
 *  • Clarity gate with hysteresis: continuing the current note needs clarity ≥ 0.6 (a
 *    decaying tine gets noisier); a new note needs ≥ 0.8 over 2 frames, or ≥ 0.65 over 3
 *    frames (two tines ringing together lower the clarity of the mix).
 *  • Onset guard: right after a sudden level rise (pluck / strike) the analysis window holds
 *    the attack transient — noise burst, click, and on a kalimba an inharmonic mode that can
 *    briefly dominate. Those frames can look periodic (clarity ≈ 0.85–0.93) yet be wrong, so
 *    for ~60 ms after an onset only very clear frames (≥ 0.95) are used. For the next ~400 ms
 *    a new note may then be acquired down to clarity 0.5 (3 frames): we know a note was just
 *    struck, and the previous one still ringing is what lowers the clarity.
 *  • Note tracking in the log-frequency (cents) domain. Frames within ±50 c of the live
 *    track continue it; anything else is a *candidate* that must be confirmed by consecutive
 *    agreeing frames — 2 for an ordinary note change, 3 for jumps ≥ 1000 c (the classic
 *    detector failure modes: octave errors, a kalimba's inharmonic mode, attack garbage).
 *    A single spurious frame therefore never reaches the display.
 *  • Smoothing: median of the last 5 accepted frames (outlier rejection), then an adaptive
 *    exponential smoother (τ 200 ms while steady, down to 50 ms once the pitch moves ≥ 4 c).
 *    Confirming a new note, or re-plucking after a gap, starts a fresh track, so there is no
 *    lag on genuine note changes.
 *  • Low notes (< ~130 Hz) only start a track after an attack: the level must be ≥ 8 dB above
 *    its minimum over the last second (any pluck / strike / bow or voice onset). Mains hum (50/60 Hz and
 *    its 100/120 Hz harmonics) is a steady low tone with no attack, so it never becomes a
 *    displayed note; a plucked / bowed / sung bass note is tuned normally through its whole
 *    sustain (continuing a live track never needs an attack). See also hum.ts.
 *  • Noise floor: learnt only from analysed, non-silent frames that are not a confident pitch
 *    (muted / stalled-input frames and digital silence never pull it down). Learning is fast
 *    for `floorLearnMs` after the first real audio, and again after a long input gap.
 *  • Holding: when the signal drops (gate closes / clarity lost), the last good reading is
 *    reported as `detected` for a 100 ms grace (no flicker), then `holding` until 1.5 s after
 *    the last good frame, then `listening`.
 */

import type { PitchReading, TunerStatus } from './types.ts';
import type { PitchDetection } from './detect.ts';
import { rmsToDb } from './level.ts';

export interface StabilizerOptions {
  /** Gate opens at/above this RMS level (dBFS)… */
  gateOpenDb: number;
  /** …and closes below this one (hysteresis). */
  gateCloseDb: number;
  /** In noisy rooms the gate opens only this far above the estimated noise floor… */
  floorOpenMarginDb: number;
  /** …and closes this far above it. */
  floorCloseMarginDb: number;
  /** Max rate at which the noise-floor estimate may rise (it falls instantly)… */
  floorRiseDbPerSec: number;
  /** …and during the first `floorLearnMs` after start/reset, to learn the room quickly. */
  floorLearnRiseDbPerSec: number;
  floorLearnMs: number;
  /** Clarity for starting / switching to a note with `confirmFrames` frames… */
  acquireClarity: number;
  /** …or with `lowClarityConfirmFrames` frames down to this clarity (chords, weak notes). */
  minAcquireClarity: number;
  lowClarityConfirmFrames: number;
  /**
   * For this long after an onset (once the attack guard is over) a new note may be acquired
   * down to `postOnsetClarity` (with `lowClarityConfirmFrames`): the onset tells us a new note
   * was struck, and the previous one still ringing lowers the clarity of the mixture.
   */
  postOnsetMs: number;
  postOnsetClarity: number;
  /** Clarity needed to continue the current note. */
  sustainClarity: number;
  /** Clarity needed for any frame shortly after an onset. */
  attackClarity: number;
  /** How long after a detected onset `attackClarity` applies (ms). */
  attackMs: number;
  /** Level rise (dB) over the recent minimum that counts as an onset. */
  onsetRiseDb: number;
  /** Window for that recent minimum (ms). */
  onsetLookbackMs: number;
  /** Frames within this distance (cents) of the current note continue it. */
  sameNoteCents: number;
  /** Candidate frames must agree with each other within this many cents. */
  candidateCents: number;
  /** Consecutive agreeing frames needed to (re)start a note. */
  confirmFrames: number;
  /** …needed when jumping ≥ ~an octave away from the current/held note. */
  jumpConfirmFrames: number;
  /** Median filter length (frames). */
  medianSize: number;
  /** Exponential smoothing time constant (ms) when the pitch is moving (≥ `steadyCents` off)… */
  smoothingMs: number;
  /** …blending up to this one when it is steady (calm display without lag on real changes). */
  steadySmoothingMs: number;
  steadyCents: number;
  /** Keep reporting `detected` for this long over brief dropouts (avoids UI flicker). */
  graceMs: number;
  /** Keep the last reading as `holding` for this long after the last good frame. */
  holdMs: number;
  /** After a gap longer than this the note must be re-confirmed (fresh median/smoothing). */
  historyResetMs: number;
  /** Candidates below this frequency need an attack to start a new track (hum rejection). */
  lowNoteHz: number;
  /** Attack = level ≥ this many dB above its minimum over the last `lowNoteLookbackMs`. */
  lowNoteRiseDb: number;
  lowNoteLookbackMs: number;
  /** Clarity a new low note needs (rumble / wind noise looks weakly periodic down there). */
  lowNoteClarity: number;
  /** A low note held/lost for at most this long may be re-acquired without a new attack. */
  lowNoteRelinkMs: number;
  /** After this long without analysed input (muted, stalled), re-learn the floor quickly. */
  relearnAfterMs: number;
}

/** Below this (dBFS) a frame is digital silence (zeros from a starting / muted device). */
export const SILENCE_DB = -120;

export const DEFAULT_STABILIZER_OPTIONS: StabilizerOptions = {
  gateOpenDb: -56,
  gateCloseDb: -62,
  floorOpenMarginDb: 10,
  floorCloseMarginDb: 5,
  floorRiseDbPerSec: 6,
  floorLearnRiseDbPerSec: 30,
  floorLearnMs: 2000,
  acquireClarity: 0.8,
  minAcquireClarity: 0.65,
  lowClarityConfirmFrames: 3,
  postOnsetMs: 400,
  postOnsetClarity: 0.5,
  sustainClarity: 0.6,
  attackClarity: 0.95,
  attackMs: 60,
  onsetRiseDb: 9,
  onsetLookbackMs: 100,
  sameNoteCents: 50,
  candidateCents: 30,
  confirmFrames: 2,
  jumpConfirmFrames: 3,
  medianSize: 5,
  smoothingMs: 50,
  steadySmoothingMs: 200,
  steadyCents: 4,
  graceMs: 100,
  holdMs: 1500,
  historyResetMs: 150,
  lowNoteHz: 130,
  lowNoteRiseDb: 8,
  lowNoteLookbackMs: 1000,
  lowNoteClarity: 0.8,
  lowNoteRelinkMs: 600,
  relearnAfterMs: 1000,
};

export interface StabilizerInput {
  /** Timestamp in ms (e.g. performance.now()). Must be non-decreasing. */
  time: number;
  /** RMS of the newest audio (linear, full scale = 1). */
  rms: number;
  /** Raw detector output for this frame (null = nothing found / not run). */
  detection: PitchDetection | null;
  /**
   * True when the input was not analysed this frame (muted for a reference tone, no fresh
   * audio from a suspended / interrupted device). Only the grace / hold timers advance: the
   * gate, onset history and noise floor are left untouched.
   */
  ignored?: boolean;
}

export interface StabilizerOutput {
  status: TunerStatus;
  reading: PitchReading | null;
}

interface Track {
  /** Smoothed pitch in cents relative to A4 = 440 Hz (the stabiliser is reference-agnostic). */
  cents: number;
  clarity: number;
  history: number[];
  lastGood: number;
}

const JUMP_CENTS = 1000;

export function hzToCents(f: number): number {
  return 1200 * Math.log2(f / 440);
}

export function centsToHz(c: number): number {
  return 440 * Math.pow(2, c / 1200);
}

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

export class PitchStabilizer {
  readonly options: StabilizerOptions;
  private track: Track | null = null;
  /** Consecutive agreeing candidate frames for a new note. */
  private pending: { cents: number; clarity: number }[] = [];
  private gateOpen = false;
  private floorDb: number;
  private lastTime: number | null = null;
  private firstTime: number | null = null;
  private recentDb: { time: number; db: number }[] = [];
  /** Level history (silence clamped to SILENCE_DB) for the low-note attack test. */
  private levelHist: { time: number; db: number }[] = [];
  private ignoredSince: number | null = null;
  private attackUntil = -Infinity;
  private lastOnset = -Infinity;

  constructor(options: Partial<StabilizerOptions> = {}) {
    this.options = { ...DEFAULT_STABILIZER_OPTIONS, ...options };
    this.floorDb = this.options.gateCloseDb - 10;
  }

  reset(): void {
    this.track = null;
    this.pending = [];
    this.gateOpen = false;
    this.floorDb = this.options.gateCloseDb - 10;
    this.lastTime = null;
    this.firstTime = null;
    this.recentDb = [];
    this.levelHist = [];
    this.ignoredSince = null;
    this.attackUntil = -Infinity;
    this.lastOnset = -Infinity;
  }

  /** Current noise-floor estimate (dBFS). */
  get noiseFloorDb(): number {
    return this.floorDb;
  }

  /** True if a frame at this level could not open/keep the gate (lets callers skip detection). */
  isBelowGate(db: number): boolean {
    return db < this.options.gateCloseDb;
  }

  push(input: StabilizerInput): StabilizerOutput {
    const o = this.options;
    const { time, detection } = input;
    const dt = this.lastTime === null ? 0 : Math.max(0, Math.min(200, time - this.lastTime));
    this.lastTime = time;
    if (input.ignored) {
      this.pending = [];
      this.ignoredSince ??= time;
      return this.idle(time);
    }
    if (this.ignoredSince !== null) {
      // Back from a long gap (reference tone, interruption): the room may have changed.
      if (time - this.ignoredSince >= o.relearnAfterMs) this.firstTime = null;
      this.ignoredSince = null;
    }
    const db = rmsToDb(input.rms);
    const silent = db < SILENCE_DB;
    if (this.firstTime === null && !silent) this.firstTime = time;

    // Level gate with hysteresis, relative to the noise floor when that is higher.
    const openTh = Math.max(o.gateOpenDb, this.floorDb + o.floorOpenMarginDb);
    const closeTh = Math.max(o.gateCloseDb, this.floorDb + o.floorCloseMarginDb);
    this.gateOpen = this.gateOpen ? db >= closeTh : db >= openTh;

    // Onset detection: level jumped well above its recent minimum.
    while (this.recentDb.length > 0 && time - this.recentDb[0].time > o.onsetLookbackMs) this.recentDb.shift();
    let recentMin = Infinity;
    for (const r of this.recentDb) if (r.db < recentMin) recentMin = r.db;
    const prevDb = this.recentDb.length > 0 ? this.recentDb[this.recentDb.length - 1].db : -Infinity;
    // Only while the level is still rising, so the guard ends ~attackMs after the peak.
    if (this.gateOpen && db - recentMin >= o.onsetRiseDb && db - prevDb >= 2) {
      this.attackUntil = time + o.attackMs;
      this.lastOnset = time;
    }
    this.recentDb.push({ time, db });
    const inAttack = time < this.attackUntil;
    while (this.levelHist.length > 0 && time - this.levelHist[0].time > o.lowNoteLookbackMs) this.levelHist.shift();
    let levelMin = Infinity;
    for (const r of this.levelHist) if (r.db < levelMin) levelMin = r.db;
    this.levelHist.push({ time, db: Math.max(db, SILENCE_DB) });

    const track = this.track;
    let usable = false;
    let continues = false;
    let cents = 0;
    let clarity = 0;
    if (this.gateOpen && detection && detection.frequency > 0 && Number.isFinite(detection.frequency)) {
      cents = hzToCents(detection.frequency);
      clarity = detection.clarity;
      // Only a *live* track is continued frame by frame; after a gap (re-pluck, or the held
      // note's pitch showing up again) the note must be re-confirmed like a new one, which
      // also restarts the median/smoothing history so there is no lag from the old pluck.
      continues =
        track !== null &&
        Math.abs(cents - track.cents) <= o.sameNoteCents &&
        time - track.lastGood <= o.historyResetMs;
      const postOnset = time - this.lastOnset <= o.postOnsetMs;
      const needed = inAttack
        ? o.attackClarity
        : continues
          ? o.sustainClarity
          : postOnset
            ? Math.min(o.postOnsetClarity, o.minAcquireClarity)
            : o.minAcquireClarity;
      usable = clarity >= needed;
      // Hum rejection: a new low note needs an attack (see header). Rejected frames count as
      // noise, so a steady hum the canceller has not (yet) removed also raises the floor.
      if (usable && !continues && detection.frequency < o.lowNoteHz) {
        const relink =
          track !== null &&
          Math.abs(cents - track.cents) <= o.sameNoteCents &&
          time - track.lastGood <= o.lowNoteRelinkMs;
        if (!relink && (db - levelMin < o.lowNoteRiseDb || clarity < o.lowNoteClarity)) usable = false;
      }
    }

    // Noise floor: only learnt from frames that are not confident pitch (so a long sustained
    // note never raises it), and never from digital silence. Falls immediately, rises slowly.
    if (!usable && !silent && this.firstTime !== null) {
      if (db < this.floorDb) this.floorDb = db;
      else {
        const learning = time - this.firstTime <= o.floorLearnMs;
        const rate = learning ? o.floorLearnRiseDbPerSec : o.floorRiseDbPerSec;
        this.floorDb = Math.min(db, this.floorDb + (rate * dt) / 1000);
      }
    }

    if (usable) {
      if (track && continues) {
        this.pending = [];
        this.accept(track, cents, clarity, time, dt);
        return this.output('detected');
      }
      // Candidate for a new note: needs consecutive agreeing frames.
      if (this.pending.length > 0 && Math.abs(cents - median(this.pending.map((p) => p.cents))) > o.candidateCents) {
        this.pending = [];
      }
      this.pending.push({ cents, clarity });
      const jump = track !== null && Math.abs(cents - track.cents) >= JUMP_CENTS;
      const allClear = this.pending.every((p) => p.clarity >= o.acquireClarity);
      const needed = Math.max(
        jump ? o.jumpConfirmFrames : o.confirmFrames,
        allClear ? o.confirmFrames : o.lowClarityConfirmFrames,
      );
      if (this.pending.length >= needed) {
        const history = this.pending.slice(-o.medianSize).map((p) => p.cents);
        this.track = { cents: median(history), clarity, history, lastGood: time };
        this.pending = [];
        return this.output('detected');
      }
    } else {
      this.pending = [];
    }

    return this.idle(time);
  }

  private accept(track: Track, cents: number, clarity: number, time: number, dt: number): void {
    const o = this.options;
    track.history.push(cents);
    if (track.history.length > o.medianSize) track.history.shift();
    const m = median(track.history);
    // Adaptive time constant: long while steady (kills residual jitter), short as soon as the
    // pitch really moves (peg being turned, vibrato).
    const moving = Math.min(1, Math.abs(m - track.cents) / o.steadyCents);
    const tau = o.steadySmoothingMs - (o.steadySmoothingMs - o.smoothingMs) * moving;
    const a = 1 - Math.exp(-dt / tau);
    track.cents += a * (m - track.cents);
    track.clarity += a * (clarity - track.clarity);
    track.lastGood = time;
  }

  /** No fresh reading this frame: grace → holding → listening. */
  private idle(time: number): StabilizerOutput {
    const track = this.track;
    if (!track) return { status: 'listening', reading: null };
    const since = time - track.lastGood;
    if (since <= this.options.graceMs) return this.output('detected');
    if (since <= this.options.holdMs) return this.output('holding');
    this.track = null;
    return { status: 'listening', reading: null };
  }

  private output(status: TunerStatus): StabilizerOutput {
    const t = this.track!;
    return { status, reading: { frequency: centsToHz(t.cents), clarity: Math.max(0, Math.min(1, t.clarity)) } };
  }
}
