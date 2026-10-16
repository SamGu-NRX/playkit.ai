/**
 * Tier-ordering checks over calibration tables, applied to the tables the run
 * produces (and usable on fixture tables in tests). Three checks, from the
 * calibration brief:
 *
 * (a) per tier, random <= greedy <= engine — the floor-to-ceiling ordering
 *     the baseline track exists to demonstrate;
 * (b) for random and greedy, tier scores do not rise as tier rank rises —
 *     higher-rank tiers are supposed to be at least as hard;
 * (c) on efficiency tiers, the engine solves at least 95% of seeds — the
 *     engine baseline must demonstrate the tier is solvable within budget.
 *
 * Decision rule for (a) and (b), set with the random-floor decision
 * (scoring/FLOOR-OPTIONS.md): a point-estimate inversion fails the check only
 * when the two blocks' 95% intervals separate — the interval of the block
 * with the smaller point estimate lies entirely below the other's. When the
 * intervals overlap (or either side has no interval), the inversion is
 * recorded as a warning, not a violation. Reason: point-only comparisons
 * repeatedly flagged inversions that do not reproduce as separable at higher
 * precision — mastermind wide/deep re-measured at 4x seeds, 100 per tier
 * (0.8355 [0.794, 0.877] vs 0.8686 [0.830, 0.905]: intervals overlap) and
 * connect4 forced-win's truncation-referee residual (0.031 [0.000, 0.083]
 * after the recal-versus packet's fix) both stayed inside noise. A check
 * that fails on those is a list of noise; failing only on separated
 * intervals keeps the ordering requirement strict where the evidence is
 * strict, while point inversions stay visible as warnings.
 *
 * Pure module: no `node:*` imports, no I/O.
 *
 * @module
 */

/** The table format constant, matched by worker output. */
export const TABLE_FORMAT = 'playkit-gauntlet-calibration-table/1';

/** The three baseline tracks, in floor-to-ceiling order. */
export const BASELINE_KINDS = /** @type {const} */ (['random', 'greedy', 'engine']);

/** Check (c): the engine must solve at least this fraction of seeds. */
export const EFFICIENCY_ENGINE_SOLVED_FRACTION = 0.95;

/** Float tolerance when comparing point estimates. */
const EPSILON = 1e-9;

/**
 * One tier's scored block inside a table.
 *
 * @typedef {object} TierBlock
 * @property {string} id
 * @property {number} rank
 * @property {'outcome' | 'efficiency'} scoring
 * @property {{ value: number | null, ci95: [number, number] | null }} score
 * @property {number | null} solvedFraction
 * @property {number} episodes
 */

/**
 * A per-game calibration table, as written by the worker.
 *
 * @typedef {object} CalibrationTable
 * @property {'playkit-gauntlet-calibration-table/1'} format
 * @property {{ id: string, version: string, benchmark: boolean }} game
 * @property {'public'} split
 * @property {number} seedsPerTier Number of seeds run per tier.
 * @property {Record<string, { tiers: Record<string, TierBlock> }>} baselines
 *   Keyed by baseline kind (`random`, `greedy`, `engine`).
 */

/**
 * One failed check, with the parameter change it suggests.
 *
 * @typedef {object} Violation
 * @property {'a-order' | 'b-monotonic' | 'c-solved'} check
 * @property {string} game
 * @property {string | null} tier Null when the violation spans tiers.
 * @property {string} detail
 * @property {string} proposal
 * @property {'violation' | 'warning'} severity A violation only when the
 *   95% intervals separate; a point inversion within noise is a warning.
 */

/**
 * @param {number | null} v
 * @returns {boolean}
 */
function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * @param {CalibrationTable} table
 * @returns {TierBlock[]} Tiers sorted by rank ascending.
 */
function tiersByRank(table) {
  const kinds = /** @type {string[]} */ ([...BASELINE_KINDS]);
  const first = kinds.map((k) => table.baselines[k]).find(Boolean);
  if (!first) return [];
  const tiers = Object.values(first.tiers);
  return tiers.sort((a, b) => a.rank - b.rank);
}

/**
 * @param {CalibrationTable} table
 * @param {TierBlock} tier
 * @param {'random' | 'greedy' | 'engine'} kind
 * @returns {TierBlock | null}
 */
function tierOf(table, tier, kind) {
  return table.baselines[kind]?.tiers[tier.id] ?? null;
}

/**
 * Severity of a point-estimate inversion between two blocks, per the
 * decision rule documented at the module head: 'violation' only when the
 * lower block's 95% interval lies entirely below the higher block's, else
 * 'warning'. Missing intervals cannot separate, so they warn.
 *
 * @param {TierBlock} lowerBlock Block with the smaller point estimate.
 * @param {TierBlock} higherBlock Block with the larger point estimate.
 * @returns {'violation' | 'warning'}
 */
function inversionSeverity(lowerBlock, higherBlock) {
  const lowerCi = lowerBlock.score.ci95;
  const higherCi = higherBlock.score.ci95;
  if (!lowerCi || !higherCi) return 'warning';
  return lowerCi[1] < higherCi[0] ? 'violation' : 'warning';
}

/**
 * @param {TierBlock} block
 * @returns {string} "0.123 [0.101, 0.144]" or "0.123 (no interval)" so the
 * report itself carries the interval evidence for every inversion.
 */
function fmtWithCi(block) {
  const value = fmt(block.score.value);
  return block.score.ci95
    ? `${value} [${fmt(block.score.ci95[0])}, ${fmt(block.score.ci95[1])}]`
    : `${value} (no interval)`;
}

/**
 * Run all three checks over the given tables.
 *
 * @param {CalibrationTable[]} tables
 * @returns {Violation[]} Empty when every check holds.
 */
export function runChecks(tables) {
  /** @type {Violation[]} */
  const violations = [];

  for (const table of tables) {
    const game = table.game.id;
    const tiers = tiersByRank(table);

    // (a) On each tier: random <= greedy <= engine.
    for (const tier of tiers) {
      const random = tierOf(table, tier, 'random');
      const greedy = tierOf(table, tier, 'greedy');
      const engine = tierOf(table, tier, 'engine');
      if (
        random && greedy && engine &&
        isNumber(random.score.value) && isNumber(greedy.score.value) &&
        /** @type {number} */ (greedy.score.value) < /** @type {number} */ (random.score.value) - EPSILON
      ) {
        violations.push({
          check: 'a-order',
          game,
          tier: tier.id,
          severity: inversionSeverity(greedy, random),
          detail: `greedy ${fmtWithCi(greedy)} < random ${fmtWithCi(random)} on tier ${tier.id} (rank ${tier.rank})`,
          proposal: `the greedy heuristic loses to uniform play on ${game}/${tier.id} — re-tune the heuristic or its seeded tie-breaks until it at least matches random`,
        });
      }
      if (
        greedy && engine &&
        isNumber(greedy.score.value) && isNumber(engine.score.value) &&
        /** @type {number} */ (engine.score.value) < /** @type {number} */ (greedy.score.value) - EPSILON
      ) {
        violations.push({
          check: 'a-order',
          game,
          tier: tier.id,
          severity: inversionSeverity(engine, greedy),
          detail: `engine ${fmtWithCi(engine)} < greedy ${fmtWithCi(greedy)} on tier ${tier.id} (rank ${tier.rank})`,
          proposal: `raise the engine-side strength for ${game}/${tier.id} (tier.params: search depth, node budget, or solver budget) until it at least matches greedy; if this ladder rung is meant to be the ceiling, swap the rungs`,
        });
      }
    }

    // (b) For random and greedy: scores do not rise as tier rank rises.
    for (const kind of /** @type {const} */ (['random', 'greedy'])) {
      let previous = /** @type {TierBlock | null} */ (null);
      for (const tier of tiers) {
        const current = tierOf(table, tier, kind);
        if (!current || !isNumber(current.score.value)) continue;
        if (previous && isNumber(previous.score.value)) {
          const prevValue = /** @type {number} */ (previous.score.value);
          const value = /** @type {number} */ (current.score.value);
          if (value > prevValue + EPSILON) {
            violations.push({
              check: 'b-monotonic',
              game,
              tier: tier.id,
              severity: inversionSeverity(previous, current),
              detail: `${kind} rises from ${fmtWithCi(previous)} on ${previous.id} (rank ${previous.rank}) to ${fmtWithCi(current)} on ${tier.id} (rank ${tier.rank})`,
              proposal: `re-tune ${game}'s tier parameters (board size, band, or engine rung) or re-rank the tiers so rank ${tier.rank} is at least as hard as rank ${previous.rank} for ${kind} play`,
            });
          }
        }
        previous = current;
      }
    }

    // (c) On efficiency tiers, the engine solves at least 95% of seeds.
    for (const tier of tiers) {
      if (tier.scoring !== 'efficiency') continue;
      const engine = tierOf(table, tier, 'engine');
      if (!engine || engine.episodes === 0 || !isNumber(engine.solvedFraction)) continue;
      const fraction = /** @type {number} */ (engine.solvedFraction);
      if (fraction < EFFICIENCY_ENGINE_SOLVED_FRACTION - EPSILON) {
        violations.push({
          check: 'c-solved',
          game,
          tier: tier.id,
          severity: 'violation',
          detail: `engine solves ${fmt(fraction)} of seeds on efficiency tier ${tier.id} (rank ${tier.rank}); floor is ${EFFICIENCY_ENGINE_SOLVED_FRACTION}`,
          proposal: `raise ${game}/${tier.id} maxActions above 5×par, strengthen the engine/reference solver in tier.params, or lower the tier's par band`,
        });
      }
    }
  }

  return violations;
}

/**
 * @param {number | null} v
 * @returns {string}
 */
function fmt(v) {
  return v === null ? 'null' : String(Math.round(v * 1e6) / 1e6);
}
