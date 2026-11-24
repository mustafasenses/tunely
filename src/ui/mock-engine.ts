// Fake TunerEngine for development, screenshots and e2e tests — no microphone needed.
// Activated with the URL query `?mock` (see main.ts). Scenarios:
//   ?mock                 cycle of kalimba-like notes (attack → drift toward 0 → decay → holding → listening)
//   ?mock=flat|sharp|close|intune   steady note at a fixed deviation
//   ?mock=holding         note, then permanently holding
//   ?mock=listening       silence (idle nudge hint after 8 s)
//   ?mock=weak            quiet input with no pitch → "play louder or move closer" hint
//   ?mock=error-denied | error-nomic | error-insecure | error-unsupported | error-unknown
import { midiToFrequency } from '../music/notes';
import { TunerError, type TunerEngine, type TunerErrorCode, type TunerFrame } from '../audio/types';

const ERRORS: Record<string, TunerErrorCode> = {
  'error-denied': 'permission-denied',
  'error-nomic': 'no-microphone',
  'error-insecure': 'insecure-context',
  'error-unsupported': 'unsupported',
  'error-unknown': 'unknown',
};

interface PluckSpec {
  midi: number;
  startCents: number;
  endCents: number;
}

// Kalimba-ish notes (C4..E6) with varied starting deviations.
const CYCLE: PluckSpec[] = [
  { midi: 60, startCents: -30, endCents: 0 },
  { midi: 64, startCents: 22, endCents: 9 },
  { midi: 67, startCents: -12, endCents: -1 },
  { midi: 72, startCents: 38, endCents: 18 },
  { midi: 76, startCents: -6, endCents: 1 },
  { midi: 62, startCents: -45, endCents: -24 },
];

const STEADY: Record<string, PluckSpec> = {
  flat: { midi: 69, startCents: -24, endCents: -24 },
  sharp: { midi: 64, startCents: 31, endCents: 31 },
  close: { midi: 57, startCents: 9, endCents: 9 },
  intune: { midi: 61, startCents: 1.2, endCents: 1.2 },
  holding: { midi: 74, startCents: -3.5, endCents: -3.5 },
};

const LISTEN_MS = 1200;
const SOUND_MS = 2800;
const HOLD_MS = 1500;

export function createMockEngine(scenario: string): TunerEngine {
  const listeners = new Set<(f: TunerFrame) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let muted = false;
  let t0 = 0;
  let seed = 1;
  const noise = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };

  const emit = (frame: TunerFrame): void => {
    for (const cb of listeners) cb(frame);
  };

  const listeningFrame = (time: number, level: number): TunerFrame => ({
    status: 'listening',
    reading: null,
    level: Math.max(0, level),
    time,
  });

  const tick = (): void => {
    const time = performance.now();
    const t = time - t0;
    if (muted) {
      emit(listeningFrame(time, 0.02));
      return;
    }
    if (scenario === 'listening') {
      emit(listeningFrame(time, 0.04 + noise() * 0.03));
      return;
    }
    if (scenario === 'weak') {
      // Audible but too quiet / noisy to detect a pitch.
      emit(listeningFrame(time, 0.14 + noise() * 0.05));
      return;
    }
    const steady = STEADY[scenario];
    if (steady) {
      const holdingNow = scenario === 'holding' && t > 900;
      const cents = steady.startCents + (holdingNow ? 0 : noise() * 0.5);
      emit({
        status: holdingNow ? 'holding' : 'detected',
        reading: { frequency: midiToFrequency(steady.midi + cents / 100), clarity: 0.95 },
        level: holdingNow ? 0.06 : 0.55 + noise() * 0.06,
        time,
      });
      return;
    }
    // Cycle scenario.
    const period = LISTEN_MS + SOUND_MS + HOLD_MS;
    const idx = Math.floor(t / period) % CYCLE.length;
    const p = t % period;
    const spec = CYCLE[idx];
    if (p < LISTEN_MS) {
      emit(listeningFrame(time, 0.03 + noise() * 0.02));
      return;
    }
    const s = p - LISTEN_MS;
    if (s < SOUND_MS) {
      // Exponential approach from startCents to endCents, small jitter; level decays.
      const k = 1 - Math.exp(-s / 650);
      const cents = spec.startCents + (spec.endCents - spec.startCents) * k + noise() * 0.6;
      const level = 0.85 * Math.exp(-s / 1400) + 0.04;
      emit({
        status: 'detected',
        reading: { frequency: midiToFrequency(spec.midi + cents / 100), clarity: 0.9 },
        level,
        time,
      });
      return;
    }
    emit({
      status: 'holding',
      reading: { frequency: midiToFrequency(spec.midi + spec.endCents / 100), clarity: 0.9 },
      level: 0.04 + noise() * 0.02,
      time,
    });
  };

  return {
    async start() {
      const err = ERRORS[scenario];
      await new Promise((r) => setTimeout(r, 350));
      if (err) throw new TunerError(err, `mock ${err}`);
      if (running) return;
      running = true;
      t0 = performance.now();
      timer = setInterval(tick, 1000 / 50);
    },
    stop() {
      running = false;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    onFrame(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    setMuted(m: boolean) {
      muted = m;
    },
    get running() {
      return running;
    },
  };
}
