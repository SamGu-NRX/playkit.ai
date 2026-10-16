#!/usr/bin/env node
/**
 * Ladder rating run: plays every adjacent ladder pair (plus one skip pair)
 * with both colours and fits maximum-likelihood Elo ratings with bootstrap
 * intervals.
 *
 * Rungs (weakest to strongest):
 *   chess-sand                            (random-legal-opponent tier, chess game)
 *   chess-paper, chess-wood               (built-in engine ladder, chess game)
 *   sf-250, sf-1k, sf-10k, sf-100k        (Stockfish node-budget tiers)
 *
 * The sf-250 rung is the bridge: probes put it just above wood (4/6 vs
 * wood) while still dropping points to sf-1k (1/16), so every adjacent
 * pair has nonzero cross scores and the anchored fit is identified.
 *
 * Pairs played: sand-vs-paper, paper-wood, wood-sf-250, sf-250-sf-1k,
 * sf-1k-sf-10k, sf-10k-sf-100k, and the skip pair paper-sf-1k (two rungs
 * apart, cheap). Each rung's rating is
 * identified only by these pair results; the anchor is `chess-paper`
 * declared at 1000. Games are seeded (`rating/<pairId>/<k>`), seats chosen
 * by the game's own `agentSeat` function and balanced to
 * `--games-per-colour` per colour per pair, so the whole run is
 * reproducible byte for byte.
 *
 * Output: a summary table on stdout and the full results JSON (games,
 * scores, fit, bootstrap intervals, provenance) to
 * `gauntlet/rating/ladder-results.json` (override with --out).
 *
 * Flags:
 *   --games-per-colour=N   default 20 (episodes per colour per pair)
 *   --pairs=csv            run only these pair ids (default all)
 *   --merge-from=PATH      load a prior results JSON and carry its pair
 *                          results (all pairs not being re-run) into the
 *                          fit and output, so a new rung can be added
 *                          without replaying the old pairs
 *   --builtin-only         run only the built-in pair (paper vs wood); the
 *                          fit then covers just those two rungs
 *   --replicates=N         bootstrap replicates, default 2000
 *   --out=PATH             results JSON path
 *
 * Node-only (Stockfish episodes). Deterministic for a given engine binary.
 *
 * @module
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chess } from '../games/chess/index.js';
import { chessStockfish } from '../games/chess-stockfish/index.js';
import { createEngineBaselineAgent, createRandomBaselineAgent } from '../games/chess/baselines.js';
import { createStockfishOpponentAgent } from '../games/chess-stockfish/stockfish-agent.js';
import { runEpisode } from '../core/runner.js';
import { fitRatings, bootstrapRatings } from './elo.js';
import { findEngineBinary, probeEngineIdSync } from '../engines/uci/client.js';

const ANCHOR_RUNG = 'chess-paper';
const ANCHOR_RATING = 1000;

/** @type {Record<string, any>} */
const GAMES = {
  chess,
  'chess-stockfish': chessStockfish,
};

/** @type {Record<string, { gameId: string, tierId: string }>} */
const RUNGS = {
  'chess-sand': { gameId: 'chess', tierId: 'sand' },
  'chess-paper': { gameId: 'chess', tierId: 'paper' },
  'chess-wood': { gameId: 'chess', tierId: 'wood' },
  'chess-stockfish-sf-250': { gameId: 'chess-stockfish', tierId: 'sf-250' },
  'chess-stockfish-sf-1k': { gameId: 'chess-stockfish', tierId: 'sf-1k' },
  'chess-stockfish-sf-10k': { gameId: 'chess-stockfish', tierId: 'sf-10k' },
  'chess-stockfish-sf-100k': { gameId: 'chess-stockfish', tierId: 'sf-100k' },
};

/** @type {Array<{ id: string, gameId: string, opponentRung: string, agentRung: string }>} */
const PAIRS = [
  { id: 'sand-vs-paper', gameId: 'chess', opponentRung: 'chess-paper', agentRung: 'chess-sand' },
  { id: 'paper-vs-wood', gameId: 'chess', opponentRung: 'chess-paper', agentRung: 'chess-wood' },
  { id: 'wood-vs-sf-250', gameId: 'chess-stockfish', opponentRung: 'chess-stockfish-sf-250', agentRung: 'chess-wood' },
  { id: 'sf-250-vs-sf-1k', gameId: 'chess-stockfish', opponentRung: 'chess-stockfish-sf-1k', agentRung: 'chess-stockfish-sf-250' },
  { id: 'sf-1k-vs-sf-10k', gameId: 'chess-stockfish', opponentRung: 'chess-stockfish-sf-10k', agentRung: 'chess-stockfish-sf-1k' },
  { id: 'sf-10k-vs-sf-100k', gameId: 'chess-stockfish', opponentRung: 'chess-stockfish-sf-100k', agentRung: 'chess-stockfish-sf-10k' },
  { id: 'skip-paper-vs-sf-1k', gameId: 'chess-stockfish', opponentRung: 'chess-stockfish-sf-1k', agentRung: 'chess-paper' },
];

/**
 * Parse --flag=value flags.
 * @returns {Record<string, string>}
 */
function parseFlags() {
  /** @type {Record<string, string>} */
  const flags = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (match) flags[match[1]] = match[2] ?? 'true';
  }
  return flags;
}

/**
 * Build the agent that plays one rung's side of an episode. Built-in rungs
 * use the chess engine baseline; Stockfish rungs use the Stockfish agent.
 *
 * @param {string} rungId
 * @param {{ seed: string, seat: number }} seatInfo
 * @returns {import('../core/types.js').Agent}
 */
function createAgentForRung(rungId, { seed, seat }) {
  const rung = RUNGS[rungId];
  const game = GAMES[rung.gameId];
  const tier = game.spec.tiers.find((/** @type {any} */ t) => t.id === rung.tierId);
  if (!tier) throw new Error(`ladder: rung ${rungId} tier ${rung.tierId} not found`);
  if (rung.gameId === 'chess') {
    if (rung.tierId === 'sand') {
      return /** @type {*} */ (
        createRandomBaselineAgent({ tier, seed, seat, id: `rating-${rungId}/${seed}` })
      );
    }
    return /** @type {*} */ (
      createEngineBaselineAgent({ tier, seed, seat, id: `rating-${rungId}/${seed}` })
    );
  }
  return /** @type {*} */ (
    createStockfishOpponentAgent({ tier, seed, seat, id: `rating-${rungId}/${seed}` })
  );
}

/**
 * Run one pair's games: balanced colours, seeded, recording each episode's
 * result from the agent rung's perspective.
 *
 * @param {{ id: string, gameId: string, opponentRung: string, agentRung: string }} pair
 * @param {number} gamesPerColour
 * @returns {Promise<{ pairId: string, agentRung: string, opponentRung: string, games: Array<{ seed: string, seat: number, agentScore: number, reason: string, agentActions: number, steps: number }>, rawScore: { score: number, n: number } }>}
 */
async function runPair(pair, gamesPerColour) {
  const game = GAMES[pair.gameId];
  const opponentTierId = RUNGS[pair.opponentRung].tierId;
  const tier = game.spec.tiers.find((/** @type {any} */ t) => t.id === opponentTierId);
  if (!tier) throw new Error(`ladder: pair ${pair.id} tier ${opponentTierId} not found`);
  /** @type {Record<number, number>} */
  const seats = { 0: 0, 1: 0 };
  /** @type {Array<{ seed: string, seat: number, agentScore: number, reason: string, agentActions: number, steps: number }>} */
  const games = [];
  const maxAttempts = 20 * gamesPerColour;
  for (let k = 0; k < maxAttempts; k++) {
    if (seats[0] >= gamesPerColour && seats[1] >= gamesPerColour) break;
    const seed = `rating/${pair.id}/${k}`;
    const seat = game.agentSeat(tier.id, seed);
    if (seats[seat] >= gamesPerColour) continue;
    seats[seat] += 1;
    const agent = createAgentForRung(pair.agentRung, { seed, seat });
    const trajectory = await runEpisode({
      game,
      tierId: tier.id,
      seed,
      agent,
      maxConsecutiveInvalid: 2,
    });
    if (typeof (/** @type {*} */ (agent).dispose) === 'function') {
      await /** @type {*} */ (agent).dispose();
    }
    const normalized = trajectory.end.outcome?.normalized;
    if (!Array.isArray(normalized)) {
      throw new Error(`ladder: ${pair.id} game ${seed} finished without an outcome`);
    }
    const agentScore = normalized[trajectory.agent.seat];
    games.push({
      seed,
      seat: trajectory.agent.seat,
      agentScore,
      reason: trajectory.end.reason,
      agentActions: trajectory.end.agentActions,
      steps: trajectory.steps.length,
    });
    process.stdout.write(
      `  ${pair.id} [${games.length}] seed=${seed} seat=${trajectory.agent.seat} ` +
        `score=${agentScore} (${trajectory.end.reason}, ${trajectory.end.agentActions} agent moves)\n`
    );
  }
  const score = games.reduce((acc, g) => acc + g.agentScore, 0);
  return {
    pairId: pair.id,
    agentRung: pair.agentRung,
    opponentRung: pair.opponentRung,
    games,
    rawScore: { score, n: games.length },
  };
}

/**
 * Git provenance of the working tree (best effort).
 * @returns {{ baseCommit: string | null, branch: string | null }}
 */
function gitProvenance() {
  /** @type {(args: string[]) => string | null} */
  const tryGit = (args) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  return {
    baseCommit: tryGit(['rev-parse', 'HEAD']),
    branch: tryGit(['rev-parse', '--abbrev-ref', 'HEAD']),
  };
}

async function main() {
  const flags = parseFlags();
  const gamesPerColour = Number(flags['games-per-colour'] ?? 20);
  const replicates = Number(flags.replicates ?? 2000);
  const builtinOnly = flags['builtin-only'] === 'true';
  const outPath =
    flags.out ??
    new URL('./ladder-results.json', import.meta.url).pathname;

  let pairs = builtinOnly ? PAIRS.filter((p) => p.id === 'paper-vs-wood') : [...PAIRS];
  if (typeof flags.pairs === 'string') {
    const wanted = flags.pairs.split(',').map((s) => s.trim());
    pairs = pairs.filter((p) => wanted.includes(p.id));
  }
  if (pairs.length === 0) {
    throw new Error(`ladder: no pairs selected (available: ${PAIRS.map((p) => p.id).join(', ')})`);
  }

  /** @type {any} */
  let prior = null;
  let mergeFromPath = null;
  if (typeof flags['merge-from'] === 'string') {
    mergeFromPath = flags['merge-from'];
    prior = JSON.parse(readFileSync(mergeFromPath, 'utf8'));
    if (!prior || typeof prior !== 'object' || !prior.pairs || !prior.fit) {
      throw new Error(`ladder: --merge-from ${mergeFromPath} is not a ladder-results JSON`);
    }
  }

  const binaryPath = findEngineBinary();
  const engineId = builtinOnly ? null : probeEngineIdSync(binaryPath);

  /** @type {Record<string, ReturnType<typeof runPair> extends Promise<infer T> ? T : never>} */
  const pairResults = {};
  // Carry forward every prior pair that this run is not replaying.
  if (prior) {
    for (const [id, result] of Object.entries(prior.pairs)) {
      if (!pairs.some((p) => p.id === id)) {
        pairResults[id] = /** @type {*} */ (result);
      }
    }
  }
  for (const pair of pairs) {
    process.stdout.write(`pair ${pair.id}: ${pair.agentRung} vs ${pair.opponentRung}\n`);
    pairResults[pair.id] = await runPair(pair, gamesPerColour);
  }

  // Assemble the fit input: every game from the agent rung's perspective.
  const fitGames = Object.values(pairResults).flatMap((r) =>
    r.games.map((g) => ({
      a: r.agentRung,
      b: r.opponentRung,
      score: g.agentScore,
    }))
  );

  /** @type {Record<string, number>} */
  const scoresPerRung = {};
  for (const result of Object.values(pairResults)) {
    scoresPerRung[result.agentRung] =
      (scoresPerRung[result.agentRung] ?? 0) + result.rawScore.score;
    scoresPerRung[result.opponentRung] =
      (scoresPerRung[result.opponentRung] ?? 0) +
      (result.rawScore.n - result.rawScore.score);
  }

  // Fit after the raw results are on disk: a divergent fit (possible with
  // tiny one-sided samples) must never cost the games themselves.
  process.stdout.write(`\nfitting ${fitGames.length} games anchored at ${ANCHOR_RUNG}=${ANCHOR_RATING}\n`);
  /** @type {Record<string, number> | null} */
  let ratings = null;
  /** @type {Record<string, { low: number | null, high: number | null }> | null} */
  let intervals = null;
  let fitMeta = null;
  /** @type {{ message: string, code: string | null } | null} */
  let fitError = null;
  try {
    const fit = fitRatings(fitGames, { anchorPlayer: ANCHOR_RUNG, anchorRating: ANCHOR_RATING });
    const boot = bootstrapRatings(fitGames, {
      anchorPlayer: ANCHOR_RUNG,
      anchorRating: ANCHOR_RATING,
      replicates,
      seed: 'gauntlet/rating/ladder/bootstrap',
    });
    ratings = fit.ratings;
    intervals = boot.intervals;
    fitMeta = {
      iterations: fit.iterations,
      gradientInfNorm: fit.gradientInfNorm,
      replicates: boot.replicates,
      divergentReplicates: boot.divergentReplicates,
    };
    const rungIds = Object.keys(RUNGS).filter((r) =>
      fitGames.some((g) => g.a === r || g.b === r)
    );
    process.stdout.write('\nrung                          rating   95% interval        games\n');
    for (const rung of rungIds) {
      const rating = fit.ratings[rung];
      const interval = boot.intervals[rung];
      const nGames = fitGames.filter((g) => g.a === rung || g.b === rung).length;
      process.stdout.write(
        `${rung.padEnd(30)}${rating.toFixed(1).padStart(6)}   ` +
          `[${interval.low.toFixed(1)}, ${interval.high.toFixed(1)}]`.padEnd(20) +
          `${String(nGames).padStart(4)}\n`
      );
    }
    process.stdout.write(
      `\nbootstrap: ${boot.replicates} replicates, ${boot.divergentReplicates} divergent (discarded)\n`
    );
  } catch (err) {
    fitError =
      err instanceof Error
        ? { message: err.message, code: /** @type {*} */ (err).code ?? null }
        : { message: String(err), code: null };
    process.stdout.write(`\nfit failed (${fitError.code ?? ''} ${fitError.message}); raw results are still written\n`);
  }

  const results = {
    meta: {
      run: 'gauntlet/rating/ladder.js',
      builtinOnly,
      gamesPerColour,
      bootstrapReplicates: replicates,
      anchor: { rung: ANCHOR_RUNG, rating: ANCHOR_RATING },
      chessSpec: { id: chess.spec.id, version: chess.spec.version },
      chessStockfishSpec: { id: chessStockfish.spec.id, version: chessStockfish.spec.version },
      stockfish: builtinOnly ? null : { binaryPath, id: engineId },
      mergedFrom: prior
        ? {
            path: mergeFromPath,
            finishedAt: prior.meta?.finishedAt ?? null,
            chessSpecVersion: prior.meta?.chessSpec?.version ?? null,
            carriedPairs: Object.keys(prior.pairs).filter(
              (id) => !pairs.some((p) => p.id === id)
            ),
          }
        : null,
      git: gitProvenance(),
      finishedAt: new Date().toISOString(),
    },
    pairs: pairResults,
    rawScores: scoresPerRung,
    fit: {
      ratings,
      intervals,
      meta: fitMeta,
      error: fitError,
    },
  };
  writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`results written to ${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
