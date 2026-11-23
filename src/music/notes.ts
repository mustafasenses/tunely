// Pure music-theory helpers (12-TET). Shared by engine tests and UI.

export const DEFAULT_A4 = 440;
export const MIN_A4 = 415;
export const MAX_A4 = 466;

export type NoteNaming = 'letter' | 'solfege' | 'number';

/** Pitch-class names, index 0 = C. Sharps only. */
export const LETTER_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const;
export const SOLFEGE_NAMES = ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'] as const;
/** Numbered (jianpu) notation, 1 = C. Octave shown separately as dots relative to octave 4. */
export const NUMBER_NAMES = ['1', '♯1', '2', '♯2', '3', '4', '♯4', '5', '♯5', '6', '♯6', '7'] as const;

export interface NoteInfo {
  /** MIDI note number of the nearest equal-tempered note (A4 = 69). */
  midi: number;
  /** Pitch class 0..11 (0 = C). */
  pitchClass: number;
  /** Scientific octave (C4 = middle C). */
  octave: number;
  /** Deviation from the nearest note in cents, in [-50, 50). Positive = sharp (too high). */
  cents: number;
  /** Exact frequency of the nearest note in Hz. */
  targetFrequency: number;
}

export function midiToFrequency(midi: number, a4 = DEFAULT_A4): number {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

export function frequencyToNote(frequency: number, a4 = DEFAULT_A4): NoteInfo {
  const exact = 69 + 12 * Math.log2(frequency / a4);
  const midi = Math.round(exact);
  let cents = (exact - midi) * 100;
  if (cents >= 50) cents -= 100; // guard float edge
  const pitchClass = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return { midi, pitchClass, octave, cents, targetFrequency: midiToFrequency(midi, a4) };
}

export function noteName(pitchClass: number, naming: NoteNaming): string {
  switch (naming) {
    case 'solfege':
      return SOLFEGE_NAMES[pitchClass];
    case 'number':
      return NUMBER_NAMES[pitchClass];
    default:
      return LETTER_NAMES[pitchClass];
  }
}

/** For numbered notation: dots above (positive) or below (negative) relative to octave 4. */
export function octaveDots(octave: number): number {
  return octave - 4;
}
