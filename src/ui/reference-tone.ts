// Reference tone: pleasant sine + soft 2nd partial with a gentle envelope (~1.5 s).
// Uses its own AudioContext (created lazily on the first user gesture).

const DURATION = 1.5;

type Ctor = typeof AudioContext;

export class ReferenceTone {
  private ctx: AudioContext | null = null;
  private current: { stop: () => void } | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;

  get supported(): boolean {
    return getCtor() !== null;
  }

  /**
   * Plays `frequency`. `onStart`/`onEnd` bracket the audible period (used to mute the tuner
   * so it doesn't detect its own tone). Calling again while playing restarts the tone.
   */
  async play(frequency: number, onStart: () => void, onEnd: () => void): Promise<void> {
    const C = getCtor();
    if (!C) return;
    this.cancel(false);
    try {
      this.ctx ??= new C({ latencyHint: 'interactive' });
      if (this.ctx.state !== 'running') await this.ctx.resume();
    } catch {
      return;
    }
    const ctx = this.ctx;
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

    onStart();
    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      this.current = null;
      if (this.endTimer !== null) clearTimeout(this.endTimer);
      this.endTimer = null;
      onEnd();
    };
    this.current = {
      stop: () => {
        const now = ctx.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(0.0001, now, 0.02);
        osc1.stop(now + 0.1);
        osc2.stop(now + 0.1);
        finish();
      },
    };
    // Small tail so the room's echo isn't picked up as a note.
    this.endTimer = setTimeout(finish, (DURATION + 0.25) * 1000);
  }

  get playing(): boolean {
    return this.current !== null;
  }

  cancel(callEnd = true): void {
    if (!this.current) return;
    if (callEnd) this.current.stop();
    else {
      const c = this.current;
      this.current = null;
      c.stop();
    }
  }
}

function getCtor(): Ctor | null {
  const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}
