import { describe, expect, it } from 'vitest';
import {
  Announcer,
  centsToAngle,
  formatCents,
  formatHz,
  hintFor,
  LockTracker,
  noteLabel,
  noteText,
  springStep,
  tuneZone,
  WeakSignalTracker,
} from '../../src/ui/logic';

describe('tuneZone', () => {
  it('maps cents to in/close/off with inclusive thresholds', () => {
    expect(tuneZone(0)).toBe('in');
    expect(tuneZone(5)).toBe('in');
    expect(tuneZone(-5)).toBe('in');
    expect(tuneZone(5.1)).toBe('close');
    expect(tuneZone(-15)).toBe('close');
    expect(tuneZone(15.1)).toBe('off');
    expect(tuneZone(-49)).toBe('off');
  });
});

describe('hintFor', () => {
  it('gives direction hints', () => {
    expect(hintFor('detected', -20, false)).toBe('hintLow');
    expect(hintFor('detected', 12, false)).toBe('hintHigh');
    expect(hintFor('detected', 2, false)).toBe('hintInTune');
    expect(hintFor('holding', -8, false)).toBe('hintLow');
  });
  it('uses listening / weak hints without a reading', () => {
    expect(hintFor('listening', null, false)).toBe('hintListening');
    expect(hintFor('listening', null, true)).toBe('hintWeak');
  });
});

describe('formatting', () => {
  it('formats cents with sign and true minus', () => {
    expect(formatCents(12.4)).toBe('+12¢');
    expect(formatCents(-7.6)).toBe('−8¢');
    expect(formatCents(0.3)).toBe('0¢');
    expect(formatCents(-0.4)).toBe('0¢');
  });
  it('formats Hz', () => {
    expect(formatHz(440)).toBe('440.0');
    expect(formatHz(2093.0045)).toBe('2093');
  });
});

describe('noteLabel / noteText', () => {
  it('letter & solfège carry the octave', () => {
    expect(noteLabel(1, 4, 'letter')).toEqual({ name: 'C♯', octave: '4', dots: 0 });
    expect(noteLabel(7, 5, 'solfege')).toEqual({ name: 'Sol', octave: '5', dots: 0 });
    expect(noteText(noteLabel(9, 4, 'letter'), 'octave 4')).toBe('A4');
  });
  it('number notation uses dots relative to octave 4', () => {
    expect(noteLabel(0, 4, 'number')).toEqual({ name: '1', octave: null, dots: 0 });
    expect(noteLabel(2, 6, 'number').dots).toBe(2);
    expect(noteLabel(9, 3, 'number').dots).toBe(-1);
    expect(noteText(noteLabel(0, 4, 'number'), 'octave 4')).toBe('1');
    expect(noteText(noteLabel(0, 5, 'number'), 'octave 5')).toBe('1, octave 5');
  });
});

describe('centsToAngle', () => {
  it('scales and clamps', () => {
    expect(centsToAngle(0, 60)).toBe(0);
    expect(centsToAngle(25, 60)).toBe(30);
    expect(centsToAngle(-80, 60)).toBe(-60);
  });
});

describe('LockTracker', () => {
  it('locks after |c|≤3 is held for 350 ms', () => {
    const l = new LockTracker();
    expect(l.update('detected', 69, 2, 0)).toBe(false);
    expect(l.update('detected', 69, -1, 200)).toBe(false);
    expect(l.update('detected', 69, 1, 349)).toBe(false);
    expect(l.update('detected', 69, 0.5, 350)).toBe(true);
    expect(l.locked).toBe(true);
    // fires once only
    expect(l.update('detected', 69, 0.5, 400)).toBe(false);
  });
  it('restarts the timer when leaving the ±3 window before locking', () => {
    const l = new LockTracker();
    l.update('detected', 69, 1, 0);
    l.update('detected', 69, 4, 200);
    expect(l.update('detected', 69, 1, 400)).toBe(false);
    expect(l.update('detected', 69, 1, 760)).toBe(true);
  });
  it('has hysteresis: stays locked up to ±5, unlocks beyond', () => {
    const l = new LockTracker();
    l.update('detected', 69, 0, 0);
    l.update('detected', 69, 0, 400);
    l.update('detected', 69, 4.5, 450);
    expect(l.locked).toBe(true);
    l.update('detected', 69, 6, 500);
    expect(l.locked).toBe(false);
  });
  it('freezes while holding, resets on note change or listening', () => {
    const l = new LockTracker();
    l.update('detected', 69, 0, 0);
    l.update('detected', 69, 0, 400);
    l.update('holding', 69, 0, 900);
    expect(l.locked).toBe(true);
    l.update('detected', 70, 0, 1000);
    expect(l.locked).toBe(false);
    l.update('detected', 70, 0, 1400);
    expect(l.locked).toBe(true);
    l.update('listening', null, null, 1500);
    expect(l.locked).toBe(false);
  });
});

describe('WeakSignalTracker', () => {
  it('flags audible-but-undetected input after a short while', () => {
    const w = new WeakSignalTracker(1200, 8000, 0.08);
    expect(w.update('listening', 0.2, 0)).toBe(false);
    expect(w.update('listening', 0.2, 1000)).toBe(false);
    expect(w.update('listening', 0.2, 1300)).toBe(true);
  });
  it('nudges after long silence and clears on detection', () => {
    const w = new WeakSignalTracker(1200, 8000, 0.08);
    expect(w.update('listening', 0.01, 0)).toBe(false);
    expect(w.update('listening', 0.01, 7000)).toBe(false);
    expect(w.update('listening', 0.01, 8000)).toBe(true);
    expect(w.update('detected', 0.5, 8100)).toBe(false);
    expect(w.update('listening', 0.01, 8200)).toBe(false);
  });
});

describe('Announcer', () => {
  it('announces a settled new note, throttled', () => {
    const a = new Announcer(1500, 400);
    expect(a.update(69, false, 0)).toBe(null);
    expect(a.update(69, false, 450)).toBe('note');
    expect(a.update(69, false, 3000)).toBe(null); // same note: silent
    expect(a.update(71, false, 3100)).toBe(null); // not settled yet
    expect(a.update(71, false, 3600)).toBe('note');
    expect(a.update(72, false, 3700)).toBe(null);
    expect(a.update(72, false, 4200)).toBe(null); // within min gap
    expect(a.update(72, false, 5200)).toBe('note');
  });
  it('announces lock promptly', () => {
    const a = new Announcer(1500, 400);
    a.update(69, false, 0);
    expect(a.update(69, false, 450)).toBe('note');
    expect(a.update(69, true, 1000)).toBe('lock');
  });
  it('ignores rapid note flicker', () => {
    const a = new Announcer(1500, 400);
    for (let t = 0; t < 2000; t += 100) expect(a.update(t % 200 ? 60 : 61, false, t)).toBe(null);
  });
});

describe('springStep', () => {
  it('converges to target without large overshoot', () => {
    let p = 0;
    let v = 0;
    let max = 0;
    for (let i = 0; i < 120; i++) {
      [p, v] = springStep(p, v, 30, 1 / 60);
      max = Math.max(max, p);
    }
    expect(Math.abs(p - 30)).toBeLessThan(0.2);
    expect(max).toBeLessThan(33);
  });
});
