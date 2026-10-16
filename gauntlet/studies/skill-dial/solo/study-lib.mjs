/**
 * The solo skill-dial study's shared configuration and helpers: the pinned
 * p values, the seed plan, the two suite manifests (public and study-local
 * eval), the job list, the expert wiring, and the episode-score mirror used
 * for the cross-check against `scoring/score.js`.
 *
 * The dial definition is pinned in `agents/skill-dial.js`; this study wires
 * the game's `engine` baseline (from `calibration/games.js`, the same mapping
 * the calibration tables use) as the expert for every solo game — all six
 * ship packet engine baselines.
 *
 * Node-only (the eval seeds need `node:crypto`).
 *
 * @module
 */

import { evalSeed } from '../../../core/seeds-node.js';
import { buildSuite } from '../../../scoring/suite.js';
import { transformOutcomeEpisode } from '../../../scoring/profiles.js';
import { GAMES } from '../../../games/index.js';
import { CALIBRATION_GAMES } from '../../../calibration/games.js';

/** @import { Agent, Game, TierSpec } from '../../../core/types.js' */

/** The pinned dial ladder: p=0 is the expert, p=1 is the random agent. */
export const P_VALUES = [0, 0.1, 0.25, 0.5, 0.75, 1];

/** The solo games this study covers, in run order. */
export const GAME_IDS = ['2048', 'minesweeper', 'sliding', 'sokoban', 'mastermind', 'cube'];

/**
 * Seeds per tier. Public seeds are the listed benchmark seeds (`<game>/<tier>/public/<i>`)
 * capped at the tier's `publicSeeds`; eval seeds are study-local (see below).
 * Sliding ships only 8 public seeds and cube only 6, so they get fewer
 * public and more eval seeds to reach the 16-seed minimum per tier.
 *
 * @type {Record<string, number>}
 */
export const PUBLIC_SEED_COUNTS = { '2048': 16, minesweeper: 16, sliding: 8, sokoban: 16, mastermind: 16, cube: 6 };

/**
 * Eval seeds per tier. The benchmark's hidden eval split uses a secret salt
 * that is never committed, so those exact seeds are not derivable. This study
 * derives its own eval-style seeds with a committed, study-local salt
 * (`SALT` below) through the same `evalSeed` construction the suite layer
 * uses. They are NOT the benchmark's hidden eval seeds; the report says so.
 *
 * @type {Record<string, number>}
 */
export const EVAL_SEED_COUNTS = { '2048': 16, minesweeper: 16, sliding: 8, sokoban: 16, mastermind: 16, cube: 10 };

/** Study-local eval salt. Committed on purpose: reproducibility over hiding. */
export const SALT = 'playkit-gauntlet-skill-dial-solo-study/1';

/** Fixed wall clock for every episode so bundles are byte-stable across runs. */
export const NOW = () => 1_760_000_000_000;

/** Suite manifest ids — fixed strings, so score()'s seeded bootstrap is stable. */
export const SUITE_IDS = {
  public: (gameId, tierId) => `skill-dial-solo-${gameId}-${tierId}-public`,
  eval: (gameId, tierId) => `skill-dial-solo-${gameId}-${tierId}-eval`,
};

/**
 * The tier with its public seed count capped for a manifest.
 *
 * @param {Game<*>} game
 * @param {TierSpec} tier
 * @param {number} count
 * @returns {Game<*>}
 */
function tierCopy(game, tier, count) {
  return {
    ...game,
    spec: {
      ...game.spec,
      tiers: [{ ...tier, rank: 1, publicSeeds: count }],
    },
  };
}

/**
 * The seeds this study runs for one tier, with their split.
 *
 * @param {string} gameId
 * @param {TierSpec} tier
 * @returns {{ seed: string, split: 'public' | 'eval' }[]}
 */
export function seedsFor(gameId, tier) {
  const out = [];
  for (let i = 0; i < PUBLIC_SEED_COUNTS[gameId]; i++) {
    out.push({ seed: `${gameId}/${tier.id}/public/${i}`, split: /** @type {'public'} */ ('public') });
  }
  for (let i = 0; i < EVAL_SEED_COUNTS[gameId]; i++) {
    out.push({ seed: evalSeed(gameId, tier.id, i, SALT), split: /** @type {'eval'} */ ('eval') });
  }
  return out;
}

/**
 * The single-tier suite manifest score() is called with for one
 * (game, tier, split): exactly the seeds the study ran, so coverage is
 * complete and the entry is ranked with score()'s own 10k-draw bootstrap CI.
 *
 * @param {string} gameId
 * @param {string} tierId
 * @param {'public' | 'eval'} split
 * @returns {ReturnType<typeof buildSuite>}
 */
export function singleTierSuite(gameId, tierId, split) {
  const game = /** @type {Game<*>} */ (GAMES[gameId]);
  const tier = /** @type {TierSpec} */ (game.spec.tiers.find((t) => t.id === tierId));
  if (!tier) throw new Error(`unknown tier ${gameId}/${tierId}`);
  const count = split === 'public' ? PUBLIC_SEED_COUNTS[gameId] : EVAL_SEED_COUNTS[gameId];
  return buildSuite([tierCopy(game, tier, count)], {
    split,
    id: SUITE_IDS[split](gameId, tierId),
    ...(split === 'eval' ? { salt: SALT } : {}),
  });
}

/**
 * The full job list, one episode each, in a deterministic order.
 *
 * @returns {{ gameId: string, tierId: string, split: 'public' | 'eval', seed: string, p: number, file: string }[]}
 */
export function allJobs() {
  const jobs = [];
  for (const gameId of GAME_IDS) {
    const game = /** @type {Game<*>} */ (GAMES[gameId]);
    for (const tier of game.spec.tiers) {
      for (const { seed, split } of seedsFor(gameId, tier)) {
        for (const p of P_VALUES) {
          const file = `${gameId}/${tier.id}/p${Math.round(p * 100)}/${split}-${encodeURIComponent(seed)}.json`;
          jobs.push({ gameId, tierId: tier.id, split, seed, p, file });
        }
      }
    }
  }
  return jobs;
}

/**
 * The episode's expert: the game's `engine` baseline from the calibration
 * kit, freshly constructed per episode (packet baselines close over the
 * episode). Every solo game ships an engine baseline, so `greedy` never
 * applies here.
 *
 * @param {string} gameId
 * @param {TierSpec} tier
 * @param {string} seed
 * @returns {Agent}
 */
export function expertFor(gameId, tier, seed) {
  const cal = CALIBRATION_GAMES.find((g) => g.id === gameId);
  if (!cal) throw new Error(`no calibration entry for game "${gameId}"`);
  const game = /** @type {Game<*>} */ (GAMES[gameId]);
  const seat = typeof game.agentSeat === 'function' ? game.agentSeat(tier, seed) : 0;
  return cal.makeAgent('engine', { episodeSeed: seed, tier, seat });
}

/**
 * Raw episode score e and solved flag — the mirror of score.js's
 * `episodeScore` pre-profile rules: outcome tiers read
 * `outcome.normalized[seat]`; efficiency tiers read
 * `min(cap, (par/agentActions)^2)` with cap 1.0 for optimal par and 1.15 for
 * reference par, 0 when unsolved. Only called on error-free trajectories.
 *
 * @param {Game<*>} game
 * @param {TierSpec} tier
 * @param {*} trajectory
 * @returns {{ e: number, solved: boolean, par: number | null, agentActions: number }}
 */
export function rawEpisodeScore(game, tier, trajectory) {
  const outcome = trajectory.end?.outcome ?? null;
  const seat = trajectory.agent.seat;
  if (tier.scoring === 'outcome') {
    const value = outcome?.normalized?.[seat];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${game.spec.id}/${tier.id}/${trajectory.seed}: no finite normalized[${seat}]`);
    }
    return { e: value, solved: false, par: null, agentActions: trajectory.end.agentActions };
  }
  const solved = outcome?.solved === true;
  if (!solved) {
    return { e: 0, solved: false, par: null, agentActions: trajectory.end.agentActions };
  }
  const par = outcome?.par;
  if (typeof par !== 'number' || !Number.isFinite(par) || par <= 0) {
    throw new Error(`${game.spec.id}/${tier.id}/${trajectory.seed}: solved without a usable par`);
  }
  const agentActions = trajectory.end.agentActions;
  if (!Number.isInteger(agentActions) || agentActions <= 0) {
    throw new Error(`${game.spec.id}/${tier.id}/${trajectory.seed}: solved without agentActions`);
  }
  const cap = tier.parKind === 'optimal' ? 1.0 : 1.15;
  return { e: Math.min(cap, (par / agentActions) ** 2), solved: true, par, agentActions };
}

/**
 * The chance-adjusted transform for one tier, given the tier's random-baseline
 * mean r. Exported from `scoring/profiles.js`, so the study applies exactly
 * the scoring layer's formula. Used for the committed-baseline rescale (five
 * of six games) and the informational study-local-r rescale for cube.
 *
 * @param {number} e
 * @param {number} r
 * @param {string} gameId
 * @param {string} tierId
 * @returns {number}
 */
export function chanceAdjust(e, r, gameId, tierId) {
  return transformOutcomeEpisode('chance-adjusted', e, r, gameId, tierId);
}

/** Round to 6 decimals, exactly like score.js does before publishing. */
export function round6(v) {
  return v === null ? null : Math.round(v * 1e6) / 1e6;
}
