#!/usr/bin/env node
/**
 * Compute the example-confound study's preregistered statistics from the
 * committed run bundles, through the official scorer (`scoring/score.js`),
 * which replay-verifies every trajectory before it counts — the same pattern
 * as model-separation-v2/solo/compute-stats.mjs.
 *
 * Emits stats.json (deterministic: the episode scores come from score()'s
 * seeded bootstrap; the paired-difference bootstraps here are seeded through
 * core/rng.js streamFromSeed; no timestamps).
 *
 * Per (model, arm) it reports:
 * - episode count, mean rhae-v1 score with a 10,000-draw percentile bootstrap
 *   CI (seeded),
 * - invalid-step rate (share of agent steps whose action was judged invalid),
 * - share of episodes with at least one invalid action,
 * - end-reason tally, seconds per agent call, tokens per agent call,
 * - the community-track agent id recorded in the bundles (provenance: the
 *   official leaderboard is untouched by construction),
 * - the arm's gap to the tier's random floor (calibration table).
 *
 * Paired-by-seed differences with seeded bootstrap CIs, exactly as pinned in
 * PREREGISTRATION.md:
 * - per (0.5B, 1.5B): corrected-assisted minus corrected-official,
 * - per model: connect4-neutral mean next to the calibration random floor
 *   (#92's example-copier mean is reported in REPORT.md prose),
 * - (0.5B, 1.5B): 1.5B minus 0.5B on corrected-official.
 *
 * Usage: node compute-stats.mjs [--runs <dir>] [--out <file>]
 *
 * @module
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { GAMES } from '../../games/index.js';
import { score } from '../../scoring/score.js';
import { streamFromSeed } from '../../core/rng.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAUNTLET = path.resolve(HERE, '../..');

const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const RUNS = flag('runs') ?? path.join(HERE, 'runs');
const OUT = flag('out') ?? path.join(HERE, 'stats.json');

const MODELS = [
  { stem: 'qwen2.5-0.5b-instruct-q4_k_m', short: 'qwen2.5-0.5b' },
  { stem: 'qwen2.5-1.5b-instruct-q4_k_m', short: 'qwen2.5-1.5b' },
  { stem: 'qwen2.5-7b-instruct-q4_k_m', short: 'qwen2.5-7b' },
];
const ARMS = ['corrected-official', 'corrected-assisted', 'corrected-7b', 'connect4-neutral'];
const BOOTSTRAP_DRAWS = 10_000;

const round6 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6);
const roundCI = (ci) => (ci ? [round6(ci[0]), round6(ci[1])] : null);

/** Walk a run directory collecting every public trajectory file. */
function trajectoryFiles(runDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = path.join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (entry.endsWith('.json') && /(^|\/)public\//.test(p.slice(runDir.length + 1))) found.push(p);
    }
  };
  walk(runDir);
  return found.sort();
}

/** Usage summary over a trajectory's agent steps. */
function usageOf(trajectory) {
  const agentSteps = trajectory.steps.filter((s) => s.by === 'agent');
  const usage = agentSteps.map((s) => s.usage).filter(Boolean);
  return {
    calls: agentSteps.length,
    invalid: agentSteps.filter((s) => s.invalid).length,
    ms: agentSteps.reduce((a, s) => a + (s.ms || 0), 0),
    tokIn: usage.reduce((a, u) => a + (u.promptTokens ?? u.inputTokens ?? 0), 0),
    tokOut: usage.reduce((a, u) => a + (u.completionTokens ?? u.outputTokens ?? 0), 0),
  };
}

/** Clone a suite manifest down to one seed. */
function miniSuite(suite, seed) {
  return {
    ...suite,
    id: `${suite.id}-ep-${seed.replaceAll('/', '-')}`,
    games: [{ ...suite.games[0], tiers: [{ ...suite.games[0].tiers[0], seeds: [seed] }] }],
  };
}

/** Per-episode score (rhae-v1 episode score) via the official scorer. */
async function collectEpisodes(suite, trajectories) {
  const out = [];
  for (const trajectory of trajectories) {
    const entry = await score(miniSuite(suite, trajectory.seed), [trajectory], GAMES, {});
    const block = entry.games[trajectory.game.id].tiers[trajectory.tier];
    const u = usageOf(trajectory);
    out.push({
      seed: trajectory.seed,
      score: block.score.value,
      endReason: trajectory.end?.reason ?? null,
      solved: trajectory.end?.outcome?.solved === true,
      normalized: trajectory.end?.outcome?.normalized ?? null,
      steps: u.calls,
      invalid: u.invalid,
      anyInvalid: u.invalid > 0,
      secPerCall: u.calls ? round6(u.ms / 1000 / u.calls) : null,
      tokPerCall: u.calls ? Math.round((u.tokIn + u.tokOut) / u.calls) : null,
    });
  }
  out.sort((a, b) => a.seed.localeCompare(b.seed));
  return out;
}

/** Seeded percentile bootstrap CI of a mean. */
function bootstrapCi(values, seedStr) {
  const n = values.length;
  if (n === 0) return null;
  const stream = streamFromSeed(seedStr);
  const draws = [];
  for (let d = 0; d < BOOTSTRAP_DRAWS; d++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(stream.nextFloat() * n) % n];
    draws.push(sum / n);
  }
  draws.sort((a, b) => a - b);
  const lo = draws[Math.floor(0.025 * BOOTSTRAP_DRAWS)];
  const hi = draws[Math.ceil(0.975 * BOOTSTRAP_DRAWS) - 1];
  return [round6(lo), round6(hi)];
}

/** Random floor for one tier from the version-aligned calibration table. */
function randomFloor(game, tier) {
  const tablePath = path.join(GAUNTLET, 'calibration/tables', `${game}.json`);
  if (!existsSync(tablePath)) return null;
  const table = JSON.parse(readFileSync(tablePath, 'utf8'));
  const row = table.baselines?.random?.tiers?.[tier];
  if (!row) return null;
  return {
    mean: row.score.value,
    ci95: row.score.ci95 ?? null,
    episodes: row.episodes,
    tableVersion: table.game?.version ?? null,
    source: `calibration/tables/${game}.json`,
  };
}

async function collectRun(runDir, model) {
  const suite = JSON.parse(readFileSync(path.join(runDir, 'suite.json'), 'utf8'));
  const run = JSON.parse(readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  const trajectories = trajectoryFiles(runDir).map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const episodes = await collectEpisodes(suite, trajectories);
  const n = episodes.length;
  const scores = episodes.map((e) => e.score);
  const invalidSteps = episodes.reduce((a, e) => a + e.invalid, 0);
  const totalSteps = episodes.reduce((a, e) => a + e.steps, 0);
  const endReasons = {};
  for (const e of episodes) endReasons[e.endReason ?? 'unknown'] = (endReasons[e.endReason ?? 'unknown'] ?? 0) + 1;
  const arm = suite.id.match(/example-confound-([a-z0-9-]+?)-[a-z0-9]+-[a-z0-9.]+-\d+$/)?.[1] ?? null;
  const secPerCallVals = episodes.filter((e) => e.secPerCall !== null).map((e) => e.secPerCall);
  return {
    runDir: path.relative(HERE, runDir),
    arm,
    suiteId: suite.id,
    agentId: run.agent?.text ?? trajectories[0]?.agent?.id ?? null,
    gameVersion: run.suite?.games?.[0]?.version ?? suite.games[0]?.version ?? null,
    n,
    meanScore: n ? round6(scores.reduce((a, v) => a + v, 0) / n) : null,
    ci95: bootstrapCi(scores, `${model.short}-${suite.id}`),
    invalidStepRate: totalSteps ? round6(invalidSteps / totalSteps) : null,
    anyInvalidEpisodeRate: n ? round6(episodes.filter((e) => e.anyInvalid).length / n) : null,
    endReasons,
    secPerCallMean: secPerCallVals.length
      ? round6(secPerCallVals.reduce((a, v) => a + v, 0) / secPerCallVals.length)
      : null,
    tokPerCallMean: (() => {
      const vals = episodes.filter((e) => e.tokPerCall !== null).map((e) => e.tokPerCall);
      return vals.length ? Math.round(vals.reduce((a, v) => a + v, 0) / vals.length) : null;
    })(),
    episodes,
  };
}

/** Paired-by-seed difference b - a with a seeded bootstrap CI. */
function pairedDiff(a, b, name) {
  const bySeed = new Map(a.episodes.map((e) => [e.seed, e.score]));
  const pairs = b.episodes
    .filter((e) => bySeed.has(e.seed))
    .map((e) => ({ seed: e.seed, diff: round6(e.score - bySeed.get(e.seed)) }));
  const diffs = pairs.map((p) => p.diff);
  if (!diffs.length) return { name, n: 0 };
  const mean = diffs.reduce((x, v) => x + v, 0) / diffs.length;
  return {
    name,
    n: pairs.length,
    meanDiff: round6(mean),
    ci95: bootstrapCi(diffs, `paired-${name}`),
    pairs,
  };
}

const stats = {
  runsRoot: path.relative(HERE, RUNS),
  randomFloors: {
    mastermindMini: randomFloor('mastermind', 'mini'),
    connect4Ladder1: randomFloor('connect4', 'ladder-1'),
  },
  runs: {},
  paired: {},
};

for (const model of MODELS) {
  const modelDir = path.join(RUNS, model.stem);
  if (!existsSync(modelDir)) continue;
  for (const entry of readdirSync(modelDir).sort()) {
    const runDir = path.join(modelDir, entry);
    if (!statSync(runDir).isDirectory() || !existsSync(path.join(runDir, 'run.json'))) continue;
    const collected = await collectRun(runDir, model);
    stats.runs[`${model.short}:${collected.arm ?? entry}`] = collected;
  }
}

for (const model of MODELS) {
  const official = stats.runs[`${model.short}:corrected-official`] ?? stats.runs[`${model.short}:corrected-7b`];
  if (!official) continue;
  // Floor gap: corrected example arm vs the tier's random floor (point diff
  // plus the interval-overlap verdict the preregistration pins).
  const floor = stats.randomFloors.mastermindMini;
  if (floor && official.arm !== 'connect4-neutral') {
    official.gapToRandomFloor = {
      floorMean: floor.mean,
      meanDiff: round6(official.meanScore - floor.mean),
      ciOverlapsFloor: official.ci95 ? official.ci95[0] <= floor.mean && floor.mean <= official.ci95[1] : null,
      aboveRandomPointEstimate: official.meanScore > floor.mean,
    };
  }
  const assisted = stats.runs[`${model.short}:corrected-assisted`];
  if (assisted) {
    stats.paired[`${model.short}:corrected-assisted-minus-corrected-official`] = pairedDiff(
      official,
      assisted,
      `${model.short}:corrected-assisted-minus-corrected-official`
    );
  }
}
{
  const a = stats.runs['qwen2.5-0.5b:corrected-official'];
  const b = stats.runs['qwen2.5-1.5b:corrected-official'];
  if (a && b) {
    stats.paired['1.5b-minus-0.5b:corrected-official'] = pairedDiff(a, b, '1.5b-minus-0.5b:corrected-official');
  }
}

writeFileSync(OUT, JSON.stringify(stats, null, 2) + '\n');
console.log(`stats written to ${path.relative(HERE, OUT)}`);
for (const [key, r] of Object.entries(stats.runs)) {
  console.log(
    `${key}: n=${r.n} mean=${r.meanScore} ci=[${r.ci95?.[0]},${r.ci95?.[1]}] invalidStep=${r.invalidStepRate} ` +
      `anyInvalidEp=${r.anyInvalidEpisodeRate} ends=${JSON.stringify(r.endReasons)} secPerCall=${r.secPerCallMean}`
  );
}
for (const [key, p] of Object.entries(stats.paired)) {
  console.log(`${key}: n=${p.n} meanDiff=${p.meanDiff} ci=[${p.ci95?.[0]},${p.ci95?.[1]}]`);
}
