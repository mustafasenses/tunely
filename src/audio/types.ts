// SHARED CONTRACT between the audio engine (src/audio/**) and the UI (src/ui/**).
// Do not change signatures without updating both sides.

export interface PitchReading {
  /** Detected fundamental frequency in Hz (already smoothed/stabilised). */
  frequency: number;
  /** Detection confidence 0..1. */
  clarity: number;
}

export type TunerStatus =
  /** Engine running, no usable pitch yet / signal too quiet. */
  | 'listening'
  /** A fresh, confident pitch reading this frame. */
  | 'detected'
  /** Signal dropped (e.g. kalimba tine decayed); `reading` is the last good one, kept on screen briefly. */
  | 'holding';

/**
 * Why the engine is running but not hearing anything (absent = audio is flowing normally):
 *  - 'suspended': the browser / OS paused audio processing (AudioContext not running, e.g. iOS
 *    interruption or autoplay policy) — a user gesture calling `resumeAudio()` usually fixes it;
 *  - 'muted': the microphone track is muted by the system (e.g. another app took the mic).
 */
export type TunerInputIssue = 'suspended' | 'muted';

export interface TunerFrame {
  status: TunerStatus;
  /** Null when status === 'listening'. */
  reading: PitchReading | null;
  /** Input level 0..1 (perceptually scaled, suitable for a level meter). Always present. */
  level: number;
  /** performance.now() timestamp. */
  time: number;
  /** Set while no fresh audio arrives for a known reason (see TunerInputIssue). */
  input?: TunerInputIssue;
}

export type TunerErrorCode =
  | 'permission-denied'
  | 'no-microphone'
  | 'insecure-context'
  | 'unsupported'
  /** The mic exists but cannot be opened (in use by another app / blocked by the OS). */
  | 'mic-busy'
  /** start() was cancelled by stop() before it finished (not an error to show). */
  | 'aborted'
  | 'unknown';

export class TunerError extends Error {
  readonly code: TunerErrorCode;
  constructor(code: TunerErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'TunerError';
  }
}

export interface TunerEngine {
  /**
   * Must be called from a user gesture. Requests the mic. Rejects with TunerError (code
   * 'aborted' if stop() was called before it finished).
   */
  start(): Promise<void>;
  /** Releases the mic and audio context resources. Safe to call repeatedly. */
  stop(): void;
  /** Subscribe to frames (~30-60/s while running). Returns unsubscribe fn. */
  onFrame(cb: (frame: TunerFrame) => void): () => void;
  /** Temporarily ignore input (e.g. while the app plays a reference tone) without releasing the mic. */
  setMuted(muted: boolean): void;
  readonly running: boolean;
  /**
   * Optional: retry resuming audio processing after it was suspended (frames report
   * `input: 'suspended'`). Call it from a user gesture; resolves true if audio is running.
   */
  resumeAudio?(): Promise<boolean>;
}
