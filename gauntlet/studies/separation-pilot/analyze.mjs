/**
 * `analyze.mjs` — the separation-pilot analysis. Applies the pre-registered
 * decision rule (studies/separation-pilot/PREREGISTRATION.md, fixed before any
 * instrument episode was run) to bundles produced by `gauntlet run` — no new
 * scoring semantics: per-episode scores mirror `scoring/score.js`
 * `episodeScore`, verified against the production `score()` on the default
 * profile before any verdict is printed, and every trajectory in every bundle
 * must pass `verifyTrajectory` or the analysis refuses.
 *
 *   node analyze.mjs BUNDLE... [--suite <suite.json>] [--json]
 *
 * With N bundles, every unordered pair is compared on three scoring profiles
 * (`rhae-v1` primary, `squared-outcome`, `chance-adjusted` — the pre-registered
 * plane set) under the pre-registered statistic:
 *
 *   d[t,s]  episode score difference (A − B) paired by seed
 *   m[t]    per-tier mean of d
 *   D       equal-weight mean of m over shared tiers
 *   CI      percentile 95% interval from 10,000 seeded joint resamples
 *           (streamFromSeed('separation-pilot/<key>/<profile>/<reading>')) —
 *           identical bundles always yield byte-identical intervals
 *
 * SEPARATED iff the interval excludes zero and at least ceil(T/2) shared tiers
 * agree in sign with D. Win/lose ("outcome") tiers are reported under both
 * pre-registered invalid-reply readings (`raw` and `invalid-adjusted`,
 * e' = e × (1 − invalidActions/agentActions)); efficiency tiers coincide by
 * construction and appear once. Verdicts are data — exit 0 either way; exit 2
 * only on structural errors (unverified trajectories, no shared seeds, mirror
 * mismatch).
 *
 * Output is deterministic: fixed ordering, fixed rounding, no timestamps, no
 * wall-clock data — the same bundles always produce byte-identical output.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyTrajectory } from '../../core/trajectory.js';
import { streamFromSeed } from '../../core/rng.js';
import { getGame, GAMES } from '../../games/index.js';
import { score, EFFICIENCY_CAP_OPTIMAL, EFFICIENCY_CAP_REFERENCE } from '../../scoring/score.js';
import { transformOutcomeEpisode } from '../../scoring/profiles.js';
import { loadBaselineFile } from '../../scoring/baselines.js';
import { loadTrajectories } from '../../cli/verify.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(here, '../../scoring/baselines/random-public.json');
const BOOTSTRAP_DRAWS = 10_000;

/** The pre-registered reporting planes, in print order. */
const PROFILES = ['rhae-v1', 'squared-outcome', 'chance-adjusted'];

/** The pre-registered invalid-reply readings, in print order. */
const READINGS = ['raw', 'invalid-adjusted'];

/**
 * @param {number | null} v
 * @returns {number | null}
 */
function round6(v) {
  return v === null ? null : Math.round(v * 1e6) / 1e6;
}

/**
 * Percentile of a sorted numeric array with linear interpolation — mirrors
 * `scoring/score.js` `percentile` exactly.
 *
 * @param {number[]} sorted Ascending, non-empty.
 * @param {number} q In [0, 1].
 * @returns {number}
 */
function percentile(sorted, q) {
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** A refusal that is part of normal operation (a tier drops), not a crash. */
class TierDropped extends Error {}

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
function readEpisode(episode, scoring, reading) {
  if (reading === 'raw' || scoring !== 'outcome') return episode.e;
  if (episode.agentActions <= 0) return 0;
  return episode.e * (1 - episode.invalidActions / episode.agentActions);
}

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
function episodeScore(tier, trajectory, profile, baseline) {
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
 * @typedef {object} Bundle
 * @property {string} dir
 * @property {string} label
 * @property {Trajectory[]} trajectories
 * @property {Map<string, Trajectory>} byKey keyed `${game}/${tier}/${seed}`
 * @property {Map<string, { invalidActions: number, agentActions: number }>} ends keyed as byKey
 * @property {Map<string, number>} scores raw (rhae-v1) per-episode scores, in-suite keys only, filled by scoreAndMirror
 */

/**
 * Load and fully verify one bundle directory.
 *
 * @param {string} dir
 * @param {number} ordinal
 * @returns {Promise<Bundle>}
 */
async function loadBundle(dir, ordinal) {
  if (!existsSync(dir)) throw new Error(`bundle directory not found: ${dir}`);
  const trajectories = loadTrajectories([dir]);
  /** @type {Map<string, Trajectory>} */
  const byKey = new Map();
  /** @type {Map<string, { invalidActions: number, agentActions: number }>} */
  const ends = new Map();
  /** @type {Map<string, number>} */
  const scores = new Map();
  /** @type {string[]} */
  const failures = [];
  for (const trajectory of trajectories) {
    const key = `${trajectory.game.id}/${trajectory.tier}/${trajectory.seed}`;
    const game = getGame(trajectory.game.id);
    const verdict = await verifyTrajectory(game, trajectory);
    if (!verdict.ok) {
      failures.push(key);
      continue;
    }
    if (byKey.has(key)) {
      throw new Error(`bundle "${dir}": duplicate trajectory key ${key} — refusing rather than silently overwriting`);
    }
    byKey.set(key, trajectory);
    ends.set(key, { invalidActions: trajectory.end.invalidActions, agentActions: trajectory.end.agentActions });
  }
  if (failures.length > 0) {
    throw new Error(`bundle "${dir}": ${failures.length} trajectory(ies) failed replay verification: ${failures.join(', ')}`);
  }
  if (byKey.size === 0) throw new Error(`bundle "${dir}": no verifiable trajectories`);
  let label = '';
  const runJson = path.join(dir, 'run.json');
  if (existsSync(runJson)) {
    try {
      const run = JSON.parse(readFileSync(runJson, 'utf8'));
      label = typeof run?.agent?.id === 'string' ? run.agent.id : '';
    } catch {
      // unreadable run.json — fall through to the trajectory agent id
    }
  }
  if (!label) {
    const first = /** @type {Trajectory | undefined} */ (byKey.values().next().value);
    label = first?.agent?.id ?? '';
  }
  if (!label) label = `bundle-${ordinal + 1}`;
  return { dir, label, trajectories, byKey, ends, scores };
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
 * @param {Bundle} a
 * @param {Bundle} b
 * @param {SuiteManifest} suite
 * @param {string} profile
 * @param {ScoringBaseline | undefined} baseline
 * @param {string} comparisonKey
 * @param {Reading} reading
 * @returns {CompareResult}
 */
function compare(a, b, suite, profile, baseline, comparisonKey, reading) {
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
  return summarize(diffs, dropped, comparisonKey, profile, outcomeTiers);
}

/**
 * Shared tail of the comparison path: per-tier means, pooled D, seeded
 * bootstrap, sign agreement.
 *
 * @param {Record<string, number[]>} diffs
 * @param {string[]} dropped
 * @param {string} comparisonKey
 * @param {string} profile
 * @param {number} outcomeTiers
 * @returns {CompareResult}
 */
function summarize(diffs, dropped, comparisonKey, profile, outcomeTiers) {
  const tierIds = Object.keys(diffs).sort();
  if (tierIds.length === 0) {
    return { sharedTiers: 0, outcomeTiers, droppedTiers: dropped, D: 0, ci: null, signAgree: 0, perTier: [] };
  }
  const perTier = tierIds.map((id) => {
    const d = diffs[id];
    return { tier: id, n: d.length, m: d.reduce((x, y) => x + y, 0) / d.length };
  });
  const D = perTier.reduce((acc, t) => acc + t.m, 0) / perTier.length;
  const stream = streamFromSeed(`separation-pilot/${comparisonKey}/${profile}`);
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
function verdict(r) {
  if (r.sharedTiers === 0 || !r.ci) return 'NO_DATA';
  const excludesZero = r.ci[0] > 0 || r.ci[1] < 0;
  const k = Math.ceil(r.sharedTiers / 2);
  return excludesZero && r.signAgree >= k ? 'SEPARATED' : 'NOT_SEPARATED';
}

/**
 * @param {CompareResult} r
 */
function cell(r) {
  return {
    verdict: verdict(r),
    D: round6(r.D),
    ci95: r.ci ? [round6(r.ci[0]), round6(r.ci[1])] : null,
    signAgree: `${r.signAgree}/${r.sharedTiers}`,
    perTier: r.perTier.map((t) => ({ tier: t.tier, n: t.n, m: round6(t.m) })),
  };
}

/**
 * @param {Bundle} bundle
 * @param {SuiteManifest} suite
 * @returns {string[]}
 */
function outsideSuite(bundle, suite) {
  const keys = new Set();
  for (const g of suite.games) for (const t of g.tiers) for (const s of /** @type {string[]} */ (t.seeds)) keys.add(`${g.id}/${t.id}/${s}`);
  return [...bundle.byKey.keys()].filter((k) => !keys.has(k)).sort();
}

/**
 * Compute the per-episode raw (rhae-v1) score for every in-suite episode of a
 * bundle, then verify the mirror: production `score()` tier means must equal
 * the per-episode means to 1e-9 under the same default profile. Mirror per
 * game: `score()` refuses trajectories with mixed agent ids
 * (agent-identity refusal), and a composite bundle legitimately carries one
 * dial id per game.
 *
 * @param {Bundle} bundle
 * @param {SuiteManifest} suite
 */
async function scoreAndMirror(bundle, suite) {
  for (const g of suite.games) {
    for (const t of g.tiers) {
      for (const s of /** @type {string[]} */ (t.seeds)) {
        const key = `${g.id}/${t.id}/${s}`;
        const trajectory = bundle.byKey.get(key);
        if (!trajectory) continue;
        bundle.scores.set(key, episodeScore(t, trajectory, 'rhae-v1', undefined).e);
      }
    }
  }
  /** @type {string[]} */
  const mismatches = [];
  for (const g of suite.games) {
    const trajs = bundle.trajectories.filter((t) => t.game.id === g.id);
    if (trajs.length === 0) continue;
    const entry = await score({ ...suite, games: [g] }, trajs, GAMES, {});
    const gameScore = entry.games[g.id];
    if (!gameScore) continue;
    for (const t of g.tiers) {
      const tierScore = gameScore.tiers?.[t.id];
      if (!tierScore || tierScore.score.value === null) continue;
      /** @type {number[]} */
      const mine = [];
      for (const s of /** @type {string[]} */ (t.seeds)) {
        const v = bundle.scores.get(`${g.id}/${t.id}/${s}`);
        if (v !== undefined) mine.push(v);
      }
      if (mine.length === 0) continue;
      const mean = mine.reduce((x, y) => x + y, 0) / mine.length;
      // score() reports tier values rounded to 6 decimals — compare at that
      // precision, not against the raw mean.
      const rounded = Math.round(mean * 1e6) / 1e6;
      if (Math.abs(rounded - tierScore.score.value) > 1e-9) {
        mismatches.push(`${g.id}/${t.id}: mirror mean ${mean} (rounded ${rounded}) vs score() ${tierScore.score.value}`);
      }
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`mirror check failed against scoring/score.js (refusing to analyze):\n  ${mismatches.join('\n  ')}`);
  }
}

const argv = process.argv.slice(2);
/** @type {string[]} */
const dirs = [];
let suitePath = '';
let asJson = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--suite') suitePath = argv[++i];
  else if (argv[i] === '--json') asJson = true;
  else if (argv[i] === '--help' || argv[i] === '-h') {
    process.stdout.write('usage: node analyze.mjs BUNDLE... [--suite <suite.json>] [--json]\n');
    process.exit(0);
  } else dirs.push(argv[i]);
}
if (dirs.length < 2) {
  process.stderr.write('analyze.mjs needs at least two bundle directories to compare\n');
  process.exit(2);
}

/** @type {Bundle[]} */
const bundles = [];
for (let i = 0; i < dirs.length; i++) bundles.push(await loadBundle(dirs[i], i));
// Disambiguate duplicate labels deterministically: the first keeps the bare id.
/** @type {Map<string, number>} */
const seen = new Map();
for (const b of bundles) {
  const n = seen.get(b.label) ?? 0;
  seen.set(b.label, n + 1);
  if (n > 0) b.label = `${b.label}#${n + 1}`;
}
const suiteFile = suitePath || path.join(dirs[0], 'suite.json');
if (!existsSync(suiteFile)) {
  process.stderr.write(`no suite manifest at ${suiteFile} (pass --suite)\n`);
  process.exit(2);
}
const suite = /** @type {SuiteManifest} */ (JSON.parse(readFileSync(suiteFile, 'utf8')));
const suiteSha256 = createHash('sha256').update(readFileSync(suiteFile)).digest('hex');

let baseline;
if (existsSync(DEFAULT_BASELINE)) baseline = loadBaselineFile(DEFAULT_BASELINE);
for (const b of bundles) await scoreAndMirror(b, suite);

/** @type {string[]} */
const warnings = [];
for (const b of bundles) {
  const out = outsideSuite(b, suite);
  if (out.length > 0) warnings.push(`${b.label}: ${out.length} episode(s) outside the suite (ignored): ${out.slice(0, 5).join(', ')}${out.length > 5 ? ' …' : ''}`);
}

/** @type {Array<Record<string, *>>} */
const comparisons = [];
for (let i = 0; i < bundles.length; i++) {
  for (let j = i + 1; j < bundles.length; j++) {
    const key = `${bundles[i].label}~vs~${bundles[j].label}`;
    for (const profile of PROFILES) {
      if (profile === 'chance-adjusted' && !baseline) {
        comparisons.push({ comparison: key, profile, error: `no baseline at ${DEFAULT_BASELINE} — chance-adjusted reported only with a usable baseline` });
        continue;
      }
      const profBaseline = profile === 'chance-adjusted' ? /** @type {ScoringBaseline} */ (baseline) : undefined;
      const cells = /** @type {Record<string, ReturnType<typeof cell> | null>} */ ({});
      let sharedTiers = 0;
      let outcomeTiers = 0;
      /** @type {string[]} */
      const droppedTiers = [];
      for (const reading of READINGS) {
        const r = compare(bundles[i], bundles[j], suite, profile, profBaseline, `${key}/${reading}`, reading);
        sharedTiers = r.sharedTiers;
        outcomeTiers = r.outcomeTiers;
        droppedTiers.push(...r.droppedTiers);
        // The readings coincide off outcome tiers by construction; print one.
        cells[reading] = outcomeTiers === 0 && reading === 'invalid-adjusted' ? null : cell(r);
      }
      comparisons.push({
        comparison: key,
        profile,
        sharedTiers,
        outcomeTiers,
        droppedTiers: [...new Set(droppedTiers)].sort(),
        readings: cells,
      });
    }
  }
}

if (!asJson) {
  process.stdout.write(`suite ${suite.id} (${suiteSha256.slice(0, 16)})\n`);
  process.stdout.write(`bundles: ${bundles.map((b) => `${b.label} <${b.dir}>`).join(', ')}\n`);
  for (const w of warnings) process.stdout.write(`note: ${w}\n`);
  for (const c of comparisons) {
    if (/** @type {Record<string, *>} */ (c).error) {
      process.stdout.write(`\n${c.comparison} [${c.profile}]: ${/** @type {Record<string, string>} */ (c).error}\n`);
      continue;
    }
    process.stdout.write(`\n${c.comparison} [${c.profile}] — ${c.sharedTiers} shared tier(s), ${c.outcomeTiers} win/lose\n`);
    for (const d of /** @type {{ droppedTiers: string[] }} */ (c).droppedTiers) process.stdout.write(`  dropped: ${d}\n`);
    const readings = /** @type {Record<string, *>} */ (c).readings;
    for (const name of READINGS) {
      const r = readings[name];
      if (!r) continue;
      process.stdout.write(`  ${name.padEnd(17)} ${r.verdict.padEnd(14)} D=${String(r.D).padStart(10)}  ci95=[${r.ci95[0]}, ${r.ci95[1]}]  sign ${r.signAgree}\n`);
    }
  }
} else {
  process.stdout.write(
    JSON.stringify({ suite: { id: suite.id, sha256: suiteSha256 }, warnings, comparisons }, null, 2) + '\n'
  );
}
