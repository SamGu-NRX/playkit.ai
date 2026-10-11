/**
 * Paired analysis across arms: arms share the same frozen spawn histories per
 * seed, so per-seed outcome differences are paired observations. This module
 * computes percentile-bootstrap confidence intervals for paired differences
 * of final score and max tile reach, plus paired tile-reach win counts.
 *
 * These are MACHINE-SPECIFIC measurements on n = games-per-arm seeds; they
 * carry no universal latency or performance claim.
 */

export function percentile(sortedValues, q) {
  if (sortedValues.length === 0) return null;
  const pos = (sortedValues.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

/** Deterministic bootstrap seeded by mulberry32 for reproducible intervals. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function nextRandom() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {number[]} base   per-seed outcomes for the baseline arm (sorted by seed)
 * @param {number[]} other  per-seed outcomes for the comparison arm (same seed order)
 * @param {object} options  { iterations = 10000, seed = 20261010 }
 */
export function pairedDifferenceCI(base, other, options = {}) {
  const iterations = options.iterations ?? 10000;
  const seed = options.seed ?? 20261010;
  if (base.length !== other.length || base.length === 0) {
    return { error: "paired arms must have equal nonzero seed counts" };
  }
  const diffs = base.map((v, i) => other[i] - v);
  const rng = mulberry32(seed);
  const boot = [];
  for (let b = 0; b < iterations; b += 1) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i += 1) {
      sum += diffs[Math.floor(rng() * diffs.length)];
    }
    boot.push(sum / diffs.length);
  }
  boot.sort((a, b) => a - b);
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  return {
    n: diffs.length,
    meanDiff,
    ciLow: percentile(boot, 0.025),
    ciHigh: percentile(boot, 0.975),
    iterations,
    seed,
  };
}

/**
 * Build the paired comparison table for a results run.
 * @param {Array} records  game records for all arms (raw run output)
 * @param {object} options { baseline = "naive", metric = "finalScore" | "maxTileReached" }
 */
export function pairedIntervals(records, options = {}) {
  const baseline = options.baseline ?? "naive";
  const byArm = new Map();
  for (const record of records) {
    if (!byArm.has(record.arm)) byArm.set(record.arm, new Map());
    byArm.get(record.arm).set(record.seed, record);
  }
  const baseMap = byArm.get(baseline);
  if (!baseMap) return { error: `baseline arm ${baseline} missing` };
  const seeds = [...baseMap.keys()].sort((a, b) => a - b);

  const pairs = {};
  for (const [arm, seedMap] of byArm) {
    if (arm === baseline) continue;
    const sharedSeeds = seeds.filter((s) => seedMap.has(s));
    const base = sharedSeeds.map((s) => baseMap.get(s).finalScore);
    const other = sharedSeeds.map((s) => seedMap.get(s).finalScore);
    const baseTiles = sharedSeeds.map((s) => baseMap.get(s).maxTileReached);
    const otherTiles = sharedSeeds.map((s) => seedMap.get(s).maxTileReached);
    pairs[`${arm} vs ${baseline}`] = {
      sharedSeeds,
      score: pairedDifferenceCI(base, other),
      maxTile: pairedDifferenceCI(baseTiles, otherTiles),
      // paired tile-reach counts: games where the arm reached a strictly
      // higher / equal / lower peak tile than the baseline on the same seed
      tileReachWins: sharedSeeds.filter((s) => seedMap.get(s).maxTileReached > baseMap.get(s).maxTileReached).length,
      tileReachTies: sharedSeeds.filter((s) => seedMap.get(s).maxTileReached === baseMap.get(s).maxTileReached).length,
      tileReachLosses: sharedSeeds.filter((s) => seedMap.get(s).maxTileReached < baseMap.get(s).maxTileReached).length,
    };
  }
  return { baseline, pairs };
}
