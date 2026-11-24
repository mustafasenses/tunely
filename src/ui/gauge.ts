// ±50 cent needle gauge (SVG). Needle animated with a spring in the app's rAF loop.
import { centsToAngle, springStep } from './logic';

const CX = 160;
const CY = 174;
const R = 136;
export const MAX_DEG = 62;

const rad = (deg: number): number => ((deg - 90) * Math.PI) / 180;
const pt = (deg: number, r: number): [number, number] => [CX + r * Math.cos(rad(deg)), CY + r * Math.sin(rad(deg))];
const f = (n: number): string => n.toFixed(2);

function arc(c0: number, c1: number, r: number): string {
  const a0 = centsToAngle(c0, MAX_DEG);
  const a1 = centsToAngle(c1, MAX_DEG);
  const [x0, y0] = pt(a0, r);
  const [x1, y1] = pt(a1, r);
  return `M${f(x0)} ${f(y0)}A${r} ${r} 0 0 1 ${f(x1)} ${f(y1)}`;
}

function ticks(): string {
  let out = '';
  for (let c = -50; c <= 50; c += 5) {
    const major = c % 25 === 0;
    const a = centsToAngle(c, MAX_DEG);
    const [x0, y0] = pt(a, R - (c === 0 ? 30 : major ? 24 : 17));
    const [x1, y1] = pt(a, R - 9);
    out += `<line class="tick${major ? ' major' : ''}${c === 0 ? ' zero' : ''}" x1="${f(x0)}" y1="${f(y0)}" x2="${f(x1)}" y2="${f(y1)}"/>`;
  }
  return out;
}

function labels(): string {
  return [-50, -25, 0, 25, 50]
    .map((c) => {
      const [x, y] = pt(centsToAngle(c, MAX_DEG), R + 17);
      const text = c === 0 ? '0' : c > 0 ? `+${c}` : `−${-c}`;
      return `<text class="scale-label" x="${f(x)}" y="${f(y)}">${text}</text>`;
    })
    .join('');
}

export class Gauge {
  readonly el: SVGSVGElement;
  private needle: SVGGElement;
  private pos = 0;
  private vel = 0;
  private target = 0;
  private readonly reducedMotion: () => boolean;

  constructor(reducedMotion: () => boolean) {
    this.reducedMotion = reducedMotion;
    const [lx, ly] = pt(-MAX_DEG, R);
    const [rx, ry] = pt(MAX_DEG, R);
    const wrap = document.createElement('div');
    wrap.innerHTML = `<svg class="gauge" viewBox="0 0 320 200" aria-hidden="true" focusable="false">
      <path class="track" d="${arc(-50, 50, R)}"/>
      <path class="zone-close" d="${arc(-15, 15, R)}"/>
      <path class="zone-in" d="${arc(-5, 5, R)}"/>
      ${ticks()}
      ${labels()}
      <text class="end-sym" x="${f(lx - 4)}" y="${f(ly + 30)}">♭</text>
      <text class="end-sym" x="${f(rx + 4)}" y="${f(ry + 30)}">♯</text>
      <g class="needle" transform="rotate(0 ${CX} ${CY})">
        <path class="needle-body" d="M${CX - 3.2} ${CY} L${CX - 0.9} ${CY - R + 10} Q${CX} ${CY - R + 6} ${CX + 0.9} ${CY - R + 10} L${CX + 3.2} ${CY} Z"/>
        <circle class="needle-hub" cx="${CX}" cy="${CY}" r="10"/>
        <circle class="needle-hub-dot" cx="${CX}" cy="${CY}" r="3.5"/>
      </g>
    </svg>`;
    this.el = wrap.firstElementChild as SVGSVGElement;
    this.needle = this.el.querySelector('.needle') as SVGGElement;
  }

  setCents(cents: number | null): void {
    this.target = cents === null ? 0 : centsToAngle(cents, MAX_DEG);
  }

  /** Advance animation; returns true while still moving. */
  step(dt: number): boolean {
    if (this.reducedMotion()) {
      this.pos = this.target;
      this.vel = 0;
    } else {
      [this.pos, this.vel] = springStep(this.pos, this.vel, this.target, dt);
      if (Math.abs(this.target - this.pos) < 0.01 && Math.abs(this.vel) < 0.01) {
        this.pos = this.target;
        this.vel = 0;
      }
    }
    this.needle.setAttribute('transform', `rotate(${this.pos.toFixed(3)} ${CX} ${CY})`);
    return this.pos !== this.target;
  }
}
