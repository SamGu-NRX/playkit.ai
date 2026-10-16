/**
 * On-ramp study for the four new solo-puzzle tiers:
 * `sliding/p8-short`, `sokoban/one-box`, `mastermind/mini`, `cube/cube-2`.
 *
 * Runs, per tier over the tier's 16 public seeds:
 * - the three calibration baselines (random / greedy / engine), using the
 *   calibration kit's own agent wiring so the numbers are comparable with
 *   `calibration/tables/`;
 * - the pinned skill dial (dial.js) at p = 0, 0.1, 0.25, 0.5, 0.75, 1 with
 *   the engine as the expert.
 *
 * Episode scores follow `scoring/score.js`: outcome tiers score
 * `normalized[agentSeat]`; efficiency tiers score
 * `solved ? min(cap, (par / agentActions)^2) : 0` with cap 1.0 (optimal par)
 * or 1.15 (reference par), where `agentActions` counts invalid attempts.
 *
 * Statistics: mean with a percentile 95% bootstrap interval (10,000 seeded
 * resamples), Spearman rho of mean score against p over the six dial points
 * (tie-corrected average ranks), and the on-ramp gates:
 *   random < 0.15, dial p=0.5 in [0.2, 0.8], engine > 0.8,
 * plus the tier-discrimination rule: rho <= -0.9 and the p=0.25 / p=0.75
 * intervals do not overlap.
 *
 * Usage: `node studies/onramp-solo/run.mjs [--out results.json]`
 *
 * @module
 */

import { writeFileSync } from 'node:fs';

import { CALIBRATION_GAMES, makeBaselineAgent } from '../../calibration/games.js';
import { runEpisode } from '../../core/runner.js';
import { streamFromSeed } from '../../core/rng.js';
import { publicSeed } from '../../core/seeds.js';
import { skillDial, DIAL_P_VALUES } from './dial.js';

const OUT = (() => {
  const flag = process.argv.find((a) => a.startsWith('--out='));
  return flag ? flag.slice('--out='.length) : new URL('./results.json', import.meta.url).pathname;
})();

const TIERS = [
  { gameId: 'sliding', tierId: 'p8-short' },
  { gameId: 'sokoban', tierId: 'one-box' },
  { gameId: 'mastermind', tierId: 'mini' },
  { gameId: 'cube', tierId: 'cube-2' },
];

/** Public seeds per new tier: the on-ramp rule asks for at least 16. */
const SEEDS = 16;
const BOOTSTRAP_DRAWS = 10_000;

/** @type {Record<string, { episodes: number }>} */
const EpisodeCounts = {};

/**
 * Episode score per `scoring/score.js` (read from the returned trajectory;
 * no scoring-profile transforms apply to these tiers).
 *
 * @param {ReturnType<typeof Object>} trajectory
 * @param {{ scoring: string, parKind: string }} tier
 * @returns {number}
 */
function episodeScoreOf(trajectory, tier) {
  const outcome = trajectory.end.outcome;
  const seat = trajectory.agent.seat;
  if (tier.scoring === 'outcome') {
    const normalized = outcome?.normalized;
    return Array.isArray(normalized) && Number.isFinite(normalized[seat]) ? normalized[seat] : 0;
  }
  if (outcome?.solved !== true) return 0;
  const par = outcome.par;
  const agentActions = trajectory.end.agentActions;
  if (!(typeof par === 'number' && par > 0) || !(Number.isInteger(agentActions) && agentActions > 0)) {
    throw new Error(`cannot score honestly: ${trajectory.game.id}/${trajectory.tier}/${trajectory.seed}`);
  }
  const cap = tier.parKind === 'optimal' ? 1.0 : 1.15;
  return Math.min(cap, (par / agentActions) ** 2);
}

/**
 * Mean over the episode scores, with a seeded percentile bootstrap CI.
 * @param {number[]} scores
 * @param {string} bootstrapSeed
 * @returns {{ mean: number, ci95: [number, number] }}
 */
function meanWithCi(scores, bootstrapSeed) {
  const n = scores.length;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const stream = streamFromSeed(bootstrapSeed);
  const means = [];
  for (let d = 0; d < BOOTSTRAP_DRAWS; d++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const pick = Math.floor(stream.nextFloat() * n) % n;
      sum += scores[pick];
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return {
    mean,
    ci95: [means[Math.floor(0.025 * BOOTSTRAP_DRAWS)], means[Math.ceil(0.975 * BOOTSTRAP_DRAWS) - 1]],
  };
}

/**
 * Spearman rank correlation of mean score against p, tie-corrected.
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number}
 */
function spearmanRho(xs, ys) {
  const n = xs.length;
  const rank = (values) => {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
      const average = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[order[k][1]] = average;
      i = j + 1;
    }
    return ranks;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

/**
 * Run one arm over the tier's public seeds. Baselines go through the
 * calibration kit's `makeBaselineAgent` (the per-entry makeAgent maps
 * everything except 'greedy' to the engine; 'random' must stay the shared
 * uniform agent). Returns the episode scores plus the dial's expert-fallback
 * count for the arm (0 for plain baselines).
 *
 * @param {object} calGame entry from CALIBRATION_GAMES
 * @param {object} tier TierSpec
 * @param {'random' | 'greedy' | 'engine' | 'dial'} kind
 * @param {number | null} p dial p value when kind is 'dial'
 * @returns {Promise<{ scores: number[], fallbacks: number }>}
 */
async function runArm(calGame, tier, kind, p = null) {
  const scores = [];
  let fallbacks = 0;
  for (let i = 0; i < SEEDS; i++) {
    const seed = publicSeed(calGame.id, tier.id, i);
    let agent;
    if (kind === 'dial') {
      agent = skillDial({
        expert: makeBaselineAgent(calGame, 'engine', { episodeSeed: seed, seat: 0, tier }),
        p: /** @type {number} */ (p),
        episodeSeed: seed,
      });
    } else {
      agent = makeBaselineAgent(calGame, kind, { episodeSeed: seed, seat: 0, tier });
    }
    const trajectory = await runEpisode({
      game: calGame.game,
      tierId: tier.id,
      seed,
      agent,
    });
    if (kind === 'dial' && typeof /** @type {any} */ (agent).fallbackCount === 'number') {
      fallbacks += /** @type {any} */ (agent).fallbackCount;
    }
    scores.push(episodeScoreOf(trajectory, tier));
  }
  return { scores, fallbacks };
}

const results = [];
for (const { gameId, tierId } of TIERS) {
  const calGame = CALIBRATION_GAMES.find((g) => g.id === gameId);
  if (!calGame) throw new Error(`no calibration entry for ${gameId}`);
  const game = calGame.game;
  const tier = game.spec.tiers.find((t) => t.id === tierId);
  if (!tier) throw new Error(`${gameId} has no tier ${tierId}`);

  const arms = {};
  for (const kind of ['random', 'greedy', 'engine']) {
    const { scores } = await runArm(calGame, tier, kind);
    arms[kind] = { scores, ...meanWithCi(scores, `onramp/${gameId}/${tierId}/${kind}`) };
    process.stderr.write(`[onramp] ${gameId}/${tierId} ${kind}: ${arms[kind].mean.toFixed(4)}\n`);
  }
  const dialMeans = [];
  const dialStats = {};
  const dialFallbacks = {};
  for (const p of DIAL_P_VALUES) {
    const { scores, fallbacks } = await runArm(calGame, tier, 'dial', p);
    dialStats[String(p)] = { scores, ...meanWithCi(scores, `onramp/${gameId}/${tierId}/dial/${p}`) };
    dialFallbacks[String(p)] = fallbacks;
    dialMeans.push(dialStats[String(p)].mean);
    process.stderr.write(`[onramp] ${gameId}/${tierId} dial p=${p}: ${dialStats[String(p)].mean.toFixed(4)} (fallbacks ${fallbacks})\n`);
  }

  const rho = spearmanRho([...DIAL_P_VALUES], dialMeans);
  const [lo25] = dialStats['0.25'].ci95;
  const [lo75] = dialStats['0.75'].ci95;
  const hi25 = dialStats['0.25'].ci95[1];
  const hi75 = dialStats['0.75'].ci95[1];
  const separated = hi25 < lo75 || hi75 < lo25; // strictly non-overlapping
  const gates = {
    randomBelow: { rule: 'random < 0.15', value: arms.random.mean, pass: arms.random.mean < 0.15 },
    dialMidInRange: {
      rule: '0.2 <= dial p=0.5 <= 0.8',
      value: dialStats['0.5'].mean,
      pass: dialStats['0.5'].mean >= 0.2 && dialStats['0.5'].mean <= 0.8,
    },
    expertAbove: { rule: 'engine > 0.8', value: arms.engine.mean, pass: arms.engine.mean > 0.8 },
    discriminates: {
      rule: 'spearman rho <= -0.9 and p=0.25/p=0.75 intervals disjoint',
      rho,
      intervalsOverlap: !separated,
      pass: rho <= -0.9 && separated,
    },
  };
  results.push({
    game: gameId,
    tier: tierId,
    gameVersion: game.spec.version,
    scoring: tier.scoring,
    parKind: tier.parKind,
    seeds: SEEDS,
    arms: {
      random: { mean: arms.random.mean, ci95: arms.random.ci95 },
      greedy: { mean: arms.greedy.mean, ci95: arms.greedy.ci95 },
      engine: { mean: arms.engine.mean, ci95: arms.engine.ci95 },
      dial: Object.fromEntries(
        DIAL_P_VALUES.map((p) => [
          String(p),
          { mean: dialStats[String(p)].mean, ci95: dialStats[String(p)].ci95, expertFallbacks: dialFallbacks[String(p)] },
        ])
      ),
    },
    gates,
    episodeScores: {
      random: arms.random.scores,
      greedy: arms.greedy.scores,
      engine: arms.engine.scores,
      dial: Object.fromEntries(DIAL_P_VALUES.map((p) => [String(p), dialStats[String(p)].scores])),
    },
  });
  EpisodeCounts[`${gameId}/${tierId}`] = { episodes: SEEDS * (3 + DIAL_P_VALUES.length) };
}

writeFileSync(OUT, JSON.stringify({ format: 'playkit-gauntlet-onramp-study/1', results }, null, 2));

// Console summary.
for (const r of results) {
  const fmt = (a) => `${a.mean.toFixed(3)} [${a.ci95[0].toFixed(3)}, ${a.ci95[1].toFixed(3)}]`;
  console.log(`\n${r.game}/${r.tier} (v${r.gameVersion}, ${r.seeds} seeds)`);
  console.log(`  random  ${fmt(r.arms.random)}`);
  console.log(`  greedy  ${fmt(r.arms.greedy)}`);
  console.log(`  engine  ${fmt(r.arms.engine)}`);
  for (const p of ['0.25', '0.5', '0.75']) {
    console.log(`  dial p=${p}  ${fmt(r.arms.dial[p])}`);
  }
  const marks = Object.values(r.gates).map((g) => `${g.pass ? 'PASS' : 'FAIL'} (${g.rule})`).join('; ');
  console.log(`  gates: ${marks}`);
}
console.log(`\nwrote ${OUT}`);
