import { describe, expect, it } from 'vitest';
import {
  DEFAULT_A4,
  frequencyToNote,
  LETTER_NAMES,
  MAX_A4,
  midiToFrequency,
  MIN_A4,
  noteName,
  octaveDots,
} from '../../src/music/notes.ts';

describe('midiToFrequency', () => {
  it('A4 = 69 = 440 Hz by default; octaves double', () => {
    expect(DEFAULT_A4).toBe(440);
    expect(midiToFrequency(69)).toBe(440);
    expect(midiToFrequency(81)).toBeCloseTo(880, 10);
    expect(midiToFrequency(60)).toBeCloseTo(261.6256, 4);
    expect(midiToFrequency(21)).toBeCloseTo(27.5, 10);
    expect(midiToFrequency(108)).toBeCloseTo(4186.009, 3);
  });

  it('honours the A4 reference (415 … 466)', () => {
    expect(MIN_A4).toBe(415);
    expect(MAX_A4).toBe(466);
    expect(midiToFrequency(69, 415)).toBe(415);
    expect(midiToFrequency(60, 466)).toBeCloseTo((466 * 261.6256) / 440, 3);
  });
});

describe('frequencyToNote', () => {
  it('exact notes have 0 cents', () => {
    for (let midi = 21; midi <= 108; midi++) {
      const n = frequencyToNote(midiToFrequency(midi));
      expect(n.midi).toBe(midi);
      expect(Math.abs(n.cents)).toBeLessThan(1e-9);
      expect(n.targetFrequency).toBeCloseTo(midiToFrequency(midi), 9);
    }
  });

  it('cents sign: sharp is positive, flat is negative', () => {
    const sharp = frequencyToNote(442);
    expect(sharp.midi).toBe(69);
    expect(sharp.cents).toBeCloseTo(7.85, 2);
    const flat = frequencyToNote(438);
    expect(flat.midi).toBe(69);
    expect(flat.cents).toBeCloseTo(-7.89, 2);
  });

  it('pitch class and scientific octave (C4 = middle C, B3/C4 boundary)', () => {
    const c4 = frequencyToNote(261.63);
    expect([c4.pitchClass, c4.octave, LETTER_NAMES[c4.pitchClass]]).toEqual([0, 4, 'C']);
    const b3 = frequencyToNote(246.94);
    expect([b3.pitchClass, b3.octave]).toEqual([11, 3]);
    const a0 = frequencyToNote(27.5);
    expect([a0.midi, a0.pitchClass, a0.octave]).toEqual([21, 9, 0]);
    const c8 = frequencyToNote(4186.01);
    expect([c8.pitchClass, c8.octave]).toEqual([0, 8]);
    const lowB0 = frequencyToNote(30.87);
    expect([lowB0.pitchClass, lowB0.octave]).toEqual([11, 0]);
  });

  it('keeps cents in [−50, 50) at the half-way point between notes', () => {
    for (let midi = 30; midi < 100; midi++) {
      const n = frequencyToNote(midiToFrequency(midi + 0.5));
      expect(n.cents).toBeGreaterThanOrEqual(-50);
      expect(n.cents).toBeLessThan(50);
      expect(Math.abs(n.cents)).toBeCloseTo(50, 6);
      // 49.9 c sharp stays on the lower note, 50.1 c sharp moves up
      expect(frequencyToNote(midiToFrequency(midi + 0.499)).midi).toBe(midi);
      expect(frequencyToNote(midiToFrequency(midi + 0.501)).midi).toBe(midi + 1);
    }
  });

  it('uses the A4 reference: 415 and 466 Hz are each "A4, 0 c" under their own reference', () => {
    const a415 = frequencyToNote(415, 415);
    expect([a415.midi, Math.abs(a415.cents) < 1e-9]).toEqual([69, true]);
    expect(a415.targetFrequency).toBe(415);
    const a466 = frequencyToNote(466, 466);
    expect([a466.midi, Math.abs(a466.cents) < 1e-9]).toEqual([69, true]);
    // 440 Hz under A4 = 466 is a slightly sharp G♯4 (≈ +0.6 c)
    const g = frequencyToNote(440, 466);
    expect(g.midi).toBe(68);
    expect(g.cents).toBeCloseTo(0.6, 1);
    // 440 Hz under A4 = 415 is a slightly sharp A♯4 (≈ +1.27 c)
    const as = frequencyToNote(440, 415);
    expect(as.midi).toBe(70);
    expect(as.cents).toBeCloseTo(1.27, 2);
  });

  it('kalimba range C4–E6 (and up to C7) maps to the expected notes', () => {
    const names = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84, 86, 88, 96].map((m) => {
      const n = frequencyToNote(midiToFrequency(m) * 1.003); // +5 c
      return `${LETTER_NAMES[n.pitchClass]}${n.octave}`;
    });
    expect(names).toEqual([
      'C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'B5', 'C6', 'D6', 'E6', 'C7',
    ]);
  });
});

describe('naming helpers', () => {
  it('letter / solfège / number names and octave dots', () => {
    expect(noteName(0, 'letter')).toBe('C');
    expect(noteName(9, 'solfege')).toBe('La');
    expect(noteName(1, 'number')).toBe('♯1');
    expect(noteName(11, 'number')).toBe('7');
    expect(octaveDots(4)).toBe(0);
    expect(octaveDots(6)).toBe(2);
    expect(octaveDots(3)).toBe(-1);
  });
});
