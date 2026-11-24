// Web Audio front-end: microphone → (AudioWorklet | AnalyserNode) → TunerPipeline → frames.
//
// Capture: an AudioWorklet posts mono 512-sample chunks to the main thread, where they are
// kept in a ring buffer; if AudioWorklet is unavailable or fails to load, an AnalyserNode's
// time-domain snapshot is used instead (same analysis, slightly less precise timing).
// Analysis runs on the main thread on requestAnimationFrame, throttled to ≤ 60 Hz; one pass
// costs ~0.3 ms for notes above ~190 Hz and < 2 ms for the lowest bass notes, so the UI
// stays smooth without the complexity (and cross-origin-isolation requirements for
// SharedArrayBuffer) of a worker. rAF also pauses analysis in background tabs for free.
//
// Input health: analysis only runs on fresh audio. While the context is not running
// (suspended / iOS "interrupted"), the track is muted by the OS, or no new samples have
// arrived for > STALL_MS, frames are produced by `pipeline.idle()` (the last reading is held,
// then released; no re-analysis of a stale buffer) and carry `input` so the UI can explain.
// Leading digital silence from a starting device is skipped the same way.

import {
  TunerError,
  type TunerEngine,
  type TunerErrorCode,
  type TunerFrame,
  type TunerInputIssue,
} from './types.ts';
import { TunerPipeline } from './pipeline.ts';
import captureWorkletUrl from './capture-worklet.ts?worker&url';

const MIN_FRAME_INTERVAL_MS = 15; // ≤ ~60 analyses per second even on 120 Hz displays
const WORKLET_NAME = 'tunely-capture';
/** No new samples for this long → the input is stalled; stop analysing the old buffer. */
const STALL_MS = 100;
/** |sample| below this is digital silence (a starting / blocked device delivers zeros). */
const SILENT_SAMPLE = 1e-7;

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
    case 'AbortError':
      // Mic exists but cannot be opened (in use by another app / OS-level block).
      code = 'mic-busy';
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
  /** Samples pushed since the last clear(). */
  received = 0;
  /** performance.now() of the last push. */
  lastPush = -Infinity;
  /** True once a non-silent sample was pushed since the last clear(). */
  heardAudio = false;

  constructor(capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  /** Forget everything (after a stall the old audio must not be analysed again). */
  clear(): void {
    this.buf.fill(0);
    this.write = 0;
    this.received = 0;
    this.heardAudio = false;
  }

  push(chunk: Float32Array, now: number): void {
    this.received += chunk.length;
    this.lastPush = now;
    if (!this.heardAudio) {
      let i = 0;
      while (i < chunk.length && Math.abs(chunk[i]) < SILENT_SAMPLE) i++;
      if (i === chunk.length) return; // still leading digital silence: keep the ring empty
      this.heardAudio = true;
    }
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
  /** Analyser path: context time at the last tick (stall detection) and audio seen yet. */
  lastCtxTime?: number;
  lastCtxAdvance?: number;
  heardAudio?: boolean;
  /** True while the previous frame had no usable input (→ clear the ring on recovery). */
  wasIdle: boolean;
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

  /** Why this session cannot be analysed right now (undefined = fresh audio is available). */
  const inputIssue = (s: Session, now: number): TunerInputIssue | 'stalled' | 'silent' | undefined => {
    if (s.ctx.state !== 'running') return 'suspended';
    if (s.stream.getAudioTracks().some((t) => t.muted)) return 'muted';
    if (s.ring) {
      if (now - s.ring.lastPush > STALL_MS) return 'stalled';
      if (!s.ring.heardAudio) return 'silent';
      return undefined;
    }
    // AnalyserNode path: no sample counter, but the context clock must be advancing.
    const ct = s.ctx.currentTime;
    if (s.lastCtxTime === undefined || ct !== s.lastCtxTime) {
      s.lastCtxTime = ct;
      s.lastCtxAdvance = now;
    } else if (now - (s.lastCtxAdvance ?? now) > STALL_MS) {
      return 'stalled';
    }
    return undefined;
  };

  const tick = (): void => {
    rafId = null;
    timerId = null;
    const s = session;
    if (!running || !s) return;
    const now = performance.now();
    if (now - lastTick >= MIN_FRAME_INTERVAL_MS) {
      lastTick = now;
      let issue = inputIssue(s, now);
      if (!issue && s.analyser) {
        s.analyser.getFloatTimeDomainData(s.frameBuf);
        if (!s.heardAudio) {
          s.heardAudio = s.frameBuf.some((v) => Math.abs(v) >= SILENT_SAMPLE);
          if (!s.heardAudio) issue = 'silent';
        }
      }
      if (issue) {
        if (!s.wasIdle) {
          s.wasIdle = true;
          s.ring?.clear(); // never re-analyse audio from before the gap
        }
        const frame = s.pipeline.idle(now);
        if (issue === 'suspended' || issue === 'muted') frame.input = issue;
        emit(frame);
      } else {
        s.wasIdle = false;
        if (s.ring) s.ring.read(s.frameBuf);
        emit(s.pipeline.process(s.frameBuf, now));
      }
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

  const abortedError = (): TunerError => new TunerError('aborted', 'start() was cancelled by stop()');

  async function doStart(gen: number): Promise<void> {
    if (typeof window === 'undefined') throw new TunerError('unsupported');
    if (!window.isSecureContext) {
      throw new TunerError('insecure-context', 'Microphone access requires HTTPS (or localhost).');
    }
    const AC = getAudioContextCtor();
    if (!navigator.mediaDevices?.getUserMedia || !AC) {
      throw new TunerError('unsupported', 'getUserMedia / Web Audio not available.');
    }
    // Capture needs an AudioWorklet or, as a fallback, AnalyserNode float time-domain data
    // (missing in old Safari): fail up front rather than "Listening…" forever.
    const canWorklet = typeof AudioWorkletNode === 'function' && 'audioWorklet' in AC.prototype;
    const canAnalyser =
      typeof AnalyserNode === 'function' && typeof AnalyserNode.prototype.getFloatTimeDomainData === 'function';
    if (!canWorklet && !canAnalyser) {
      throw new TunerError('unsupported', 'Neither AudioWorklet nor AnalyserNode.getFloatTimeDomainData is available.');
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
      throw abortedError();
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
    const s: Session = { ctx, stream, pipeline, frameBuf: new Float32Array(pipeline.analysisLength), wasIdle: false };
    /** stop() was called meanwhile: release everything and reject with 'aborted'. */
    const cancelled = (): void => {
      if (gen === generation) return;
      releaseSession(s);
      throw abortedError();
    };

    try {
      try {
        await ctx.resume();
      } catch {
        /* retried on visibility / state change */
      }
      cancelled();

      s.source = ctx.createMediaStreamSource(stream);
      // Silent sink keeps the graph pulled on every browser without making any sound.
      s.sink = ctx.createGain();
      s.sink.gain.value = 0;
      s.sink.connect(ctx.destination);

      if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
        try {
          await ctx.audioWorklet.addModule(captureWorkletUrl);
          cancelled();
          const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
          });
          const ring = new SampleRing(pipeline.analysisLength * 2);
          node.port.onmessage = (e: MessageEvent<Float32Array>) => ring.push(e.data, performance.now());
          s.source.connect(node);
          node.connect(s.sink);
          s.worklet = node;
          s.ring = ring;
        } catch (err) {
          if (err instanceof TunerError) throw err;
          cancelled();
          console.warn('Tunely: AudioWorklet unavailable, using AnalyserNode fallback', err);
        }
      }
      if (!s.worklet) {
        if (!canAnalyser) throw new TunerError('unsupported', 'AudioWorklet failed and no AnalyserNode fallback.');
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
      // Suspended / iOS "interrupted" (call, Siri, other app): try to get audio back. When the
      // interruption ends iOS moves to 'running' on its own; if it needs a gesture, frames
      // report input: 'suspended' and the UI offers resumeAudio().
      if (running && session === s && ctx.state !== 'running' && document.visibilityState === 'visible') {
        resumeContext();
      }
    };
    for (const t of stream.getAudioTracks()) {
      t.onended = () => {
        // Device unplugged / permission revoked: stop cleanly. A final listening frame makes the
        // UI drop the stale reading; it then sees `running === false` and offers a way back.
        if (session !== s) return;
        engine.stop();
        emit({ status: 'listening', reading: null, level: 0, time: performance.now() });
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

    async resumeAudio(): Promise<boolean> {
      const ctx = session?.ctx;
      if (!ctx || ctx.state === 'closed') return false;
      if (ctx.state !== 'running') {
        try {
          await ctx.resume();
        } catch {
          /* still suspended */
        }
      }
      return (ctx.state as AudioContextState) === 'running';
    },
  };
  return engine;
}
