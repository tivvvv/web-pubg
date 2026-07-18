// 手写 2D simplex 噪声 + fbm
import { mulberry32 } from './utils';

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

// 8 方向梯度
const GRAD = new Float32Array([
  1, 1, -1, 1, 1, -1, -1, -1,
  1, 0, -1, 0, 0, 1, 0, -1,
]);

export class Noise2D {
  private perm: Uint8Array;

  constructor(seed: number) {
    const rng = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const tmp = p[i] as number;
      p[i] = p[j] as number;
      p[j] = tmp;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255] as number;
  }

  noise(xin: number, yin: number): number {
    const perm = this.perm;
    let n0 = 0;
    let n1 = 0;
    let n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      t0 *= t0;
      const g = ((perm[ii + (perm[jj] as number)] as number) & 7) * 2;
      n0 = t0 * t0 * ((GRAD[g] as number) * x0 + (GRAD[g + 1] as number) * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      t1 *= t1;
      const g = ((perm[ii + i1 + (perm[jj + j1] as number)] as number) & 7) * 2;
      n1 = t1 * t1 * ((GRAD[g] as number) * x1 + (GRAD[g + 1] as number) * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      t2 *= t2;
      const g = ((perm[ii + 1 + (perm[jj + 1] as number)] as number) & 7) * 2;
      n2 = t2 * t2 * ((GRAD[g] as number) * x2 + (GRAD[g + 1] as number) * y2);
    }
    return 70 * (n0 + n1 + n2);
  }
}

export function fbm(n: Noise2D, x: number, y: number, octaves: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * n.noise(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}
