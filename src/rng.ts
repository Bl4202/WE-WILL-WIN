/**
 * Seeded PRNG (mulberry32). All stochastic draws in the simulation go through
 * one instance stored in the sim state, so a given seed + input sequence
 * reproduces exactly — the determinism discipline of GDD §4.3/§6.3, kept from
 * the very first prototype.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    this.state = this.state >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /**
   * Sample an index from an array of non-negative weights.
   * Returns -1 if all weights are zero.
   */
  weightedIndex(weights: number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) return -1;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }
}
