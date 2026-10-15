/**
 * The chess ladder benchmark: head-to-head games between adjacent engine
 * tiers, both colours, public seeds, refereed by the game module itself.
 *
 * Usage:
 *
 *   node games/chess/ladder.js                 # full ladder, parallel
 *   node games/chess/ladder.js --games=12      # fewer games per pair
 *   node games/chess/ladder.js --one-game '<json>'
 *
 * The one-game form runs a single game and prints one JSON result line; the
 * default form forks itself into a worker pool, collects the results, and
 * prints a markdown report: per-pair score for the higher rung with a Wilson
 * 95% interval, termination breakdown, per-tier move time, and total wall
 * time. Node-only (child_process, os) — game modules stay runtime-clean.
 *
 * @module
 */

import { fork } from 'node:child_process';
import { cpus } from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import chess, { TRUNCATION_WIN_CP } from './index.js';

/** @import { Agent, Outcome, TierSpec } from '../../core/types.js' */

const GAMES_PER_PAIR = Number(process.argv[2]?.match(/^--games=(\d+)$/)?.[1] ?? 24);

/**
 * @typedef {object} LadderGameTask
 * @property {TierSpec} lower Weaker tier.
 * @property {TierSpec} higher Stronger tier.
 * @property {number} higherSeat Seat the stronger engine takes.
 * @property {string} seed Episode seed.
 */

/**
 * One ladder game: both seats are tier engines, the episode runs to natural
 * termination or the per-seat action budget (each engine honours its own
 * tier's maxActions), and a still-running episode is truncation-adjudicated
 * exactly like a real agent episode at the 500cp quiescence threshold.
 *
 * @param {LadderGameTask} task
 * @returns {Promise<{ higherScore: number, termination: string, plies: number, ms: number, lowerMoves: number, higherMoves: number }>}
 */
async function runOneGame(task) {
  const { lower, higher, higherSeat, seed } = task;
  const lowerSeat = higherSeat === 0 ? 1 : 0;
  // The chess module always provides an opponent factory.
  const opponentFactory = /** @type {NonNullable<typeof chess.opponent>} */ (chess.opponent);
  /** @type {Record<number, Agent>} */
  const agents = {
    [lowerSeat]: opponentFactory(lower, seed, lowerSeat),
    [higherSeat]: opponentFactory(higher, seed, higherSeat),
  };
  /** @type {Record<number, number>} */
  const actionsTaken = { 0: 0, 1: 0 };
  const t0 = process.hrtime.bigint();
  let state = chess.reset(lower, seed);
  let plies = 0;
  for (;;) {
    const seat = chess.toAct(state);
    if (seat === null) break;
    const tier = seat === lowerSeat ? lower : higher;
    if (actionsTaken[seat] >= tier.maxActions) {
      state = { ...state, termination: /** @type {const} */ ({ type: 'truncation', winner: null }) };
      break;
    }
    const observation = chess.observe(state, seat);
    const context = /** @type {import('../../core/types.js').TurnContext} */ ({
      observation,
      legalActions: observation.data.you === seat ? chess.legalActions(state, seat) : [],
      turn: plies,
    });
    const result = await /** @type {Agent} */ (agents[seat]).act(context);
    state = chess.step(state, seat, result.text);
    actionsTaken[seat]++;
    plies++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  /** @type {Outcome} */
  const outcome = /** @type {Outcome} */ (chess.outcome(state));
  return {
    higherScore: outcome.normalized[higherSeat],
    termination: state.termination?.type ?? 'unknown',
    plies,
    ms,
    lowerMoves: actionsTaken[lowerSeat],
    higherMoves: actionsTaken[higherSeat],
  };
}

// Worker mode: run a single game, print one JSON line.
if (process.argv[2] === '--one-game') {
  const task = /** @type {LadderGameTask} */ (JSON.parse(process.argv[3]));
  const spec = /** @type {TierSpec[]} */ (chess.spec.tiers);
  const byId = new Map(spec.map((t) => [t.id, t]));
  task.lower = /** @type {TierSpec} */ (byId.get(task.lower.id));
  task.higher = /** @type {TierSpec} */ (byId.get(task.higher.id));
  const result = await runOneGame(task);
  console.log(JSON.stringify({ ...result, seed: task.seed, pair: `${task.lower.id}>${task.higher.id}`, higherSeat: task.higherSeat }));
  process.exit(0);
}

/**
 * Wilson 95% score interval for the higher rung's mean score per game.
 *
 * @param {number[]} scores One entry per game, in [0, 1] (draws 0.5).
 * @returns {{ mean: number, lo: number, hi: number }}
 */
function wilsonInterval(scores) {
  const n = scores.length;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const z = 1.96;
  const p = mean;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { mean, lo: (centre - spread) / denom, hi: (centre + spread) / denom };
}

/**
 * Build the game list for every adjacent tier pair, alternating colours.
 *
 * @param {number} gamesPerPair
 * @returns {LadderGameTask[]}
 */
function buildTasks(gamesPerPair) {
  const spec = /** @type {TierSpec[]} */ (chess.spec.tiers);
  /** @type {LadderGameTask[]} */
  const tasks = [];
  for (let i = 0; i + 1 < spec.length; i++) {
    const lower = spec[i];
    const higher = spec[i + 1];
    for (let g = 0; g < gamesPerPair; g++) {
      tasks.push({
        lower,
        higher,
        // Alternate colours so neither tier is tied to white or black.
        higherSeat: g % 2,
        seed: `ladder/${lower.id}/${g}`,
      });
    }
  }
  return tasks;
}

/**
 * @param {LadderGameTask[]} tasks
 * @param {number} workers
 * @returns {Promise<Array<{ result: Awaited<ReturnType<typeof runOneGame>>, task: LadderGameTask }>>}
 */
async function runPool(tasks, workers) {
  const self = fileURLToPath(import.meta.url);
  /** @type {Array<{ result: Awaited<ReturnType<typeof runOneGame>>, task: LadderGameTask }>} */
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = next++;
        if (index >= tasks.length) return;
        const task = tasks[index];
        const result = await new Promise((resolve, reject) => {
          const child = fork(self, ['--one-game', JSON.stringify(task)], { stdio: 'pipe' });
          let stdout = '';
          child.stdout?.on('data', (chunk) => {
            stdout += chunk;
          });
          child.stderr?.on('data', (chunk) => {
            process.stderr.write(chunk);
          });
          child.on('exit', (code) => {
            if (code !== 0) {
              reject(new Error(`worker exited ${code} for ${task.seed}`));
              return;
            }
            const line = stdout.trim().split('\n').at(-1) ?? '';
            resolve(JSON.parse(line));
          });
        });
        results.push({ result, task });
      }
    })
  );
  return results;
}

// Orchestration mode.
const started = process.hrtime.bigint();
const tasks = buildTasks(GAMES_PER_PAIR);
const workers = Math.max(1, Math.min(cpus().length - 2, 6));
const results = await runPool(tasks, workers);
const wallMs = Number(process.hrtime.bigint() - started) / 1e6;

const spec = /** @type {TierSpec[]} */ (chess.spec.tiers);
console.log(`# chess ladder — ${GAMES_PER_PAIR} games per adjacent pair, both colours, truncation threshold ${TRUNCATION_WIN_CP}cp`);
console.log('');
console.log('| Pair (higher > lower) | Higher-rung score | Wilson 95% | Terminations | Avg plies | Avg game time |');
console.log('| --- | --- | --- | --- | --- | --- |');
/** @type {Map<string, { ms: number, moves: number, games: number }>} */
const perTier = new Map();
const bumpTier = (/** @type {string} */ id, /** @type {number} */ ms, /** @type {number} */ moves) => {
  const entry = perTier.get(id) ?? { ms: 0, moves: 0, games: 0 };
  entry.ms += ms / 2; // each game splits its wall time evenly between the two tiers
  entry.moves += moves;
  entry.games += 1;
  perTier.set(id, entry);
};
for (let i = 0; i + 1 < spec.length; i++) {
  const lower = spec[i];
  const higher = spec[i + 1];
  const pair = results.filter((r) => r.task.lower.id === lower.id);
  const scores = pair.map((r) => r.result.higherScore);
  const interval = wilsonInterval(scores);
  /** @type {Record<string, number>} */
  const terminations = {};
  let plies = 0;
  let ms = 0;
  for (const r of pair) {
    terminations[r.result.termination] = (terminations[r.result.termination] ?? 0) + 1;
    plies += r.result.plies;
    ms += r.result.ms;
    bumpTier(lower.id, r.result.ms, r.result.lowerMoves);
    bumpTier(higher.id, r.result.ms, r.result.higherMoves);
  }
  const termText = Object.entries(terminations)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  const avgPlies = (plies / pair.length).toFixed(1);
  const avgMs = Math.round(ms / pair.length);
  console.log(
    `| ${higher.id} > ${lower.id} | ${interval.mean.toFixed(3)} / ${pair.length} | [${interval.lo.toFixed(3)}, ${interval.hi.toFixed(3)}] | ${termText} | ${avgPlies} | ${avgMs}ms |`
  );
}
console.log('');
console.log('| Tier | Games | Avg seconds per move |');
console.log('| --- | --- | --- |');
for (const tier of spec) {
  const entry = perTier.get(tier.id);
  if (!entry) continue;
  const perMove = entry.moves > 0 ? (entry.ms / entry.moves / 1000).toFixed(2) : 'n/a';
  console.log(`| ${tier.id} | ${entry.games} | ${perMove}s |`);
}
console.log('');
console.log(`Games: ${results.length} in parallel over ${workers} workers; total wall time ${Math.round(wallMs / 1000)}s.`);
