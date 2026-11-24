// End-to-end (minus Web Audio) tests: synthetic kalimba notes are fed frame by frame through
// detectPitch + PitchStabilizer exactly as the engine does (TunerPipeline at ~60 frames/s).
import { describe, expect, it } from 'vitest';
import { midiToFrequency } from '../../src/music/notes.ts';
import { addKalimbaNote, gaussian, kalimbaTone, type KalimbaOptions } from './helpers/synth.ts';
import { runPipeline, scoreNote } from './helpers/run.ts';

const ONSET_MS = 100;
/** C-major 17-key kalimba: C4 D4 E4 F4 G4 A4 B4 C5 D5 E5 F5 G5 A5 B5 C6 D6 E6. */
const C_MAJOR_17 = [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84, 86, 88];
const CHROMATIC = Array.from({ length: 37 }, (_, i) => 60 + i); // C4 … C7
const PARTIAL_RATIOS = [5.9, 5.2, 5.6, 6.3, 6.8, 7.0, 5.4];
const TAUS = [0.4, 0.8, 1.5];
const PARTIAL_AMPS = [0.3, 0.6, 1.0];

/** Deterministic per-note variety: ±10 c detune, decay, mode ratio/strength. */
function variant(midi: number, k: number): { f0: number; o: KalimbaOptions } {
  const detune = (((midi * 7 + k * 3) % 21) - 10) / 1200;
  return {
    f0: midiToFrequency(midi) * Math.pow(2, detune),
    o: {
      tau: TAUS[(midi + k) % TAUS.length],
      partialRatio: PARTIAL_RATIOS[(midi + k) % PARTIAL_RATIOS.length],
      partialAmp: PARTIAL_AMPS[((midi >> 1) + k) % PARTIAL_AMPS.length],
      seed: midi * 10 + k,
      onset: ONSET_MS / 1000,
      duration: 3,
    },
  };
}

function checkNote(midi: number, fs: number, f0: number, o: KalimbaOptions) {
  const frames = runPipeline(kalimbaTone(f0, fs, o), fs);
  const m = scoreNote(frames, f0, midi, ONSET_MS);
  const label = `midi ${midi} @${fs} ${JSON.stringify(o)}`;
  expect(m.wrongNoteFrames, `${label}: wrong note / octave flips`).toBe(0);
  expect(m.latencyMs, `${label}: first reading`).toBeGreaterThanOrEqual(0);
  expect(m.latencyMs, `${label}: first reading`).toBeLessThanOrEqual(150);
  expect(m.maxErrCents, `${label}: sustain error`).toBeLessThanOrEqual(3);
  expect(m.sustainFrames, `${label}: sustain frames`).toBeGreaterThan(20);
  return { m, frames };
}

describe.each([48000, 44100])('kalimba model @ %i Hz', (fs) => {
  it(
    '17-key C-major (C4–E6): right note, ≤ ±3 c during sustain, no octave flips, first reading ≤ 150 ms',
    () => {
      for (const midi of C_MAJOR_17) {
        for (let k = 0; k < 2; k++) {
          const { f0, o } = variant(midi, k);
          checkNote(midi, fs, f0, o);
        }
      }
    },
    60_000,
  );

  it(
    'chromatic C4–C7 with mode ratios 5.2–7.0×, τ 0.4–1.5 s',
    () => {
      for (const midi of CHROMATIC) {
        const { f0, o } = variant(midi, 5);
        checkNote(midi, fs, f0, o);
      }
    },
    60_000,
  );
});

describe('kalimba model — harder variants (48 kHz)', () => {
  const variants: Record<string, KalimbaOptions> = {
    'mode 1.5× louder than f0 at the attack': { partialAmp: 1.5 },
    'slowly decaying mode': { partialAmp: 1.0, partialTauRatio: 0.6 },
    'loud click / noise burst': { clickAmp: 3 },
    'noisy room (−50 dBFS floor)': { noiseFloorDb: -50 },
    'quiet pluck (−30 dBFS peak)': { amp: 0.03 },
    'strong 2nd/3rd harmonics': { h2: 0.5, h3: 0.3 },
    'short decay τ = 0.3 s': { tau: 0.3 },
  };
  for (const [name, extra] of Object.entries(variants)) {
    it(
      name,
      () => {
        for (const midi of [60, 64, 67, 72, 76, 79, 84, 88, 91, 96]) {
          const { f0, o } = variant(midi, 1);
          checkNote(midi, 48000, f0, { ...o, ...extra });
        }
      },
      30_000,
    );
  }

  it(
    'reading stays accurate while the tone decays to the gate, then holds ~1.5 s and returns to listening',
    () => {
      const fs = 48000;
      const f0 = midiToFrequency(69);
      // τ = 0.4 s from −13 dBFS: crosses the −62 dBFS gate after ~2.3 s.
      const x = kalimbaTone(f0, fs, { tau: 0.4, duration: 5, onset: 0.1, noiseFloorDb: -75 });
      const frames = runPipeline(x, fs);
      const detected = frames.filter((f) => f.status === 'detected');
      const lastDetected = detected[detected.length - 1].time;
      expect(lastDetected).toBeGreaterThan(1800); // tracked deep into the decay
      for (const f of detected.filter((f) => f.time > 200)) {
        expect(Math.abs(1200 * Math.log2(f.reading!.frequency / f0))).toBeLessThanOrEqual(3);
      }
      const after = frames.filter((f) => f.time > lastDetected);
      const holding = after.filter((f) => f.status === 'holding');
      expect(holding.length).toBeGreaterThan(0);
      for (const f of holding) expect(f.reading!.frequency).toBeCloseTo(detected[detected.length - 1].reading!.frequency, 6);
      const firstListening = after.find((f) => f.status === 'listening')!;
      expect(firstListening.time - lastDetected).toBeGreaterThan(1300);
      expect(firstListening.time - lastDetected).toBeLessThan(1700);
    },
    30_000,
  );
});

describe('kalimba note sequences', () => {
  // Each new tine is plucked while the previous ones still ring (τ = 0.8 s → about −11 dB after
  // 1 s). Checks that the display follows the newest note quickly and accurately.
  const sequences = [
    [60, 64, 67, 72], // ascending arpeggio incl. an octave above the first note
    [84, 79, 76, 72], // descending
    [62, 64, 65, 67], // whole / half steps
    [60, 72, 60, 72], // octave leaps
    [88, 86, 84, 83], // top of the instrument
  ];
  for (const fs of [48000, 44100]) {
    for (const seq of sequences) {
      it(`${seq.join('→')} @${fs}, 1 s apart`, () => {
        const gap = 1;
        const start = 0.3;
        const x = new Float32Array(Math.round((start + seq.length * gap + 0.5) * fs));
        seq.forEach((m, i) => addKalimbaNote(x, midiToFrequency(m), fs, start + i * gap, { tau: 0.8, seed: m + i }));
        const g = gaussian(5);
        for (let i = 0; i < x.length; i++) x[i] += 3e-4 * g();
        const frames = runPipeline(x, fs);
        seq.forEach((m, i) => {
          const on = (start + i * gap) * 1000;
          const s = scoreNote(frames, midiToFrequency(m), m, on, 200, on + gap * 1000);
          expect(s.latencyMs, `note ${i} (${m})`).toBeGreaterThanOrEqual(0);
          expect(s.latencyMs, `note ${i} (${m})`).toBeLessThanOrEqual(150);
          // After 200 ms the display must show the new note. Adjacent notes still ringing at
          // −11 dB beat with the new one, so allow more than the single-note ±3 c here.
          const late = frames.filter((f) => f.time >= on + 200 && f.time < on + gap * 1000 && f.reading);
          for (const f of late) expect(Math.round(69 + 12 * Math.log2(f.reading!.frequency / 440))).toBe(m);
          expect(s.maxErrCents, `note ${i} (${m})`).toBeLessThanOrEqual(15);
        });
      });
    }
  }
});
