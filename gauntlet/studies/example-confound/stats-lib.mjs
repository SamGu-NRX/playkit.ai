/**
 * Pure statistical helpers for the example-confound study
 * (`compute-stats.mjs`), extracted so the preregistered arithmetic is
 * unit-testable without scoring anything (PR #104 review).
 *
 * @module
 */

/** Shared rounding: 6 decimal places, null for non-finite input. */
export const round6 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6);

/**
 * Which preregistered arm a suite id belongs to.
 *
 * The old regex misparsed the connect4 control: for
 * `...-example-confound-connect4-neutral-connect4-ladder-1-12` the non-greedy
 * capture swallowed `connect4-neutral-connect4`, producing an arm that matched
 * nothing. Arms are known strings, so match the KNOWN prefix instead: the arm
 * is whichever registered name the id continues with.
 *
 * @param {string} suiteId
 * @param {string[]} arms Registered arm names.
 * @returns {string | null}
 */
export function armFromSuiteId(suiteId, arms) {
  const marker = 'example-confound-';
  const at = suiteId.indexOf(marker);
  if (at === -1) return null;
  const rest = suiteId.slice(at + marker.length);
  const hit = arms.find((arm) => rest === arm || rest.startsWith(`${arm}-`));
  return hit ?? null;
}

/**
 * The random floor for a run's game/tier, or null when no floor was
 * calibrated. Selecting by the run's OWN tier replaces the hardcoded
 * mastermind floor that even the connect4 control fell into.
 *
 * @param {{ mastermindMini?: object | null, connect4Ladder1?: object | null }} floors
 * @param {string | null} game
 * @param {string | null} tier
 */
export function floorFor(floors, game, tier) {
  if (game === 'mastermind' && tier === 'mini') return floors.mastermindMini ?? null;
  if (game === 'connect4' && tier === 'ladder-1') return floors.connect4Ladder1 ?? null;
  return null;
}

/**
 * Tie-corrected Spearman rho = Pearson correlation of MID-RANKS (PREREG H2:
 * "the tie-corrected rho over the three per-model means, as in #81"). With no
 * ties this reduces to the classic 1 - 6*sum(d^2)/(n(n^2-1)) formula.
 *
 * rho is null when undefined: fewer than 2 points, or an all-tie side where
 * every rank is identical and the correlation has zero variance.
 *
 * @param {{ x: number, y: number }[]} points
 * @returns {{ rho: number | null, n: number, tiedX: boolean, tiedY: boolean }}
 */
export function tieCorrectedSpearman(points) {
  const n = points.length;
  if (n < 2) return { rho: null, n, tiedX: false, tiedY: false };
  const midranks = (values) => {
    const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const ranks = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && order[j + 1].v === order[i].v) j++;
      const mid = (i + j) / 2 + 1; // 1-based mid-rank
      for (let k = i; k <= j; k++) ranks[order[k].i] = mid;
      i = j + 1;
    }
    return ranks;
  };
  const rx = midranks(points.map((p) => p.x));
  const ry = midranks(points.map((p) => p.y));
  const allSame = (ranks) => new Set(ranks).size === 1;
  const mean = (ranks) => ranks.reduce((a, v) => a + v, 0) / n;
  const mx = mean(rx);
  const my = mean(ry);
  const cov = rx.reduce((a, r, i) => a + (r - mx) * (ry[i] - my), 0);
  const sx = Math.sqrt(rx.reduce((a, r) => a + (r - mx) ** 2, 0));
  const sy = Math.sqrt(ry.reduce((a, r) => a + (r - my) ** 2, 0));
  const rho = sx > 0 && sy > 0 ? cov / (sx * sy) : null;
  return { rho, n, tiedX: allSame(rx), tiedY: allSame(ry) };
}

/**
 * Paired-by-seed differences, b - a, sorted by seed (the preregistered
 * statistic's first half; the caller bootstraps the diffs). Seeds present in
 * only one arm are dropped — the pairing is the point.
 *
 * @param {{ seed: string, score: number }[]} aEpisodes
 * @param {{ seed: string, score: number }[]} bEpisodes
 * @returns {{ seed: string, diff: number }[]}
 */
export function pairBySeed(aEpisodes, bEpisodes) {
  const a = new Map(aEpisodes.map((e) => [e.seed, e.score]));
  return bEpisodes
    .filter((e) => a.has(e.seed))
    .map((e) => ({ seed: e.seed, diff: e.score - a.get(e.seed) }))
    .sort((x, y) => x.seed.localeCompare(y.seed));
}
