import { describe, expect, it } from 'vitest';
import { TunerPipeline } from '../../src/audio/pipeline.ts';
import { dbToLevel, LEVEL_MAX_DB, LEVEL_MIN_DB, rmsOf, rmsToDb } from '../../src/audio/level.ts';
import { addNoise, harmonicTone, sawAmps, sine } from './helpers/synth.ts';
import { runPipeline } from './helpers/run.ts';

describe('level helpers', () => {
  it('maps dBFS linearly onto 0..1 and clamps', () => {
    expect(dbToLevel(LEVEL_MIN_DB)).toBe(0);
    expect(dbToLevel(LEVEL_MAX_DB)).toBe(1);
    expect(dbToLevel(-200)).toBe(0);
    expect(dbToLevel(0)).toBe(1);
    expect(dbToLevel((LEVEL_MIN_DB + LEVEL_MAX_DB) / 2)).toBeCloseTo(0.5, 10);
  });

  it('computes RMS (DC removed) of the newest samples', () => {
    const x = sine(1000, 48000, 4800, 1);
    for (let i = 0; i < x.length; i++) x[i] += 0.5;
    expect(rmsOf(x)).toBeCloseTo(Math.SQRT1_2, 3);
    expect(rmsToDb(Math.SQRT1_2)).toBeCloseTo(-3.01, 2);
    expect(rmsToDb(0)).toBe(-200);
  });
});

describe('TunerPipeline', () => {
  it('end-to-end: steady tones with 20 dB SNR noise show ≤ 1 c jitter and ≤ 3 c error', () => {
    for (const fs of [44100, 48000]) {
      for (const f of [41.2, 82.41, 196, 440, 1318.5, 2500]) {
        // The tone starts (like any played note) after 200 ms of room noise: a steady low tone
        // with no attack at all is treated as mains hum and deliberately never displayed.
        const tone = harmonicTone(f, fs, fs * 3, sawAmps(20), 3);
        const x = addNoise(tone, 20, Math.round(f));
        for (let i = 0; i < 0.2 * fs; i++) x[i] -= tone[i];
        const frames = runPipeline(x, fs).filter((fr) => fr.time > 1000);
        expect(frames.every((fr) => fr.status === 'detected')).toBe(true);
        const c = frames.map((fr) => 1200 * Math.log2(fr.reading!.frequency / f));
        expect(Math.max(...c) - Math.min(...c), `${f} Hz @${fs} jitter`).toBeLessThanOrEqual(1);
        expect(Math.max(...c.map(Math.abs)), `${f} Hz @${fs} error`).toBeLessThanOrEqual(3);
      }
    }
  }, 30_000);

  it('first reading of a clean onset arrives within ~150 ms (incl. low notes)', () => {
    const fs = 48000;
    for (const f of [55, 110, 261.63, 880, 3520]) {
      const x = new Float32Array(fs);
      x.set(sine(f, fs, fs / 2, 0.3), fs / 2); // silence, then the tone at 500 ms
      const frames = runPipeline(x, fs);
      const first = frames.find((fr) => fr.status === 'detected')!;
      expect(first.time - 500, `${f} Hz`).toBeLessThanOrEqual(150);
      expect(Math.abs(1200 * Math.log2(first.reading!.frequency / f))).toBeLessThan(50);
    }
  });

  it('muting ignores input (listening, level 0) and keeps ignoring it briefly after unmute', () => {
    const fs = 48000;
    const p = new TunerPipeline(fs);
    const buf = sine(440, fs, p.analysisLength, 0.3);
    let t = 0;
    for (let i = 0; i < 30; i++) p.process(buf, (t += 16.7));
    expect(p.process(buf, (t += 16.7)).status).toBe('detected');
    p.setMuted(true, t);
    let f = p.process(buf, (t += 16.7));
    expect(f.status).not.toBe('listening'); // last reading is held while muted …
    for (let i = 0; i < 100; i++) f = p.process(buf, (t += 16.7));
    expect(f.status).toBe('listening'); // … then released after the hold time
    expect(f.reading).toBeNull();
    expect(f.level).toBeLessThan(0.01);
    p.setMuted(false, t);
    expect(p.process(buf, (t += 16.7)).status).toBe('listening'); // unmute guard (250 ms)
    for (let i = 0; i < 25; i++) f = p.process(buf, (t += 16.7));
    expect(f.status).toBe('detected');
  });

  it('level rises instantly and falls smoothly', () => {
    const fs = 48000;
    const p = new TunerPipeline(fs);
    const loud = sine(440, fs, p.analysisLength, 0.5);
    const quiet = new Float32Array(p.analysisLength);
    let t = 0;
    const l1 = p.process(loud, (t += 16.7)).level;
    expect(l1).toBeGreaterThan(0.9);
    const l2 = p.process(quiet, (t += 16.7)).level;
    expect(l2).toBeLessThan(l1);
    expect(l2).toBeGreaterThan(0.5);
    let l = l2;
    for (let i = 0; i < 60; i++) l = p.process(quiet, (t += 16.7)).level;
    expect(l).toBeLessThan(0.05);
  });
});
