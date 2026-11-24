// Screen Wake Lock with automatic re-acquire when the page becomes visible again.

export class KeepAwake {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;

  static get supported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  constructor() {
    if (!KeepAwake.supported) return;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.wanted) void this.acquire();
    });
  }

  set(on: boolean): void {
    this.wanted = on;
    if (!KeepAwake.supported) return;
    if (on) void this.acquire();
    else void this.release();
  }

  private async acquire(): Promise<void> {
    if (this.sentinel && !this.sentinel.released) return;
    if (document.visibilityState !== 'visible') return;
    try {
      this.sentinel = await navigator.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
      });
      if (!this.wanted) void this.release();
    } catch {
      this.sentinel = null; // e.g. battery saver or not allowed — fail silently
    }
  }

  private async release(): Promise<void> {
    const s = this.sentinel;
    this.sentinel = null;
    try {
      await s?.release();
    } catch {
      /* ignore */
    }
  }
}
