// Pitch-history strip: last ~5 s of cents deviation (canvas, DPR-aware).
import { tuneZone } from './logic';

const WINDOW_MS = 5000;
const RANGE = 30; // ±cents shown (values beyond are clamped to the edge)

interface Pt {
  t: number;
  /** null = gap (no fresh reading). */
  c: number | null;
  midi: number;
}

interface Palette {
  in: string;
  close: string;
  off: string;
  band: string;
  grid: string;
}

export class HistoryStrip {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private pts: Pt[] = [];
  private palette: Palette | null = null;
  private w = 0;
  private h = 0;

  constructor() {
    this.el = document.createElement('canvas');
    this.el.className = 'history-canvas';
    this.ctx = this.el.getContext('2d');
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.resize()).observe(this.el);
    }
  }

  /** Call after theme changes so colours are re-read from CSS tokens. */
  refreshPalette(): void {
    this.palette = null;
  }

  push(time: number, midi: number | null, cents: number | null): void {
    const last = this.pts[this.pts.length - 1];
    if (cents === null || midi === null) {
      if (last && last.c !== null) this.pts.push({ t: time, c: null, midi: -1 });
    } else {
      // A new note starts a new segment.
      if (last && last.c !== null && last.midi !== midi) this.pts.push({ t: time, c: null, midi: -1 });
      this.pts.push({ t: time, c: cents, midi });
    }
    const cutoff = time - WINDOW_MS - 200;
    let i = 0;
    while (i < this.pts.length && this.pts[i].t < cutoff) i++;
    if (i > 0) this.pts.splice(0, i);
  }

  clear(): void {
    this.pts = [];
  }

  private resize(): void {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.w = r.width;
    this.h = r.height;
    this.el.width = Math.max(1, Math.round(r.width * dpr));
    this.el.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private readPalette(): Palette {
    const cs = getComputedStyle(this.el);
    const v = (n: string): string => cs.getPropertyValue(n).trim() || '#888';
    return {
      in: v('--c-in'),
      close: v('--c-close'),
      off: v('--c-off'),
      band: v('--history-band'),
      grid: v('--history-grid'),
    };
  }

  draw(now: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.w) this.resize();
    const { w, h } = this;
    if (!w || !h) return;
    const p = (this.palette ??= this.readPalette());
    ctx.clearRect(0, 0, w, h);

    const pad = 4;
    const y = (c: number): number => h / 2 - (Math.max(-RANGE, Math.min(RANGE, c)) / RANGE) * (h / 2 - pad);
    const x = (t: number): number => w - ((now - t) / WINDOW_MS) * w;

    // In-tune band ±5 and centre line.
    ctx.fillStyle = p.band;
    ctx.fillRect(0, y(5), w, y(-5) - y(5));
    ctx.strokeStyle = p.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(h / 2) + 0.5);
    ctx.lineTo(w, Math.round(h / 2) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let prev: Pt | null = null;
    for (const pt of this.pts) {
      if (pt.c === null) {
        prev = null;
        continue;
      }
      if (prev && prev.c !== null) {
        const age = (now - pt.t) / WINDOW_MS;
        ctx.globalAlpha = Math.max(0.15, 1 - age * 0.85);
        const z = tuneZone(pt.c);
        ctx.strokeStyle = z === 'in' ? p.in : z === 'close' ? p.close : p.off;
        ctx.beginPath();
        ctx.moveTo(x(prev.t), y(prev.c));
        ctx.lineTo(x(pt.t), y(pt.c));
        ctx.stroke();
      }
      prev = pt;
    }
    ctx.globalAlpha = 1;
    // Current point marker.
    const last = this.pts[this.pts.length - 1];
    if (last && last.c !== null && now - last.t < 250) {
      const z = tuneZone(last.c);
      ctx.fillStyle = z === 'in' ? p.in : z === 'close' ? p.close : p.off;
      ctx.beginPath();
      ctx.arc(x(last.t), y(last.c), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
