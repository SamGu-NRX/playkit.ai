/**
 * `analysis-lib.mjs` — the pure analysis core of the separation pilot,
 * extracted from `analyze.mjs` so the preregistered statistics are unit-testable
 * without running the CLI. No I/O, no process state: bundles go in as plain
 * `{ byKey, ends }` maps, results come out as data.
 *
 * The bootstrap stream is keyed by the comparison key ALONE —
 * `streamFromSeed('separation-pilot/<comparison-key>')`, exactly as
 * `PREREGISTRATION.md` pins it. The comparison key is the sorted label pair
 * (`a~vs~b`), so `analyze(B, A)` reuses the same resamples and negates D and
 * both interval bounds exactly (the preregistered label-swap symmetry), and
 * every profile and reading of one comparison shares one resampling stream —
 * cross-profile CI differences are re-readings of the same resamples, not
 * independent resampling noise.
 *
 * @module
 */

import { streamFromSeed } from '../../core/rng.js';
import { EFFICIENCY_CAP_OPTIMAL, EFFICIENCY_CAP_REFERENCE } from '../../scoring/score.js';
import { transformOutcomeEpisode } from '../../scoring/profiles.js';

export const BOOTSTRAP_DRAWS = 10_000;

/** The pre-registered reporting planes, in print order. */
export const PROFILES = ['rhae-v1', 'squared-outcome', 'chance-adjusted'];

/** The pre-registered invalid-reply readings, in print order. */
export const READINGS = ['raw', 'invalid-adjusted'];

/**
 * @param {number | null} v
 * @returns {number | null}
 */
export function round6(v) {
  return v === null ? null : Math.round(v * 1e6) / 1e6;
}

/**
 * Percentile of a sorted numeric array with linear interpolation — mirrors
 * `scoring/score.js` `percentile` exactly.
 *
 * @param {number[]} sorted
 * @param {number} q
 * @returns {number}
 */
export function percentile(sorted, q) {
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** A refusal that is part of normal operation (a tier drops), not a crash. */
export class TierDropped extends Error {}

/**
 * @typedef {'raw' | 'invalid-adjusted'} Reading
 */

/**
 * The pre-registered invalid-adjusted reading: e' = e × (1 −
 * invalidActions/agentActions), 0 when agentActions = 0. Applied only on
 * outcome tiers — efficiency tiers already price invalids into agentActions,
 * so both readings coincide there by construction.
 *
 * @param {{ e: number, invalidActions: number, agentActions: number }} episode
 * @param {string} scoring 'outcome' | 'efficiency'
 * @param {Reading} reading
 * @returns {number}
 */
export function readEpisode(episode, scoring, reading) {
  if (reading === 'raw' || scoring !== 'outcome') return episode.e;
  if (episode.agentActions <= 0) return 0;
  return episode.e * (1 - episode.invalidActions / episode.agentActions);
}

/**
 * @typedef {object} BundleCore
 * @property {Map<string, Trajectory>} byKey keyed `${game}/${tier}/${seed}`
 * @property {Map<string, { invalidActions: number, agentActions: number }>} ends keyed as byKey
 */

/**
 * Per-episode score under a profile, mirroring `scoring/score.js`
 * `episodeScore` — including the `squared-outcome` and `chance-adjusted`
 * transforms — for one trajectory on one suite tier.
 *
 * @param {SuiteTier} tier
 * @param {Trajectory} trajectory
 * @param {string} profile
 * @param {ScoringBaseline | undefined} baseline
 * @returns {{ e: number }}
 */
export function episodeScore(tier, trajectory, profile, baseline) {
  const outcome = trajectory.end.outcome;
  const seat = trajectory.agent.seat;
  if (tier.scoring === 'outcome') {
    const normalized = outcome?.normalized;
    if (!Array.isArray(normalized) || typeof normalized[seat] !== 'number' || !Number.isFinite(normalized[seat])) {
      throw new Error(
        `trajectory ${trajectory.game.id}/${trajectory.tier}/${trajectory.seed} ended without a finite normalized[${seat}] on an outcome tier`
      );
    }
    const e = /** @type {number} */ (normalized[seat]);
    if (profile === 'rhae-v1') return { e };
    if (profile === 'squared-outcome') return { e: e * e };
    // chance-adjusted: transformOutcomeEpisode(profile, e, r, ...) with the
    // tier's random-baseline mean r — mirrors applyOutcomeProfile. A missing
    // or stale baseline row drops the tier from this profile only.
    const game = /** @type {ScoringBaseline} */ (baseline).games[trajectory.game.id];
    if (!game || typeof game.version !== 'string') {
      throw new TierDropped(`no baseline entry for game "${trajectory.game.id}"`);
    }
    if (game.version !== trajectory.game.version) {
      throw new TierDropped(
        `baseline for "${trajectory.game.id}" is version ${game.version}, trajectory ${trajectory.game.version}`
      );
    }
    const entry = game.tiers[tier.id];
    if (!entry) throw new TierDropped(`no baseline entry for ${trajectory.game.id}/${tier.id}`);
    return { e: transformOutcomeEpisode(profile, e, entry.mean, trajectory.game.id, tier.id) };
  }
  // Efficiency tier — identical under every profile.
  const solved = outcome?.solved === true;
  if (!solved) return { e: 0 };
  const par = outcome?.par;
  if (typeof par !== 'number' || !Number.isFinite(par) || par <= 0) {
    throw new Error(`trajectory ${trajectory.game.id}/${trajectory.tier}/${trajectory.seed} claims solved with par ${JSON.stringify(par)}`);
  }
  const agentActions = trajectory.end.agentActions;
  if (!Number.isInteger(agentActions) || agentActions <= 0) {
    throw new Error(`trajectory ${trajectory.game.id}/${trajectory.tier}/${trajectory.seed} claims solved with agentActions ${JSON.stringify(agentActions)}`);
  }
  const cap = tier.parKind === 'optimal' ? EFFICIENCY_CAP_OPTIMAL : EFFICIENCY_CAP_REFERENCE;
  return { e: Math.min(cap, (par / agentActions) ** 2) };
}

/**
 * Every in-suite episode key of a suite manifest: `${game}/${tier}/${seed}`.
 * The analyzer ignores out-of-suite episodes everywhere — compare() only
 * reads these keys, and the production score() mirror is fed only these
 * trajectories.
 *
 * @param {SuiteManifest} suite
 * @returns {Set<string>}
 */
export function suiteKeysOf(suite) {
  const keys = new Set();
  for (const g of suite.games) for (const t of g.tiers) for (const s of /** @type {string[]} */ (t.seeds)) keys.add(`${g.id}/${t.id}/${s}`);
  return keys;
}

/**
 * @typedef {object} CompareResult
 * @property {number} sharedTiers
 * @property {number} outcomeTiers
 * @property {string[]} droppedTiers
 * @property {number} D
 * @property {[number, number] | null} ci
 * @property {number} signAgree
 * @property {Array<{ tier: string, n: number, m: number }>} perTier
 */

/**
 * One comparison (pair of bundles) on one profile under one reading.
 *
 * @param {BundleCore} a
 * @param {BundleCore} b
 * @param {SuiteManifest} suite
 * @param {string} profile
 * @param {ScoringBaseline | undefined} baseline
 * @param {string} pairKey the comparison key: the SORTED label pair
 *   (`a~vs~b`) — the bootstrap stream is keyed on this alone (see module doc)
 * @param {Reading} reading
 * @returns {CompareResult}
 */
export function compare(a, b, suite, profile, baseline, pairKey, reading) {
  /** @type {Record<string, number[]>} */
  const diffs = {};
  /** @type {string[]} */
  const dropped = [];
  let outcomeTiers = 0;
  for (const g of suite.games) {
    for (const t of g.tiers) {
      if (t.scoring === 'outcome') outcomeTiers++;
      const seeds = /** @type {string[]} */ (t.seeds).filter((s) =>
        a.byKey.has(`${g.id}/${t.id}/${s}`) && b.byKey.has(`${g.id}/${t.id}/${s}`)
      );
      if (seeds.length === 0) continue;
      /** @type {number[]} */
      const d = [];
      try {
        for (const s of seeds) {
          const key = `${g.id}/${t.id}/${s}`;
          const ta = /** @type {Trajectory} */ (a.byKey.get(key));
          const tb = /** @type {Trajectory} */ (b.byKey.get(key));
          const va = episodeScore(t, ta, profile, baseline);
          const vb = episodeScore(t, tb, profile, baseline);
          const ea = /** @type {{ invalidActions: number, agentActions: number }} */ (a.ends.get(key));
          const eb = /** @type {{ invalidActions: number, agentActions: number }} */ (b.ends.get(key));
          d.push(
            readEpisode({ e: va.e, ...ea }, t.scoring, reading) -
              readEpisode({ e: vb.e, ...eb }, t.scoring, reading)
          );
        }
      } catch (err) {
        if (err instanceof TierDropped) {
          dropped.push(`${g.id}/${t.id} (${err.message})`);
          continue;
        }
        throw err;
      }
      diffs[`${g.id}/${t.id}`] = d;
    }
  }
  return summarize(diffs, dropped, pairKey, profile, outcomeTiers);
}

/**
 * Shared tail of the comparison path: per-tier means, pooled D, seeded
 * bootstrap, sign agreement. The resampling stream is keyed by the comparison
 * key alone — no profile, no reading — per PREREGISTRATION.md.
 *
 * @param {Record<string, number[]>} diffs
 * @param {string[]} dropped
 * @param {string} pairKey
 * @param {string} profile
 * @param {number} outcomeTiers
 * @returns {CompareResult}
 */
export function summarize(diffs, dropped, pairKey, profile, outcomeTiers) {
  const tierIds = Object.keys(diffs).sort();
  if (tierIds.length === 0) {
    return { sharedTiers: 0, outcomeTiers, droppedTiers: dropped, D: 0, ci: null, signAgree: 0, perTier: [] };
  }
  const perTier = tierIds.map((id) => {
    const d = diffs[id];
    return { tier: id, n: d.length, m: d.reduce((x, y) => x + y, 0) / d.length };
  });
  const D = perTier.reduce((acc, t) => acc + t.m, 0) / perTier.length;
  const stream = streamFromSeed(`separation-pilot/${pairKey}`);
  /** @type {number[]} */
  const draws = [];
  for (let draw = 0; draw < BOOTSTRAP_DRAWS; draw++) {
    let sum = 0;
    for (const id of tierIds) {
      const d = diffs[id];
      let s = 0;
      for (let i = 0; i < d.length; i++) s += d[Math.floor(stream.nextFloat() * d.length)];
      sum += s / d.length;
    }
    draws.push(sum / tierIds.length);
  }
  const sorted = draws.slice().sort((x, y) => x - y);
  const ci = /** @type {[number, number]} */ ([percentile(sorted, 0.025), percentile(sorted, 0.975)]);
  const signAgree = perTier.filter((t) => (t.m > 0 && D > 0) || (t.m < 0 && D < 0)).length;
  return { sharedTiers: tierIds.length, outcomeTiers, droppedTiers: dropped, D, ci, signAgree, perTier };
}

/**
 * The verdict under the pre-registered rule.
 *
 * @param {CompareResult} r
 * @returns {'SEPARATED' | 'NOT_SEPARATED' | 'NO_DATA'}
 */
export function verdict(r) {
  if (r.sharedTiers === 0 || !r.ci) return 'NO_DATA';
  const excludesZero = r.ci[0] > 0 || r.ci[1] < 0;
  const k = Math.ceil(r.sharedTiers / 2);
  return excludesZero && r.signAgree >= k ? 'SEPARATED' : 'NOT_SEPARATED';
}

/**
 * @param {CompareResult} r
 */
export function cell(r) {
  return {
    verdict: verdict(r),
    D: round6(r.D),
    ci95: r.ci ? [round6(r.ci[0]), round6(r.ci[1])] : null,
    signAgree: `${r.signAgree}/${r.sharedTiers}`,
    perTier: r.perTier.map((t) => ({ tier: t.tier, n: t.n, m: round6(t.m) })),
  };
}
