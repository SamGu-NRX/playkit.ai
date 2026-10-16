/**
 * Scoring profiles: selectable per-entry transforms of the episode score on
 * outcome tiers, with `rhae-v1` (the design-doc rules) as the default.
 *
 * - `rhae-v1` — the current rule. On outcome tiers the episode score is
 *   `e = outcome.normalized[seat]`, untouched. Output under the default
 *   profile is byte-identical to the pre-profiles scorer.
 * - `chance-adjusted` — on outcome tiers, `e' = max(0, (e - r) / (1 - r))`
 *   where `r` is the random baseline's mean episode score on that tier, read
 *   from a committed baseline file (`baselines/random-public.json`). Random
 *   play lands at 0 by construction, so a 0.11 random floor stops squeezing
 *   the range above it. Efficiency tiers are unchanged: random already scores
 *   exactly 0 there (`solved` is false on every random episode), so there is
 *   nothing to subtract. Refuses when `r` is at or near 1 — the transform's
 *   denominator approaches zero and the rescaled score amplifies noise by
 *   three orders of magnitude or more.
 * - `squared-outcome` — on outcome tiers, `e' = e^2`, mirroring RHAE's
 *   squared efficiency: partial credit is discounted harder than full or
 *   zero outcomes, which widens the gap between the random floor and
 *   above-chance play without needing a baseline file.
 *
 * Pure module: no `node:*` imports, no I/O. The baseline file loader lives
 * in `baselines.js` (Node-only); `score()` receives the parsed baseline as
 * an option.
 *
 * @module
 */

import { GauntletRefusalError } from './refusal.js';

/** The selectable scoring profiles, in introduction order. */
export const SCORING_PROFILES = /** @type {const} */ (['rhae-v1', 'chance-adjusted', 'squared-outcome']);

/** The default profile: the design-doc rules, unchanged. */
export const DEFAULT_PROFILE = 'rhae-v1';

/**
 * How close `r` may get to 1 before chance-adjusted refuses. At
 * `1 - r = 1e-3` the rescale multiplies deviations from chance by 1000,
 * which is amplification, not scoring; refuse below this gap.
 */
export const CHANCE_DENOMINATOR_FLOOR = 1e-3;

/** The baseline file format this layer reads. */
export const BASELINE_FORMAT = 'playkit-gauntlet-scoring-baseline/1';

/**
 * @param {string} step
 * @param {string} message
 * @returns {never}
 */
function refuse(step, message) {
  throw new GauntletRefusalError('score.js', step, message);
}

/**
 * Resolve the profile id from options, defaulting to `rhae-v1`.
 *
 * @param {string | undefined} profile
 * @returns {string} A member of {@link SCORING_PROFILES}.
 */
export function resolveProfile(profile) {
  if (profile === undefined || profile === null) return DEFAULT_PROFILE;
  if (typeof profile !== 'string' || !(/** @type {readonly string[]} */ (SCORING_PROFILES)).includes(profile)) {
    refuse(
      'profile-unknown',
      `unknown scoring profile ${JSON.stringify(profile)}; the selectable profiles are ${SCORING_PROFILES.join(', ')}`
    );
  }
  return profile;
}

/**
 * One tier's random-baseline entry inside a baseline file.
 *
 * @typedef {object} BaselineTier
 * @property {'outcome' | 'efficiency'} scoring
 * @property {number} mean The random baseline's mean episode score.
 * @property {[number, number] | null} ci95
 * @property {number} episodes
 */

/**
 * One game's random-baseline entry inside a baseline file.
 *
 * @typedef {object} BaselineGame
 * @property {string} id
 * @property {string} version The game version the baseline was measured on.
 * @property {boolean} benchmark
 * @property {Record<string, BaselineTier>} tiers Keyed by tier id.
 */

/**
 * A parsed scoring-baseline file (see `baselines.js` for the loader).
 *
 * @typedef {object} ScoringBaseline
 * @property {string} format
 * @property {string} agent The baseline kind the means come from.
 * @property {Record<string, BaselineGame>} games Keyed by game id.
 */

/**
 * Validate a parsed baseline object. Refuses with a named step so a stale
 * or hand-mangled file fails loudly instead of silently shifting scores.
 *
 * @param {unknown} baseline
 * @returns {ScoringBaseline}
 */
export function validateBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    refuse('baseline-shape', 'the scoring baseline must be a JSON object');
  }
  const bl = /** @type {Record<string, unknown>} */ (baseline);
  if (bl.format !== BASELINE_FORMAT) {
    refuse('baseline-format', `expected a ${BASELINE_FORMAT} baseline, got ${JSON.stringify(bl.format)}`);
  }
  if (typeof bl.agent !== 'string' || bl.agent.length === 0) {
    refuse('baseline-shape', 'the scoring baseline must record the baseline kind it was measured from ("agent")');
  }
  if (!bl.games || typeof bl.games !== 'object' || Array.isArray(bl.games)) {
    refuse('baseline-shape', 'the scoring baseline must carry a "games" record keyed by game id');
  }
  for (const [gameId, gameValue] of Object.entries(/** @type {Record<string, unknown>} */ (bl.games))) {
    if (!gameValue || typeof gameValue !== 'object') {
      refuse('baseline-shape', `baseline game "${gameId}" must be an object`);
    }
    const game = /** @type {Record<string, unknown>} */ (gameValue);
    if (typeof game.version !== 'string' || game.version.length === 0) {
      refuse('baseline-shape', `baseline game "${gameId}" must record the game version it was measured on`);
    }
    if (!game.tiers || typeof game.tiers !== 'object' || Array.isArray(game.tiers)) {
      refuse('baseline-shape', `baseline game "${gameId}" must carry a "tiers" record keyed by tier id`);
    }
    for (const [tierId, tierValue] of Object.entries(/** @type {Record<string, unknown>} */ (game.tiers))) {
      if (!tierValue || typeof tierValue !== 'object') {
        refuse('baseline-shape', `baseline tier "${gameId}/${tierId}" must be an object`);
      }
      const tier = /** @type {Record<string, unknown>} */ (tierValue);
      if (typeof tier.mean !== 'number' || !Number.isFinite(tier.mean) || tier.mean < 0) {
        refuse('baseline-shape', `baseline tier "${gameId}/${tierId}" carries mean ${JSON.stringify(tier.mean)}; expected a finite non-negative number`);
      }
    }
  }
  return /** @type {ScoringBaseline} */ (baseline);
}

/**
 * Look up the random baseline entry for one game tier.
 *
 * @param {ScoringBaseline} baseline
 * @param {string} gameId
 * @param {string} tierId
 * @returns {BaselineTier | null} Null when the baseline has no entry for
 *   this game tier.
 */
export function baselineTier(baseline, gameId, tierId) {
  return baseline.games?.[gameId]?.tiers?.[tierId] ?? null;
}

/**
 * Guard the chance-adjusted denominator: `r` must stay clear of 1.
 *
 * @param {number} r The random baseline's mean on the tier.
 * @param {string} gameId
 * @param {string} tierId
 */
export function assertChanceBaselineUsable(r, gameId, tierId) {
  if (1 - r < CHANCE_DENOMINATOR_FLOOR) {
    refuse(
      'chance-baseline-degenerate',
      `the random baseline's mean on ${gameId}/${tierId} is ${r}, at or within ${CHANCE_DENOMINATOR_FLOOR} of 1; the chance-adjusted transform (e - r) / (1 - r) would divide by ${1 - r} and amplify noise by three orders of magnitude`
    );
  }
}

/**
 * Apply a profile's outcome-tier transform to one episode score.
 * Efficiency tiers never reach this function — they are unchanged under
 * every profile.
 *
 * @param {string} profile A member of {@link SCORING_PROFILES}.
 * @param {number} e The raw episode score, `outcome.normalized[seat]`.
 * @param {number} [r] For `chance-adjusted`, the random baseline's mean on
 *   the tier. Required only for that profile.
 * @returns {number}
 */
export function transformOutcomeEpisode(profile, e, r, gameId = 'tier', tierId = 'episode') {
  if (profile === 'rhae-v1') return e;
  if (profile === 'squared-outcome') return e * e;
  if (profile === 'chance-adjusted') {
    if (typeof r !== 'number' || !Number.isFinite(r)) {
      refuse('chance-baseline-missing', `chance-adjusted needs the random baseline's mean r for ${gameId}/${tierId}`);
    }
    assertChanceBaselineUsable(r, gameId, tierId);
    return Math.max(0, (e - r) / (1 - r));
  }
  refuse('profile-unknown', `unknown scoring profile ${JSON.stringify(profile)}`);
}
