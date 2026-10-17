/**
 * Seeded statistics for the tier audit: means, percentile bootstrap intervals,
 * and the seed-requirement power calculation.
 *
 * Every random draw comes from `core/rng.js` (cyrb128 → sfc32) keyed by a
 * fixed seed string that names the tier and the cell it is drawn for, so the
 * same committed inputs always regenerate the same numbers — `reproduce.sh`
 * diffs the regenerated `tiers.json` against the committed one and fails on
 * any drift.
 *
 * Pure module: no `node:*` imports.
 *
 * @module
 */

import { nextFloat, nextInt, rngFromSeed } from '../../core/rng.js';

/** The power target for the seed-requirement calculation. */
export const POWER_TARGET = 0.8;

/** Two-sided alpha for the per-experiment test inside the power simulation. */
export const POWER_ALPHA = 0.05;

/** Minimum seed count the power calculation will ever answer. A paired test
 * needs two observations for a sample SD; a zero-variance gap therefore
 * resolves at 2, never at 1. */
export const MIN_SEEDS = 2;

/** Cap on the seed counts the power calculation extrapolates to. Beyond this
 * the empirical per-seed sample is stretched too thin to trust. */
export const MAX_SEEDS = 64;

/**
 * Student-t two-sided critical values at alpha = 0.05, indexed by df - 1 for
 * df = 1..30. Beyond 30, `tcrit` interpolates toward the normal limit 1.96.
 */
const T_CRIT_05 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
  2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

/**
 * Two-sided t critical value at alpha = 0.05 for df degrees of freedom.
 *
 * @param {number} df
 * @returns {number}
 */
export function tcrit(df) {
  if (df <= 1) return T_CRIT_05[0];
  if (df <= 30) return T_CRIT_05[df - 1];
  return 1.96 + (2.042 - 1.96) * Math.sqrt(30 / df);
}

/**
 * Arithmetic mean. Empty input is the caller's problem (rejected).
 *
 * @param {number[]} xs
 * @returns {number}
 */
export function mean(xs) {
  if (xs.length === 0) throw new Error('mean of empty array');
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/**
 * Sample SD (ddof = 1). Returns 0 for n < 2 or for a constant sample, which
 * is what the power calculation's zero-variance branch keys on.
 *
 * @param {number[]} xs
 * @returns {number}
 */
export function sampleSd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) * (x - m);
  return Math.sqrt(ss / (xs.length - 1));
}

/**
 * A seeded uniform stream. Every statistic that draws gets its own stream
 * keyed by an explicit label, so adding a statistic never reshuffles
 * another one's randomness.
 *
 * @param {string} seed
 * @returns {{ float: () => number, int: (lo: number, hi: number) => number }}
 */
export function seededStream(seed) {
  let state = rngFromSeed(seed);
  return {
    float: () => {
      const r = nextFloat(state);
      state = r.state;
      return r.value;
    },
    int: (lo, hi) => {
      const r = nextInt(state, lo, hi);
      state = r.state;
      return r.value;
    },
  };
}

/**
 * Percentile bootstrap 95% CI for the mean of `values`, 10,000 resamples.
 *
 * @param {number[]} values
 * @param {string} seed
 * @param {number} [draws]
 * @returns {[number, number]} Point interval when n = 1 or the sample is
 *   constant (every resample equals the mean).
 */
export function bootstrapCi95(values, seed, draws = 10_000) {
  if (values.length === 0) throw new Error('bootstrap of empty array');
  if (values.length === 1) return [values[0], values[0]];
  const stream = seededStream(seed);
  const means = new Array(draws);
  const n = values.length;
  for (let d = 0; d < draws; d++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[stream.int(0, n - 1)];
    means[d] = sum / n;
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * (draws - 1))], means[Math.floor(0.975 * (draws - 1))]];
}

/**
 * Percentile 95% bootstrap CI for an efficiency-tier value: each resample
 * draws episodes jointly (score + solved flag) and computes the official
 * tier statistic `min(solvedFraction, mean(e))` (scoring/score.js).
 *
 * @param {{ e: number, solved: boolean }[]} pairs Episode scores with their solved flags.
 * @param {string} seed Deterministic bootstrap seed.
 * @param {number} [draws]
 * @returns {[number, number]} The 2.5th and 97.5th percentile of the statistic.
 */
export function bootstrapEfficiencyCi95(pairs, seed, draws = 10_000) {
  if (pairs.length === 0) throw new Error('bootstrap of empty array');
  if (pairs.length === 1) {
    const v = Math.min(pairs[0].solved ? 1 : 0, pairs[0].e);
    return [v, v];
  }
  const stream = seededStream(seed);
  const stats = new Array(draws);
  const n = pairs.length;
  for (let d = 0; d < draws; d++) {
    let sum = 0;
    let solved = 0;
    for (let i = 0; i < n; i++) {
      const p = pairs[stream.int(0, n - 1)];
      sum += p.e;
      if (p.solved) solved++;
    }
    stats[d] = Math.min(solved / n, sum / n);
  }
  stats.sort((a, b) => a - b);
  return [stats[Math.floor(0.025 * (draws - 1))], stats[Math.floor(0.975 * (draws - 1))]];
}

/**
 * Bootstrap power: the probability that n seeds drawn (with replacement)
 * from the empirical paired-difference distribution support the difference
 * at two-sided alpha = 0.05.
 *
 * Each experiment draws n paired differences, runs a one-sample t-test on
 * them (a zero-SD sample is "significant" exactly when its mean is nonzero),
 * and power is the significant fraction over `experiments` runs. A constant
 * positive gap therefore resolves at {@link MIN_SEEDS}; identical
 * distributions (every difference 0) never resolve at any n.
 *
 * @param {number} n
 * @param {number[]} diffs Empirical paired differences.
 * @param {string} seed
 * @param {number} [experiments]
 * @returns {number} Power in [0, 1].
 */
export function powerAtN(n, diffs, seed, experiments = 2000) {
  if (diffs.length === 0) throw new Error('power with no observed differences');
  if (n < 1) throw new Error(`power at n=${n}`);
  const stream = seededStream(`${seed}/n${n}`);
  const total = diffs.length;
  let significant = 0;
  for (let e = 0; e < experiments; e++) {
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const d = diffs[stream.int(0, total - 1)];
      sum += d;
      sumSq += d * d;
    }
    const m = sum / n;
    const variance = n < 2 ? 0 : (sumSq - (sum * sum) / n) / (n - 1);
    const sd = Math.sqrt(Math.max(0, variance));
    if (sd === 0) {
      if (m !== 0) significant += 1;
    } else if (Math.abs(m) / (sd / Math.sqrt(n)) > tcrit(n - 1)) {
      significant += 1;
    }
  }
  return significant / experiments;
}

/**
 * Seeds needed for 80% power to separate the paired differences from zero.
 * Walks n = 2, 3, … up to {@link MAX_SEEDS}; null means the empirical
 * distribution never reaches the target within the cap.
 *
 * @param {number[]} diffs
 * @param {string} seed
 * @returns {{ needed: number | null, powerAt12: number, powerAtSeeds: Record<number, number> }}
 */
export function seedsNeeded(diffs, seed) {
  /** @type {Record<number, number>} */
  const powerAtSeeds = {};
  let needed = /** @type {number | null} */ (null);
  for (let n = MIN_SEEDS; n <= MAX_SEEDS; n++) {
    const p = powerAtN(n, diffs, seed);
    powerAtSeeds[n] = p;
    if (needed === null && p >= POWER_TARGET) needed = n;
  }
  return { needed, powerAt12: powerAtSeeds[12], powerAtSeeds };
}

/**
 * Round to 6 decimals for every committed number, so JSON stays stable.
 *
 * @param {number} x
 * @returns {number}
 */
export function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}
