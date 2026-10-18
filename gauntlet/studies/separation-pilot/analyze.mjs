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
 *           (streamFromSeed('separation-pilot/<sorted-pair>'), per
 *           PREREGISTRATION.md — one resampling stream per comparison, shared
 *           by every profile and reading) — identical bundles always yield
 *           byte-identical intervals
 *
 * SEPARATED iff the interval excludes zero and at least ceil(T/2) shared tiers
 * agree in sign with D. Win/lose ("outcome") tiers are reported under both
 * pre-registered invalid-reply readings (`raw` and `invalid-adjusted`,
 * e' = e × (1 − invalidActions/agentActions)); efficiency tiers coincide by
 * construction and appear once. Verdicts are data — exit 0 either way; exit 2
 * only on structural errors (unverified trajectories, no shared seeds, mirror
 * mismatch).
 *
 * The pure statistics live in `analysis-lib.mjs`; this file is the I/O shell:
 * bundle loading, replay verification, the production `score()` mirror, and
 * output.
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
import { getGame, GAMES } from '../../games/index.js';
import { score, GauntletRefusalError } from '../../scoring/score.js';
import { loadBaselineFile } from '../../scoring/baselines.js';
import { loadTrajectories } from '../../cli/verify.js';
import { cell, compare, episodeScore, PROFILES, READINGS, suiteKeysOf } from './analysis-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.join(here, '../../scoring/baselines/random-public.json');

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
 * @param {Bundle} bundle
 * @param {SuiteManifest} suite
 * @returns {string[]}
 */
function outsideSuite(bundle, suite) {
  const keys = suiteKeysOf(suite);
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
 * The mirror sees ONLY in-suite trajectories: the analysis documents
 * out-of-suite episodes as ignored, so feeding them to `score()` would make
 * the mirror check depend on leftover files instead of the analyzed data
 * (Codex #4301264694).
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
  const memberKeys = suiteKeysOf(suite);
  for (const g of suite.games) {
    const trajs = bundle.trajectories.filter((t) => t.game.id === g.id && memberKeys.has(`${t.game.id}/${t.tier}/${t.seed}`));
    if (trajs.length === 0) continue;
    let entry;
    try {
      entry = await score({ ...suite, games: [g] }, trajs, GAMES, {});
    } catch (err) {
      // A single-game suite of a game whose spec.benchmark is not true is
      // refused before any tier is scored: score() defines the benchmark
      // aggregate only over benchmark-flagged games, and a suite with none
      // has no benchmark score. That refusal is about the suite shape, not
      // about this game's tier scores - production computes those the same
      // way in any multi-game suite (the pilot-1seed option carries
      // tictactoe, the registry's only benchmark:false game, and its
      // full-suite leaderboard scores it). Skip this game's mirror loudly
      // rather than block the preregistered analysis on the suite shape.
      if (err instanceof GauntletRefusalError && err.step === 'benchmark-games') {
        process.stderr.write(`analyze: mirror skipped for ${g.id}: production score() refuses a single-game suite with no benchmark-flagged games (spec.benchmark !== true)\n`);
        continue;
      }
      throw err;
    }
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
if (existsSync(DEFAULT_BASELINE)) {
  // loadBaselineFile returns a LoadedBaseline wrapper ({ baseline, sha256 });
  // the analyzer wants the validated ScoringBaseline itself. The sha256 is
  // file provenance and is not consumed here.
  baseline = loadBaselineFile(DEFAULT_BASELINE).baseline;
}
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
    // The comparison is an unordered pair: the comparison name and the
    // bootstrap stream are keyed by the SORTED labels, so analyze(B, A)
    // negates D and the interval bounds exactly — the preregistered
    // label-swap symmetry (PREREGISTRATION.md, instrument checks). The key
    // is the pair ALONE: every profile and reading of this comparison
    // resamples from the same seeded stream, exactly as PREREGISTRATION.md
    // pins it (streamFromSeed('separation-pilot/<comparison-key>')).
    const key = [bundles[i].label, bundles[j].label].slice().sort().join('~vs~');
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
        const r = compare(bundles[i], bundles[j], suite, profile, profBaseline, key, reading);
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
