// Web Audio front-end: microphone → (AudioWorklet | AnalyserNode) → TunerPipeline → frames.
//
// Capture: an AudioWorklet posts mono 512-sample chunks to the main thread, where they are
// kept in a ring buffer; if AudioWorklet is unavailable or fails to load, an AnalyserNode's
// time-domain snapshot is used instead (same analysis, slightly less precise timing).
// Analysis runs on the main thread on requestAnimationFrame, throttled to ≤ 60 Hz; one pass
// costs ~0.3 ms for notes above ~190 Hz and < 2 ms for the lowest bass notes, so the UI
// stays smooth without the complexity (and cross-origin-isolation requirements for
// SharedArrayBuffer) of a worker. rAF also pauses analysis in background tabs for free.

import { TunerError, type TunerEngine, type TunerErrorCode, type TunerFrame } from './types.ts';
import { TunerPipeline } from './pipeline.ts';
import captureWorkletUrl from './capture-worklet.ts?worker&url';

const MIN_FRAME_INTERVAL_MS = 15; // ≤ ~60 analyses per second even on 120 Hz displays
const WORKLET_NAME = 'tunely-capture';

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | undefined {
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext;
}

function mapMediaError(err: unknown): TunerError {
  const name = (err as { name?: string } | null)?.name ?? '';
  const message = (err as { message?: string } | null)?.message;
  let code: TunerErrorCode;
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      code = 'permission-denied';
      break;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      code = 'no-microphone';
      break;
    case 'NotReadableError':
    case 'TrackStartError':
      // Mic exists but cannot be opened (in use by another app / OS-level block).
      code = 'unknown';
      break;
    case 'TypeError':
      code = window.isSecureContext ? 'unsupported' : 'insecure-context';
      break;
    default:
      code = 'unknown';
  }
  return new TunerError(code, message || name || code);
}

/** Fixed-size ring buffer of the newest samples. */
class SampleRing {
  private readonly buf: Float32Array;
  private write = 0;

  constructor(capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  push(chunk: Float32Array): void {
    const cap = this.buf.length;
    let src = chunk;
    if (src.length > cap) src = src.subarray(src.length - cap);
    const first = Math.min(src.length, cap - this.write);
    this.buf.set(src.subarray(0, first), this.write);
    if (first < src.length) this.buf.set(src.subarray(first), 0);
    this.write = (this.write + src.length) % cap;
  }

  /** Copies the newest out.length samples into out (oldest first). */
  read(out: Float32Array): void {
    const cap = this.buf.length;
    const n = Math.min(out.length, cap);
    let start = this.write - n;
    if (start < 0) start += cap;
    const first = Math.min(n, cap - start);
    out.set(this.buf.subarray(start, start + first), 0);
    if (first < n) out.set(this.buf.subarray(0, n - first), first);
  }
}

/** Everything one successful start() owns; released as a unit. */
interface Session {
  ctx: AudioContext;
  stream: MediaStream;
  pipeline: TunerPipeline;
  frameBuf: Float32Array<ArrayBuffer>;
  source?: MediaStreamAudioSourceNode;
  sink?: GainNode;
  worklet?: AudioWorkletNode;
  ring?: SampleRing;
  analyser?: AnalyserNode;
}

function releaseSession(s: Session): void {
  if (s.worklet) {
    s.worklet.port.onmessage = null;
    try {
      s.worklet.port.postMessage('stop');
    } catch {
      /* ignore */
    }
    s.worklet.disconnect();
  }
  s.analyser?.disconnect();
  s.source?.disconnect();
  s.sink?.disconnect();
  s.ctx.onstatechange = null;
  for (const t of s.stream.getTracks()) {
    t.onended = null;
    t.stop();
  }
  if (s.ctx.state !== 'closed') s.ctx.close().catch(() => {});
}

export function createTunerEngine(): TunerEngine {
  const listeners = new Set<(frame: TunerFrame) => void>();
  let running = false;
  let muted = false;
  /** Incremented on every start/stop so a stop() during an in-flight start() wins. */
  let generation = 0;
  let startPromise: Promise<void> | null = null;
  let session: Session | null = null;
  let rafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let lastTick = -Infinity;

  const emit = (frame: TunerFrame): void => {
    for (const cb of listeners) {
      try {
        cb(frame);
      } catch (e) {
        console.error(e);
      }
    }
  };

  const tick = (): void => {
    rafId = null;
    timerId = null;
    const s = session;
    if (!running || !s) return;
    const now = performance.now();
    if (now - lastTick >= MIN_FRAME_INTERVAL_MS) {
      lastTick = now;
      if (s.ring) s.ring.read(s.frameBuf);
      else if (s.analyser) s.analyser.getFloatTimeDomainData(s.frameBuf);
      emit(s.pipeline.process(s.frameBuf, now));
    }
    schedule();
  };

  const schedule = (): void => {
    if (!running || rafId !== null || timerId !== null) return;
    if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(tick);
    else timerId = setTimeout(tick, MIN_FRAME_INTERVAL_MS);
  };

  const resumeContext = (): void => {
    const ctx = session?.ctx;
    if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(() => {});
  };

  const onVisibility = (): void => {
    if (document.visibilityState !== 'visible' || !running) return;
    // iOS may suspend/"interrupt" the context while backgrounded; restart it and drop the
    // stale stabiliser state (the time gap would otherwise look like one long frame).
    resumeContext();
    session?.pipeline.reset();
    lastTick = -Infinity;
    schedule();
  };

  const teardown = (): void => {
    if (rafId !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    if (timerId !== null) clearTimeout(timerId);
    rafId = null;
    timerId = null;
    document.removeEventListener('visibilitychange', onVisibility);
    if (session) releaseSession(session);
    session = null;
    running = false;
  };

  async function doStart(gen: number): Promise<void> {
    if (typeof window === 'undefined') throw new TunerError('unsupported');
    if (!window.isSecureContext) {
      throw new TunerError('insecure-context', 'Microphone access requires HTTPS (or localhost).');
    }
    const AC = getAudioContextCtor();
    if (!navigator.mediaDevices?.getUserMedia || !AC) {
      throw new TunerError('unsupported', 'getUserMedia / Web Audio not available.');
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 1 },
        },
        video: false,
      });
    } catch (err) {
      throw mapMediaError(err);
    }
    if (gen !== generation) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    // The context is created after the mic is open: Chrome/Firefox allow it thanks to the
    // user activation that triggered start(), Safari allows audio while capturing, and on iOS
    // this avoids a sample-rate switch of an already running context when the audio session
    // becomes play-and-record. Don't force a sampleRate — use the hardware rate (44.1/48 kHz).
    let ctx: AudioContext;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      throw new TunerError('unsupported', (err as Error)?.message);
    }
    const pipeline = new TunerPipeline(ctx.sampleRate);
    const s: Session = { ctx, stream, pipeline, frameBuf: new Float32Array(pipeline.analysisLength) };
    const cancelled = (): boolean => {
      if (gen === generation) return false;
      releaseSession(s);
      return true;
    };

    try {
      try {
        await ctx.resume();
      } catch {
        /* retried on visibility / state change */
      }
      if (cancelled()) return;

      s.source = ctx.createMediaStreamSource(stream);
      // Silent sink keeps the graph pulled on every browser without making any sound.
      s.sink = ctx.createGain();
      s.sink.gain.value = 0;
      s.sink.connect(ctx.destination);

      if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
        try {
          await ctx.audioWorklet.addModule(captureWorkletUrl);
          if (cancelled()) return;
          const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
          });
          const ring = new SampleRing(pipeline.analysisLength * 2);
          node.port.onmessage = (e: MessageEvent<Float32Array>) => ring.push(e.data);
          s.source.connect(node);
          node.connect(s.sink);
          s.worklet = node;
          s.ring = ring;
        } catch (err) {
          if (cancelled()) return;
          console.warn('Tunely: AudioWorklet unavailable, using AnalyserNode fallback', err);
        }
      }
      if (!s.worklet) {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = Math.min(32768, pipeline.analysisLength);
        analyser.smoothingTimeConstant = 0;
        if (analyser.fftSize < s.frameBuf.length) s.frameBuf = new Float32Array(analyser.fftSize);
        s.source.connect(analyser);
        analyser.connect(s.sink);
        s.analyser = analyser;
      }
    } catch (err) {
      releaseSession(s);
      throw err;
    }

    pipeline.setMuted(muted, performance.now());
    ctx.onstatechange = () => {
      if (running && document.visibilityState === 'visible') resumeContext();
    };
    for (const t of stream.getAudioTracks()) {
      t.onended = () => {
        // Device unplugged / permission revoked: stop cleanly (UI sees `running === false`).
        if (session === s) engine.stop();
      };
    }
    session = s;
    running = true;
    document.addEventListener('visibilitychange', onVisibility);
    lastTick = -Infinity;
    schedule();
  }

  const engine: TunerEngine = {
    start(): Promise<void> {
      if (running) return Promise.resolve();
      if (startPromise) return startPromise;
      const gen = ++generation;
      const p = doStart(gen)
        .catch((err: unknown) => {
          throw err instanceof TunerError ? err : new TunerError('unknown', (err as Error)?.message);
        })
        .finally(() => {
          if (startPromise === p) startPromise = null;
        });
      startPromise = p;
      return p;
    },

    stop(): void {
      generation++;
      startPromise = null;
      teardown();
    },

    onFrame(cb: (frame: TunerFrame) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    setMuted(m: boolean): void {
      muted = m;
      session?.pipeline.setMuted(m, performance.now());
    },

    get running(): boolean {
      return running;
    },
  };
  return engine;
}
