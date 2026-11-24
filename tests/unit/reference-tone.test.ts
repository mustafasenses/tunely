import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReferenceTone } from '../../src/ui/reference-tone.ts';

/** Minimal fake Web Audio: records oscillators; resume() resolves when the test says so. */
class FakeParam {
  value = 0;
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
  setTargetAtTime() {}
  cancelScheduledValues() {}
}
class FakeNode {
  gain = new FakeParam();
  connect<T>(n: T): T {
    return n;
  }
}
class FakeOsc extends FakeNode {
  type = 'sine';
  frequency = new FakeParam();
  started = 0;
  stops: number[] = [];
  start(t: number) {
    this.started = t;
  }
  stop(t: number) {
    this.stops.push(t);
  }
}

let oscillators: FakeOsc[] = [];
let resumeGate: { resolve: () => void } | null = null;

class FakeCtx {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  destination = new FakeNode();
  resume(): Promise<void> {
    return new Promise((resolve) => {
      resumeGate = {
        resolve: () => {
          this.state = 'running';
          resolve();
        },
      };
    });
  }
  createGain() {
    return new FakeNode();
  }
  createOscillator() {
    const o = new FakeOsc();
    oscillators.push(o);
    return o;
  }
}

const tone = () => new ReferenceTone(() => FakeCtx as unknown as typeof AudioContext);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ReferenceTone', () => {
  beforeEach(() => {
    oscillators = [];
    resumeGate = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is "playing" before the context has resumed, so a double tap cannot start two tones', async () => {
    const t = tone();
    const ev: string[] = [];
    const p1 = t.play(440, () => ev.push('start1'), () => ev.push('end1'));
    expect(t.playing).toBe(true);
    // Second tap while resume() is pending → the app cancels instead of playing again.
    t.cancel();
    expect(ev).toEqual(['start1', 'end1']);
    expect(t.playing).toBe(false);
    resumeGate!.resolve();
    await p1;
    expect(oscillators).toHaveLength(0); // the cancelled play never builds its graph
    expect(t.playing).toBe(false);
  });

  it('a replaced tone never ends (or unmutes) the newer one', async () => {
    vi.useFakeTimers();
    const t = tone();
    const ev: string[] = [];
    const p1 = t.play(440, () => ev.push('start1'), () => ev.push('end1'));
    resumeGate!.resolve();
    await p1;
    expect(oscillators).toHaveLength(2);
    const p2 = t.play(262, () => ev.push('start2'), () => ev.push('end2'));
    await p2;
    expect(ev).toEqual(['start1', 'start2']); // replacing is silent: no end1
    expect(oscillators[0].stops.length).toBeGreaterThan(1); // first tone faded out
    vi.advanceTimersByTime(1000);
    expect(t.playing).toBe(true);
    vi.advanceTimersByTime(1000); // 1.5 s + 0.25 s tail
    expect(ev).toEqual(['start1', 'start2', 'end2']);
    expect(t.playing).toBe(false);
  });

  it('cancel(false) stops the sound without calling onEnd', async () => {
    const t = tone();
    const ev: string[] = [];
    const p = t.play(440, () => ev.push('start'), () => ev.push('end'));
    resumeGate!.resolve();
    await p;
    t.cancel(false);
    expect(ev).toEqual(['start']);
    expect(t.playing).toBe(false);
    expect(oscillators[0].stops.length).toBe(2); // scheduled stop + immediate fade-out stop
    await flush();
    expect(ev).toEqual(['start']);
  });

  it('ends exactly once (cancel after the natural end is a no-op)', async () => {
    vi.useFakeTimers();
    const t = tone();
    let ends = 0;
    const p = t.play(440, () => {}, () => ends++);
    resumeGate!.resolve();
    await p;
    vi.advanceTimersByTime(2000);
    t.cancel();
    t.cancel();
    expect(ends).toBe(1);
  });

  it('reports the end when the context cannot be resumed', async () => {
    const t = new ReferenceTone(
      () =>
        class extends FakeCtx {
          resume(): Promise<void> {
            return Promise.reject(new Error('NotAllowedError'));
          }
        } as unknown as typeof AudioContext,
    );
    const ev: string[] = [];
    await t.play(440, () => ev.push('start'), () => ev.push('end'));
    expect(ev).toEqual(['start', 'end']);
    expect(t.playing).toBe(false);
  });
});
