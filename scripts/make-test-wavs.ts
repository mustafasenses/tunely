// Writes deterministic 48 kHz mono 16-bit WAV fixtures to tests/fixtures/ for end-to-end tests
// (e.g. Chromium --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<file>).
// Run: npm run make-wavs   (Node ≥ 22.6, uses --experimental-strip-types; no dependencies)
//
// tests/fixtures/manifest.json describes what each file should read as.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addKalimbaNote, gaussian, kalimbaTone, sine } from '../tests/unit/helpers/synth.ts';

const FS = 48000;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');

function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Scale to the given peak and apply 10 ms fades (files are looped by the fake mic). */
function finish(x: Float32Array, peak: number): Float32Array {
  let max = 0;
  for (const v of x) max = Math.max(max, Math.abs(v));
  const g = max > 0 ? peak / max : 1;
  const fade = Math.round(0.01 * FS);
  for (let i = 0; i < x.length; i++) {
    const e = Math.min(1, i / fade, (x.length - 1 - i) / fade);
    x[i] *= g * e;
  }
  return x;
}

function wav16(x: Float32Array): Uint8Array {
  const data = x.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + data, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, FS, true);
  v.setUint32(28, FS * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits
  str(36, 'data');
  v.setUint32(40, data, true);
  const g = gaussian(99); // TPDF-ish dither (±0.5 LSB gaussian) keeps quantisation unbiased
  for (let i = 0; i < x.length; i++) {
    const s = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767 + 0.5 * g())));
    v.setInt16(44 + i * 2, s, true);
  }
  return new Uint8Array(buf);
}

interface Entry {
  file: string;
  description: string;
  durationSec: number;
  /** Expected readings; times are seconds from the start of the file. */
  notes: { midi: number; name: string; frequency: number; cents: number; onsetSec: number }[];
}

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const noteName = (m: number) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
const manifest: Entry[] = [];

function write(file: string, x: Float32Array, description: string, notes: Entry['notes']): void {
  writeFileSync(join(OUT, file), wav16(x));
  manifest.push({ file, description, durationSec: x.length / FS, notes });
  console.log(`wrote tests/fixtures/${file} (${(x.length / FS).toFixed(1)} s)`);
}

mkdirSync(OUT, { recursive: true });

// Steady sines, −12 dBFS peak.
write('sine-a4-440.wav', finish(sine(440, FS, 4 * FS, 1), 0.25), 'Pure sine 440 Hz (A4, 0 c)', [
  { midi: 69, name: 'A4', frequency: 440, cents: 0, onsetSec: 0 },
]);
write('sine-a4-442.wav', finish(sine(442, FS, 4 * FS, 1), 0.25), 'Pure sine 442 Hz (A4 +7.85 c)', [
  { midi: 69, name: 'A4', frequency: 442, cents: 1200 * Math.log2(442 / 440), onsetSec: 0 },
]);

// Kalimba-model plucks (see tests/unit/helpers/synth.ts): onset at 0.3 s, τ = 1 s.
for (const [file, midi] of [
  ['kalimba-c4.wav', 60],
  ['kalimba-e6.wav', 88],
] as const) {
  const f = midiToHz(midi);
  const x = kalimbaTone(f, FS, { duration: 3.5, onset: 0.3, tau: 1, partialRatio: 5.9, partialAmp: 0.6, seed: midi });
  write(file, finish(x, 0.7), `Kalimba-model pluck ${noteName(midi)} (${f.toFixed(2)} Hz), onset 0.3 s, τ 1 s`, [
    { midi, name: noteName(midi), frequency: f, cents: 0, onsetSec: 0.3 },
  ]);
}

// Three plucks 1.5 s apart (each previous tine still rings, ≈ −13 dB by the next pluck).
{
  const seq = [60, 64, 67]; // C4 E4 G4
  const gap = 1.5;
  const start = 0.3;
  const x = new Float32Array(Math.round((start + seq.length * gap + 0.5) * FS));
  seq.forEach((m, i) =>
    addKalimbaNote(x, midiToHz(m), FS, start + i * gap, { tau: 1, partialRatio: [5.9, 5.6, 6.3][i], seed: m + i }),
  );
  const g = gaussian(5);
  for (let i = 0; i < x.length; i++) x[i] += 3e-4 * g();
  write(
    'kalimba-sequence-c4-e4-g4.wav',
    finish(x, 0.7),
    'Kalimba-model C4, E4, G4 plucked 1.5 s apart (onsets 0.3 / 1.8 / 3.3 s)',
    seq.map((m, i) => ({ midi: m, name: noteName(m), frequency: midiToHz(m), cents: 0, onsetSec: start + i * gap })),
  );
}

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ sampleRate: FS, bitDepth: 16, channels: 1, files: manifest }, null, 2) + '\n');
console.log('wrote tests/fixtures/manifest.json');
