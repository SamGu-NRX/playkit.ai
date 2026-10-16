/**
 * The study plan: which games, tiers, p values and seed counts are measured.
 * Shared by `run-study.mjs`, `compute-stats.mjs` and `reproduce.sh` so the
 * episode set and the suite manifest (and therefore the seeded bootstrap
 * inside `scoring/score.js`) stay byte-identical across regenerations.
 *
 * Seed i of a tier is `publicSeed(gameId, tierId, i)` for
 * `i < SEEDS[game][tier]`. Counts extend past the tier's listed `publicSeeds`
 * budget where the study needs more than the suite lists (tictactoe 8,
 * connect4 12, holdem 12, chess 5, chess-endgames 10): the seed format is
 * pure string formatting and every game accepts any seed string, so the
 * extended seeds are deterministic and replayable exactly like the listed
 * ones — they are just not part of the official suite's seed list.
 *
 * @module
 */

import { publicSeed } from '../../../core/seeds.js';

/** The pinned p values, in rung order. */
export const PS = [0, 0.1, 0.25, 0.5, 0.75, 1];

/** The suite id — pins score()'s seeded bootstrap streams. */
export const SUITE_ID = 'playkit-gauntlet-skill-dial-versus-public';

/**
 * Seeds per tier, chosen to clear the task floor (>= 16) with headroom on
 * fast games; chess is budgeted separately in REPORT.md.
 *
 * @type {Record<string, Record<string, number>>}
 */
export const SEEDS = {
  tictactoe: { 'perfect-opponent': 40 },
  connect4: {
    'ladder-1': 24,
    'ladder-2': 24,
    'ladder-3': 24,
    'ladder-4': 24,
    'forced-win': 24,
  },
  holdem: { station: 20, rules: 20, equity: 20 },
  chess: { paper: 8, wood: 8, steel: 8, granite: 8 },
  'chess-endgames': { kqk: 20, krk: 20, kbbk: 20, kbnk: 20 },
  'chess-puzzles': { r0400: 24, r1000: 24, r1400: 24, r1800: 24, r2200: 24, r2600: 24 },
};

/** The games this study covers, in report order. */
export const GAME_IDS = Object.keys(SEEDS);

/**
 * The seed list for one tier.
 *
 * @param {string} gameId
 * @param {string} tierId
 * @returns {string[]}
 */
export function seedList(gameId, tierId) {
  const count = SEEDS[gameId]?.[tierId];
  if (!count) {
    throw new Error(`seedList: no seed count planned for ${gameId}/${tierId}`);
  }
  return Array.from({ length: count }, (_, i) => publicSeed(gameId, tierId, i));
}

/**
 * Every (game, tier) cell in the plan.
 *
 * @returns {{ gameId: string, tierId: string }[]}
 */
export function planCells() {
  /** @type {{ gameId: string, tierId: string }[]} */
  const cells = [];
  for (const gameId of GAME_IDS) {
    for (const tierId of Object.keys(SEEDS[gameId])) {
      cells.push({ gameId, tierId });
    }
  }
  return cells;
}
