#!/usr/bin/env node
/**
 * Compute the model-separation-v2 solo study's statistics from the committed
 * run bundles, through the official scorer (`scoring/score.js`), which also
 * replay-verifies every trajectory before it counts.
 *
 * Emits stats.json (deterministic: score()'s bootstrap draws are seeded from
 * the suite id; the paired-difference bootstraps here are seeded through
 * core/rng.js streamFromSeed; no timestamps).
 *
 * Per (model, tier) it reports, for each scoring profile (rhae-v1,
 * squared-outcome, chance-adjusted):
 * - episode count, mean tier score with a 10,000-draw percentile bootstrap CI
 *   (score()'s own, seeded),
 * - the tier's random mean from its calibration table next to it
 *   (nonogram/tiny has no calibration table: a study-local random run under
 *   runs-random/nonogram-tiny supplies it),
 * - whether the model's interval separates from the random interval, and
 *   whether the point mean beats the random mean,
 * - invalid-reply rate, seconds per agent call, tokens per call, nominal cost.
 *
 * Per tier it also reports:
 * - paired-by-seed mean differences 1.5B-0.5B and 7B-1.5B with seeded
 *   10,000-draw percentile bootstrap CIs (episode-wise profile transform,
 *   then difference, then bootstrap),
 * - Spearman rho of model size against tier mean score over the three model
 *   means (tie-corrected), plus the pooled-episode rho as an auxiliary read.
 *
 * Usage: node compute-stats.mjs [--runs <dir>] [--out <file>]
 *
 * @module
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { GAMES } from '../../../games/index.js';
import { score } from '../../../scoring/score.js';
import { streamFromSeed } from '../../../core/rng.js';

const COLLECTED = {};
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAUNTLET = path.resolve(HERE, '../../..');

const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const RUNS = flag('runs') ?? path.join(HERE, 'runs');
const OUT = flag('out') ?? path.join(HERE, 'stats.json');
const RANDOM_RUNS = path.join(HERE, 'runs-random');

const MODELS = [
  { stem: 'qwen2.5-0.5b-instruct-q4_k_m', short: 'qwen2.5-0.5b', size: 0.5 },
  { stem: 'qwen2.5-1.5b-instruct-q4_k_m', short: 'qwen2.5-1.5b', size: 1.5 },
  { stem: 'qwen2.5-7b-instruct-q4_k_m', short: 'qwen2.5-7b', size: 7 },
];
const TIERS = [
  { game: 'sliding', tier: 'p8-short' },
  { game: 'sokoban', tier: 'one-box' },
  { game: 'mastermind', tier: 'mini' },
  { game: 'cube', tier: 'cube-2' },
  { game: 'nonogram', tier: 'tiny' },
  { game: 'minesweeper', tier: 'beginner' },
];
const PROFILES = ['rhae-v1', 'squared-outcome', 'chance-adjusted'];
const BOOTSTRAP_DRAWS = 10_000;
const PAIRS = [
  { name: '1.5b-minus-0.5b', big: 'qwen2.5-1.5b', small: 'qwen2.5-0.5b' },
  { name: '7b-minus-1.5b', big: 'qwen2.5-7b', small: 'qwen2.5-1.5b' },
];

const round6 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6);
const roundCI = (ci) => (ci ? [round6(ci[0]), round6(ci[1])] : null);

/** Walk a run directory collecting every trajectory file. */
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
async function episodeScores(suite, trajectories) {
  const out = [];
  for (const trajectory of trajectories) {
    const entry = await score(miniSuite(suite, trajectory.seed), [trajectory], GAMES, {});
    const block = entry.games[trajectory.game.id].tiers[trajectory.tier];
    out.push({ seed: trajectory.seed, e: block.score.value, solved: block.solvedFraction === 1 });
  }
  return out;
}

/** Seeded percentile bootstrap CI of a mean. */
function bootstrapCi(values, seedStr) {
  const n = values.length;
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

/** Tie-corrected Spearman rho. */
function spearmanRho(xs, ys) {
  const rank = (values) => {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(values.length).fill(0);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[order[k][1]] = avg;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let k = 0; k < n; k++) {
    num += (rx[k] - (n + 1) / 2) * (ry[k] - (n + 1) / 2);
    dx += (rx[k] - (n + 1) / 2) ** 2;
    dy += (ry[k] - (n + 1) / 2) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return round6(num / Math.sqrt(dx * dy));
}

/** Random baseline for one tier: calibration table, else study-local run. */
function randomBaselineFor(game, tier) {
  const tablePath = path.join(GAUNTLET, 'calibration/tables', `${game}.json`);
  if (existsSync(tablePath)) {
    const table = JSON.parse(readFileSync(tablePath, 'utf8'));
    const row = table.baselines?.random?.tiers?.[tier];
    if (row) {
      return {
        mean: row.score.value,
        ci95: row.score.ci95,
        episodes: row.episodes,
        source: `calibration/tables/${game}.json`,
        gameVersion: table.game.version,
      };
    }
  }
  const localDir = path.join(RANDOM_RUNS, `${game}-${tier}`);
  const localSuitePath = path.join(localDir, 'suite.json');
  if (existsSync(localSuitePath)) {
    return { studyLocalRunDir: path.relative(HERE, localDir) };
  }
  return null;
}

/**
 * Score the study-local random run for one tier via the official scorer and
 * return { mean, ci95, episodes, gameVersion }.
 */
async function scoreStudyLocalRandom(game, tier, entry) {
  const dir = path.join(RANDOM_RUNS, `${game}-${tier}`);
  const suite = JSON.parse(readFileSync(path.join(dir, 'suite.json'), 'utf8'));
  const trajectories = trajectoryFiles(dir).map((p) => JSON.parse(readFileSync(p, 'utf8')));
  const result = await score(suite, trajectories, GAMES, { profile: entry.profile, baseline: entry.baseline });
  const block = result.games[game].tiers[tier];
  return {
    mean: block.score.value,
    ci95: block.score.ci95,
    episodes: block.episodes,
    gameVersion: suite.games[0].version,
    source: 'study-local random run (runs-random/), scored through scoring/score.js',
  };
}

const stats = {
  format: 'playkit-gauntlet-msep-v2-solo-stats/1',
  pinned: {
    serve: 'llama.cpp llama-server b11662, --ctx-size 4096 --temp 0 --seed 42 --threads 8, one warm-up call',
    run: '--concurrency 1 --max-output-tokens 256 --call-timeout-ms 60000, official model track',
    scorer: 'scoring/score.js (replay-verifies every trajectory it scores)',
    bootstrap: '10,000-draw percentile intervals; score() seeds from suite id, paired diffs from core/rng.js',
  },
  models: MODELS.map(({ stem, short, size }) => ({ stem, short, size })),
  tiers: TIERS.map(({ game, tier }) => ({ game, tier })),
  profiles: PROFILES,
  random: {},
  perTier: {},
};

// The chance-adjusted baseline: generated from the committed calibration
// tables (as #60 did), with the study-local nonogram entry appended.
let baseline = null;
let baselineNote = null;
const generatedPath = path.join(HERE, 'baseline-random.json');
if (existsSync(generatedPath)) {
  baseline = JSON.parse(readFileSync(generatedPath, 'utf8'));
  baselineNote = 'baseline-random.json generated by scoring/generate-baseline.js from calibration/tables (nonogram entry measured study-local)';
}

for (const { game, tier } of TIERS) {
  const slug = `${game}-${tier}`;
  const key = `${game}/${tier}`;
  stats.random[key] = randomBaselineFor(game, tier);
  if (stats.random[key]?.studyLocalRunDir) {
    delete stats.random[key].studyLocalRunDir;
    stats.random[key] = {
      ...(await scoreStudyLocalRandom(game, tier, { profile: 'rhae-v1', baseline })),
      source: 'study-local random run (runs-random/), scored through scoring/score.js',
    };
  }

  const perModel = {};
  const episodesByModel = {};
  for (const model of MODELS) {
    const runDir = path.join(RUNS, model.stem, slug);
    if (!existsSync(runDir) || trajectoryFiles(runDir).length === 0) {
      perModel[model.short] = { episodes: 0, note: 'not played (see REPORT.md)' };
      continue;
    }
    const suite = JSON.parse(readFileSync(path.join(runDir, 'suite.json'), 'utf8'));
    const trajectories = trajectoryFiles(runDir).map((p) => JSON.parse(readFileSync(p, 'utf8')));
    const usage = trajectories.map(usageOf);
    const calls = usage.reduce((a, u) => a + u.calls, 0) || 1;

    const scoresByProfile = {};
    for (const profile of PROFILES) {
      const entry = await score(suite, trajectories, GAMES, {
        profile,
        ...(profile === 'chance-adjusted' && baseline ? { baseline } : {}),
      });
      const block = entry.games[game].tiers[tier];
      scoresByProfile[profile] = {
        mean: block.score.value,
        ci95: roundCI(block.score.ci95),
        episodes: block.episodes,
        solvedFraction: block.solvedFraction,
        invalidActionRate: entry.invalidActionRate,
        costUsd: entry.costUsd,
      };
    }
    const episodes = await episodeScores(suite, trajectories);
    episodesByModel[model.short] = episodes;
    COLLECTED[model.short] = (COLLECTED[model.short] ?? []).concat(episodes);
    perModel[model.short] = {
      agent: trajectories[0]?.agent?.id ?? null,
      episodes: trajectories.length,
      seeds: episodes.map((e) => e.seed),
      scores: scoresByProfile,
      invalidReplyRate: round6(usage.reduce((a, u) => a + u.invalid, 0) / calls),
      secPerCall: round6(usage.reduce((a, u) => a + u.ms, 0) / 1000 / calls),
      tokensPerCall: round6(usage.reduce((a, u) => a + u.tokIn + u.tokOut, 0) / calls),
    };
  }

  // Separation against random (primary profile: rhae-v1).
  const rand = stats.random[key];
  const beatRandom = {};
  for (const model of MODELS) {
    const m = perModel[model.short];
    if (!m || !m.scores) continue;
    const mine = m.scores['rhae-v1'];
    beatRandom[model.short] = {
      randomMean: rand?.mean ?? null,
      beatsRandomMean: mine.mean != null && rand?.mean != null ? mine.mean > rand.mean : null,
      separatedFromRandom:
        mine.ci95 && rand?.ci95 ? mine.ci95[0] > rand.ci95[1] || mine.ci95[1] < rand.ci95[0] : null,
      belowRandomMean: mine.mean != null && rand?.mean != null ? mine.mean < rand.mean : null,
    };
  }

  // Paired-by-seed differences with seeded bootstrap CIs, per profile.
  const paired = {};
  for (const pair of PAIRS) {
    const big = episodesByModel[pair.big];
    const small = episodesByModel[pair.small];
    if (!big || !small) continue;
    const bySeed = new Map(small.map((e) => [e.seed, e.e]));
    const common = big.filter((e) => bySeed.has(e.seed));
    if (common.length < 2) {
      paired[pair.name] = { seeds: common.length, note: 'too few shared seeds' };
      continue;
    }
    const diffs = {};
    for (const profile of PROFILES) {
      const values = common.map((e) => {
        const eb = e.e;
        const es = bySeed.get(e.seed);
        const t = (x) => {
          if (profile === 'squared-outcome') return x * x;
          if (profile === 'chance-adjusted') {
            const r = rand?.mean ?? 0;
            return Math.max(0, (x - r) / (1 - r));
          }
          return x;
        };
        return t(eb) - t(es);
      });
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      diffs[profile] = { mean: round6(mean), ci95: bootstrapCi(values, `msep-v2-solo/${slug}/${pair.name}/${profile}`) };
    }
    paired[pair.name] = { seeds: common.length, diffs };
  }

  // Size order: monotone means and Spearman rho of size vs score.
  const means = MODELS.map((m) => perModel[m.short]?.scores?.['rhae-v1']?.mean ?? null);
  const complete = means.every((v) => v != null);
  const spearman = complete ? spearmanRho(MODELS.map((m) => m.size), means) : null;
  const pooled = [];
  for (const model of MODELS) {
    for (const e of episodesByModel[model.short] ?? []) pooled.push({ size: model.size, e: e.e });
  }
  const rhoPooled = pooled.length > 2 ? spearmanRho(pooled.map((p) => p.size), pooled.map((p) => p.e)) : null;

  stats.perTier[key] = {
    perModel,
    beatRandom,
    pairedDiffs: paired,
    sizeOrder: {
      meansRhaeV1: Object.fromEntries(MODELS.map((m, i) => [m.short, means[i]])),
      monotoneIncreasing: complete ? means[0] < means[1] && means[1] < means[2] : null,
      strictlyOrdered: complete ? means[0] <= means[1] && means[1] <= means[2] : null,
      spearmanRho: spearman,
      spearmanRhoPooledEpisodes: rhoPooled,
      pooledEpisodes: pooled.length,
    },
  };
}

// Pooled rhae-v1 episode scores per model (all tiers), with bootstrap CIs.
stats.pooled = {};
for (const model of MODELS) {
  const eps = COLLECTED[model.short] ?? [];
  const vals = eps.map((e) => e.e);
  stats.pooled[model.short] = {
    episodes: vals.length,
    meanRhaeV1: vals.length ? round6(vals.reduce((a, v) => a + v, 0) / vals.length) : null,
    ci95: vals.length ? bootstrapCi(vals, `msep-v2-pool-${model.short}`) : null,
  };
}

writeFileSync(OUT, JSON.stringify(stats, null, 2) + '\n');
console.log(`wrote ${OUT}`);
