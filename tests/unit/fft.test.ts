import { describe, expect, it } from 'vitest';
import { fft, isPowerOfTwo, nextPowerOfTwo } from '../../src/audio/fft.ts';
import { rng } from './helpers/synth.ts';

describe('fft', () => {
  it('matches a naive DFT and inverts exactly', () => {
    const n = 64;
    const r = rng(1);
    const xr = Float64Array.from({ length: n }, () => r() - 0.5);
    const xi = Float64Array.from({ length: n }, () => r() - 0.5);
    const re = xr.slice();
    const im = xi.slice();
    fft(re, im);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += xr[t] * Math.cos(a) - xi[t] * Math.sin(a);
        si += xr[t] * Math.sin(a) + xi[t] * Math.cos(a);
      }
      expect(re[k]).toBeCloseTo(sr, 10);
      expect(im[k]).toBeCloseTo(si, 10);
    }
    fft(re, im, true);
    for (let t = 0; t < n; t++) {
      expect(re[t]).toBeCloseTo(xr[t], 12);
      expect(im[t]).toBeCloseTo(xi[t], 12);
    }
  });

  it('rejects non-power-of-two sizes; helpers', () => {
    expect(() => fft(new Float64Array(12), new Float64Array(12))).toThrow(RangeError);
    expect(isPowerOfTwo(1024)).toBe(true);
    expect(isPowerOfTwo(1000)).toBe(false);
    expect(nextPowerOfTwo(1000)).toBe(1024);
    expect(nextPowerOfTwo(1024)).toBe(1024);
  });
});
