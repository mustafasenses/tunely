// Pure, DOM-free UI logic (unit-tested in tests/unit/ui-*.test.ts).
import { noteName, octaveDots, type NoteNaming } from '../music/notes';
import type { TunerStatus } from '../audio/types';

/** |c| ≤ 5 → in tune (green), ≤ 15 → close (amber), else off (red/orange). */
export type TuneZone = 'in' | 'close' | 'off';

export const IN_TUNE_CENTS = 5;
export const CLOSE_CENTS = 15;
export const LOCK_CENTS = 3;
export const LOCK_HOLD_MS = 350;

export function tuneZone(cents: number): TuneZone {
  const a = Math.abs(cents);
  if (a <= IN_TUNE_CENTS) return 'in';
  if (a <= CLOSE_CENTS) return 'close';
  return 'off';
}

export type HintKey = 'hintListening' | 'hintWeak' | 'hintMicMuted' | 'hintLow' | 'hintHigh' | 'hintInTune';

/**
 * `micMuted`: the OS muted the mic track (e.g. another app took it) — explain that instead of
 * asking the user to play louder.
 */
export function hintFor(status: TunerStatus, cents: number | null, weak: boolean, micMuted = false): HintKey {
  if (status === 'listening' || cents === null) {
    if (micMuted) return 'hintMicMuted';
    return weak ? 'hintWeak' : 'hintListening';
  }
  if (tuneZone(cents) === 'in') return 'hintInTune';
  return cents < 0 ? 'hintLow' : 'hintHigh';
}

/** Rounded cents text with explicit sign and a true minus sign, e.g. "+12¢", "−8¢", "0¢". */
export function formatCents(cents: number): string {
  const r = Math.round(cents);
  if (r === 0) return '0¢';
  return `${r > 0 ? '+' : '−'}${Math.abs(r)}¢`;
}

const hzFormats = new Map<string, [Intl.NumberFormat, Intl.NumberFormat]>();

/**
 * Frequency text in the UI language's number format (TR "261,6", EN "261.6"); 1 decimal below
 * 1 kHz, none above. No digit grouping ("2093", not "2.093").
 */
export function formatHz(hz: number, lang = 'en'): string {
  let f = hzFormats.get(lang);
  if (!f) {
    const make = (d: number) =>
      new Intl.NumberFormat(lang, { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false });
    f = [make(1), make(0)];
    hzFormats.set(lang, f);
  }
  return hz >= 1000 ? f[1].format(hz) : f[0].format(hz);
}

export interface NoteLabel {
  /** Note name incl. accidental, e.g. "C♯", "Sol", "♯4". */
  name: string;
  /** Octave as text for letter/solfège; null for number notation (uses dots). */
  octave: string | null;
  /** Number notation: dots above (>0) / below (<0) relative to octave 4. */
  dots: number;
}

export function noteLabel(pitchClass: number, octave: number, naming: NoteNaming): NoteLabel {
  const name = noteName(pitchClass, naming);
  if (naming === 'number') return { name, octave: null, dots: octaveDots(octave) };
  return { name, octave: String(octave), dots: 0 };
}

/**
 * Compact plain-text note for aria labels, e.g. "C♯4", "Sol3". Number notation has no inline
 * octave, so `octaveWord` (e.g. "octave 5") is appended unless the note is in octave 4.
 */
export function noteText(label: NoteLabel, octaveWord: string): string {
  if (label.octave !== null) return `${label.name}${label.octave}`;
  return label.dots === 0 ? label.name : `${label.name}, ${octaveWord}`;
}

/** Needle angle in degrees for a cents value; clamps to ±50 cents → ±maxDeg. */
export function centsToAngle(cents: number, maxDeg: number): number {
  const c = Math.max(-50, Math.min(50, cents));
  return (c / 50) * maxDeg;
}

/**
 * In-tune lock: |c| ≤ LOCK_CENTS sustained LOCK_HOLD_MS → locked.
 * Unlocks (hysteresis) when |c| > IN_TUNE_CENTS, the note changes or the signal is gone.
 * While `holding` the current lock state is frozen.
 */
export class LockTracker {
  private since: number | null = null;
  private midi: number | null = null;
  locked = false;

  /** Returns true exactly once on the frame the lock engages. */
  update(status: TunerStatus, midi: number | null, cents: number | null, time: number): boolean {
    if (status === 'listening' || midi === null || cents === null) {
      this.reset();
      return false;
    }
    if (status === 'holding') return false;
    if (midi !== this.midi) {
      this.reset();
      this.midi = midi;
    }
    const a = Math.abs(cents);
    if (this.locked) {
      if (a > IN_TUNE_CENTS) this.reset(midi);
      return false;
    }
    if (a <= LOCK_CENTS) {
      if (this.since === null) this.since = time;
      if (time - this.since >= LOCK_HOLD_MS) {
        this.locked = true;
        return true;
      }
    } else {
      this.since = null;
    }
    return false;
  }

  reset(midi: number | null = null): void {
    this.since = null;
    this.locked = false;
    this.midi = midi;
  }
}

/**
 * Weak-signal hint ("play louder or move closer"). Shown while the engine has no usable pitch but
 * there is audible input for a while (something is playing, just too quietly / too far), or after
 * a long stretch of silence as a gentle nudge.
 */
export class WeakSignalTracker {
  private listeningSince: number | null = null;
  private activeSince: number | null = null;
  private readonly activeMs: number;
  private readonly idleMs: number;
  private readonly floor: number;
  constructor(activeMs = 1200, idleMs = 8000, floor = 0.08) {
    this.activeMs = activeMs;
    this.idleMs = idleMs;
    this.floor = floor;
  }

  update(status: TunerStatus, level: number, time: number): boolean {
    if (status !== 'listening') {
      this.reset();
      return false;
    }
    if (this.listeningSince === null) this.listeningSince = time;
    if (level >= this.floor) this.activeSince ??= time;
    else this.activeSince = null;
    const active = this.activeSince !== null && time - this.activeSince >= this.activeMs;
    return active || time - this.listeningSince >= this.idleMs;
  }

  reset(): void {
    this.listeningSince = null;
    this.activeSince = null;
  }
}

/**
 * Throttled aria-live announcer: only speaks on a new note (stable for `settleMs`)
 * or when the lock engages, and never more often than every `minGapMs`.
 */
export class Announcer {
  private lastSpokenMidi: number | null = null;
  private lastSpokenAt = -Infinity;
  private candidateMidi: number | null = null;
  private candidateSince = 0;
  private readonly minGapMs: number;
  private readonly settleMs: number;
  constructor(minGapMs = 1500, settleMs = 400) {
    this.minGapMs = minGapMs;
    this.settleMs = settleMs;
  }

  /** Returns 'note' | 'lock' when something should be announced now, else null. */
  update(midi: number | null, justLocked: boolean, time: number): 'note' | 'lock' | null {
    if (justLocked && midi !== null) {
      // Lock is the most useful event: allow it even shortly after a note announcement.
      if (time - this.lastSpokenAt >= 500) {
        this.mark(midi, time);
        return 'lock';
      }
    }
    if (midi === null) {
      this.candidateMidi = null;
      return null;
    }
    if (midi !== this.candidateMidi) {
      this.candidateMidi = midi;
      this.candidateSince = time;
    }
    if (
      midi !== this.lastSpokenMidi &&
      time - this.candidateSince >= this.settleMs &&
      time - this.lastSpokenAt >= this.minGapMs
    ) {
      this.mark(midi, time);
      return 'note';
    }
    return null;
  }

  private mark(midi: number, time: number): void {
    this.lastSpokenMidi = midi;
    this.lastSpokenAt = time;
  }
}

/**
 * Critically-damped-ish spring step for the needle. Returns new [position, velocity].
 * `dt` in seconds; clamped for tab-switch gaps.
 */
export function springStep(
  pos: number,
  vel: number,
  target: number,
  dt: number,
  stiffness = 160,
  damping = 22,
): [number, number] {
  const h = Math.min(dt, 1 / 30);
  const acc = stiffness * (target - pos) - damping * vel;
  const v = vel + acc * h;
  return [pos + v * h, v];
}
