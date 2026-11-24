// Minimal iterative radix-2 complex FFT (no dependencies).
// Plans (bit-reversal permutation + twiddle tables) are cached per size, so repeated
// transforms of the same length allocate nothing.

interface FftPlan {
  rev: Uint32Array;
  cos: Float64Array;
  sin: Float64Array;
}

const plans = new Map<number, FftPlan>();

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function getPlan(n: number): FftPlan {
  let plan = plans.get(n);
  if (plan) return plan;
  if (!isPowerOfTwo(n)) throw new RangeError(`FFT size must be a power of two, got ${n}`);
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0, v = i; b < bits; b++, v >>= 1) r = (r << 1) | (v & 1);
    rev[i] = r;
  }
  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }
  plan = { rev, cos, sin };
  plans.set(n, plan);
  return plan;
}

/**
 * In-place complex FFT. `re` and `im` must have the same power-of-two length.
 * Forward: X[k] = sum x[n] e^{-2πikn/N}. Inverse includes the 1/N scale.
 */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (im.length !== n) throw new RangeError('re/im length mismatch');
  if (n <= 1) return;
  const { rev, cos, sin } = getPlan(n);

  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }

  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k];
        const wi = sign * sin[k];
        const a = start + j;
        const b = a + half;
        const br = re[b];
        const bi = im[b];
        const tr = wr * br - wi * bi;
        const ti = wr * bi + wi * br;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }

  if (inverse) {
    const s = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }
}
