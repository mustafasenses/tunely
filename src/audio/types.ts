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

export interface TunerFrame {
  status: TunerStatus;
  /** Null when status === 'listening'. */
  reading: PitchReading | null;
  /** Input level 0..1 (perceptually scaled, suitable for a level meter). Always present. */
  level: number;
  /** performance.now() timestamp. */
  time: number;
}

export type TunerErrorCode =
  | 'permission-denied'
  | 'no-microphone'
  | 'insecure-context'
  | 'unsupported'
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
  /** Must be called from a user gesture. Requests the mic. Rejects with TunerError. */
  start(): Promise<void>;
  /** Releases the mic and audio context resources. Safe to call repeatedly. */
  stop(): void;
  /** Subscribe to frames (~30-60/s while running). Returns unsubscribe fn. */
  onFrame(cb: (frame: TunerFrame) => void): () => void;
  /** Temporarily ignore input (e.g. while the app plays a reference tone) without releasing the mic. */
  setMuted(muted: boolean): void;
  readonly running: boolean;
}
