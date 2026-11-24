// Reference tone: pleasant sine + soft 2nd partial with a gentle envelope (~1.5 s).
// Uses its own AudioContext (created lazily on the first user gesture).
//
// Every play() gets its own handle; state is only cleared by the handle that owns it, so a
// late callback of an old / cancelled tone can never stop or unmute a newer one.

const DURATION = 1.5;
/** Small tail after the tone so the room's echo isn't picked up as a note. */
const TAIL = 0.25;

type Ctor = typeof AudioContext;

interface Handle {
  onEnd: () => void;
  /** Fades the tone out quickly (null until the audio graph exists). */
  stopAudio: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

export class ReferenceTone {
  private ctx: AudioContext | null = null;
  private current: Handle | null = null;
  private readonly getCtor: () => Ctor | null;

  /** `getCtor` is injectable for tests (defaults to window.AudioContext / webkitAudioContext). */
  constructor(getCtorFn: () => Ctor | null = defaultCtor) {
    this.getCtor = getCtorFn;
  }

  get supported(): boolean {
    return this.getCtor() !== null;
  }

  /** True from the moment play() is called (also while the context is resuming) until the end. */
  get playing(): boolean {
    return this.current !== null;
  }

  /**
   * Plays `frequency`. `onStart`/`onEnd` bracket the tone (used to mute the tuner so it doesn't
   * detect its own tone); `onStart` runs immediately, `onEnd` exactly once — unless the tone
   * is replaced by another play() or cancelled with `cancel(false)`.
   */
  async play(frequency: number, onStart: () => void, onEnd: () => void): Promise<void> {
    const C = this.getCtor();
    if (!C) return;
    this.cancel(false); // a new tone replaces the old one silently
    const handle: Handle = { onEnd, stopAudio: null, timer: null, done: false };
    this.current = handle; // `playing` is true before any await: a second tap cancels this one
    onStart();
    let ctx: AudioContext;
    try {
      ctx = this.ctx ??= new C({ latencyHint: 'interactive' });
      if (ctx.state !== 'running') await ctx.resume();
    } catch {
      this.finish(handle, true);
      return;
    }
    if (handle.done) return; // cancelled / replaced while the context was resuming

    const t = ctx.currentTime + 0.02;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, t);
    master.gain.exponentialRampToValueAtTime(0.32, t + 0.04);
    master.gain.setTargetAtTime(0.22, t + 0.04, 0.25);
    master.gain.setTargetAtTime(0.0001, t + DURATION - 0.45, 0.12);
    master.connect(ctx.destination);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = frequency;
    osc1.connect(master);

    // Soft octave partial for warmth (quieter for high notes to stay gentle).
    const partialGain = ctx.createGain();
    partialGain.gain.value = frequency > 1000 ? 0.06 : 0.14;
    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = frequency * 2;
    osc2.connect(partialGain).connect(master);

    osc1.start(t);
    osc2.start(t);
    osc1.stop(t + DURATION + 0.1);
    osc2.stop(t + DURATION + 0.1);

    handle.stopAudio = () => {
      const now = ctx.currentTime;
      try {
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(0.0001, now, 0.02);
        osc1.stop(now + 0.1);
        osc2.stop(now + 0.1);
      } catch {
        /* already stopped */
      }
    };
    handle.timer = setTimeout(() => this.finish(handle, true, false), (DURATION + TAIL) * 1000);
  }

  /** Stops the current tone; `callEnd = false` skips its onEnd (e.g. when the tuner stops). */
  cancel(callEnd = true): void {
    const h = this.current;
    if (h) this.finish(h, callEnd);
  }

  private finish(h: Handle, callEnd: boolean, stopAudio = true): void {
    if (h.done) return;
    h.done = true;
    if (h.timer !== null) clearTimeout(h.timer);
    h.timer = null;
    if (stopAudio) h.stopAudio?.();
    if (this.current === h) this.current = null;
    if (callEnd) h.onEnd();
  }
}

function defaultCtor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}
