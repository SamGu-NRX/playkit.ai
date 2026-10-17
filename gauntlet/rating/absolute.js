#!/usr/bin/env node
/**
 * Absolute calibration: map Stockfish's documented UCI_Elo strength levels
 * onto the gauntlet's anchored rung scale.
 *
 * How it works:
 *  1. Load the ladder results JSON (default `ladder-results.json` next to
 *     this script, override with --ladder-results=PATH) and replay its
 *     per-game scores as the fit input — this reuses the exact games that
 *     produced the published ladder ratings rather than refitting from
 *     aggregates.
 *  2. Play calibration games: Stockfish agents configured with
 *     UCI_LimitStrength at a fixed UCI_Elo level (default levels
 *     1320/1500/1700/1900/2100/2300, --levels to override) face two known
 *     rungs — `chess-wood` (built-in tier) and `chess-stockfish-sf-1k` —
 *     with balanced colours, on the same seeded episode runner.
 *  3. Refit everything in one anchored MLE (anchor chess-paper=1000) and
 *     report each UCI_Elo level's rating on the gauntlet scale with
 *     bootstrap intervals.
 *
 * Interpretation caveat (printed with the results and worth repeating):
 * Stockfish documents UCI_Elo against CCRL blitz ratings at time control
 * 120+1s (Stockfish PR #4341). These calibration games use a fixed 1000-node
 * search budget per move — vastly faster than the documented control — so
 * the fitted mapping places the *labelled* strengths on our scale and is
 * indicative only; it is not a CCRL-equivalent rating.
 *
 * Flags:
 *   --games-per-colour=N   default 8 (episodes per colour per level-pair)
 *   --levels=a,b,c         comma-separated UCI_Elo levels
 *   --replicates=N         bootstrap replicates, default 2000
 *   --ladder-results=PATH  ladder results JSON to refit from
 *   --out=PATH             results JSON path
 *   --merge-from=PATH      reuse a prior results file's played calibration
 *                          games exactly as recorded and refit against the
 *                          CURRENT ladder results — no engine games are
 *                          replayed. Carried games keep their recorded
 *                          scores: verify they postdate any scoring change
 *                          the new ladder reflects before trusting the fit.
 *
 * The played calibration games are written to the output path BEFORE the
 * fit runs, so a failing fit never costs the episodes — refit from that
 * file with --merge-from.
 *
 * Node-only. Deterministic for a given engine binary.
 *
 * @module
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chess } from '../games/chess/index.js';
import { chessStockfish } from '../games/chess-stockfish/index.js';
import { createEngineBaselineAgent } from '../games/chess/baselines.js';
import { createStockfishOpponentAgent } from '../games/chess-stockfish/stockfish-agent.js';
import { runEpisode } from '../core/runner.js';
import { fitRatings, bootstrapRatings } from './elo.js';
import { findEngineBinary, probeEngineIdSync } from '../engines/uci/client.js';

const ANCHOR_RUNG = 'chess-paper';
const ANCHOR_RATING = 1000;

/** The opponents calibration levels play against: known ladder rungs. */
const OPPONENTS = [
  { rung: 'chess-wood', gameId: 'chess', tierId: 'wood' },
  { rung: 'chess-stockfish-sf-1k', gameId: 'chess-stockfish', tierId: 'sf-1k' },
];

const GAMES = /** @type {Record<string, any>} */ ({
  chess,
  'chess-stockfish': chessStockfish,
});

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
 * Agent for a known built-in/Stockfish rung, as in the ladder run.
 * @param {string} rungId
 * @param {{ seed: string, seat: number }} seatInfo
 * @returns {import('../core/types.js').Agent}
 */
function createAgentForRung(rungId, { seed, seat }) {
  if (rungId.startsWith('sf-elo-')) {
    // Calibration level: a synthetic tier carrying the UCI_Elo param.
    const elo = Number(rungId.slice('sf-elo-'.length));
    return /** @type {*} */ (
      createStockfishOpponentAgent({
        tier: {
          id: rungId,
          rank: 0,
          scoring: /** @type {'outcome'} */ ('outcome'),
          maxActions: 150,
          publicSeeds: 0,
          params: { nodes: 1000, searchTimeoutMs: 10_000, elo },
        },
        seed,
        seat,
        id: `rating-${rungId}/${seed}`,
      })
    );
  }
  const gameId = rungId === 'chess-wood' ? 'chess' : 'chess-stockfish';
  const tierId = rungId === 'chess-wood' ? 'wood' : rungId.slice('chess-stockfish-'.length);
  const game = GAMES[gameId];
  const tier = game.spec.tiers.find((/** @type {any} */ t) => t.id === tierId);
  if (!tier) throw new Error(`absolute: rung ${rungId} tier ${tierId} not found`);
  if (gameId === 'chess') {
    return /** @type {*} */ (
      createEngineBaselineAgent({ tier, seed, seat, id: `rating-${rungId}/${seed}` })
    );
  }
  return /** @type {*} */ (
    createStockfishOpponentAgent({ tier, seed, seat, id: `rating-${rungId}/${seed}` })
  );
}

/**
 * Extract the per-game fit input from the ladder results JSON.
 * @param {any} ladder
 * @returns {Array<{ a: string, b: string, score: number }>}
 */
function ladderFitGames(ladder) {
  /** @type {Array<{ a: string, b: string, score: number }>} */
  const games = [];
  for (const pair of Object.values(ladder.pairs ?? {})) {
    const p = /** @type {any} */ (pair);
    for (const g of p.games ?? []) {
      games.push({ a: p.agentRung, b: p.opponentRung, score: g.agentScore });
    }
  }
  return games;
}

/**
 * Git provenance (best effort).
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

/**
 * Run one level-pair's games: balanced colours, seeded.
 * @param {string} levelRung e.g. `sf-elo-1500`
 * @param {{ rung: string, gameId: string, tierId: string }} opponent
 * @param {number} gamesPerColour
 * @returns {Promise<{ agentRung: string, opponentRung: string, games: Array<{ seed: string, seat: number, agentScore: number, reason: string, agentActions: number }>, rawScore: { score: number, n: number } }>}
 */
async function runLevelPair(levelRung, opponent, gamesPerColour) {
  const game = GAMES[opponent.gameId];
  const tier = game.spec.tiers.find((/** @type {any} */ t) => t.id === opponent.tierId);
  if (!tier) throw new Error(`absolute: tier ${opponent.tierId} not found`);
  /** @type {Record<number, number>} */
  const seats = { 0: 0, 1: 0 };
  /** @type {Array<{ seed: string, seat: number, agentScore: number, reason: string, agentActions: number }>} */
  const games = [];
  const pairId = `${levelRung}-vs-${opponent.rung}`;
  for (let k = 0; k < 20 * gamesPerColour; k++) {
    if (seats[0] >= gamesPerColour && seats[1] >= gamesPerColour) break;
    const seed = `rating/${pairId}/${k}`;
    const seat = game.agentSeat(tier.id, seed);
    if (seats[seat] >= gamesPerColour) continue;
    seats[seat] += 1;
    const agent = createAgentForRung(levelRung, { seed, seat });
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
      throw new Error(`absolute: ${pairId} game ${seed} finished without an outcome`);
    }
    const agentScore = normalized[trajectory.agent.seat];
    games.push({
      seed,
      seat: trajectory.agent.seat,
      agentScore,
      reason: trajectory.end.reason,
      agentActions: trajectory.end.agentActions,
    });
    process.stdout.write(
      `  ${pairId} [${games.length}] seed=${seed} seat=${trajectory.agent.seat} ` +
        `score=${agentScore} (${trajectory.end.reason})\n`
    );
  }
  const score = games.reduce((acc, g) => acc + g.agentScore, 0);
  return {
    agentRung: levelRung,
    opponentRung: opponent.rung,
    games,
    rawScore: { score, n: games.length },
  };
}

async function main() {
  const flags = parseFlags();
  const gamesPerColour = Number(flags['games-per-colour'] ?? 8);
  const replicates = Number(flags.replicates ?? 2000);
  const levels = (flags.levels ?? '1320,1500,1700,1900,2100,2300')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
  const ladderPath =
    flags['ladder-results'] ??
    new URL('./ladder-results.json', import.meta.url).pathname;
  const outPath =
    flags.out ?? new URL('./absolute-results.json', import.meta.url).pathname;
  const mergeFrom = flags['merge-from'];

  const ladder = JSON.parse(readFileSync(ladderPath, 'utf8'));
  const ladderGames = ladderFitGames(ladder);
  if (ladderGames.length === 0) {
    throw new Error(
      `absolute: no games found in ${ladderPath} — run rating/ladder.js first`
    );
  }

  /** @type {Record<string, ReturnType<typeof runLevelPair> extends Promise<infer T> ? T : never>} */
  let levelResults = {};
  /** @type {{ binaryPath: string | null, id: string | null, carriedFrom?: string }} */
  let stockfish;
  if (mergeFrom) {
    // Refit mode: the calibration episodes already cost their engine time;
    // reuse them as recorded and redo only the fit against the current
    // ladder input.
    const prior = JSON.parse(readFileSync(mergeFrom, 'utf8'));
    if (!prior.levels || typeof prior.levels !== 'object') {
      throw new Error(`absolute: ${mergeFrom} has no saved level games to reuse`);
    }
    levelResults = prior.levels;
    stockfish = {
      binaryPath: null,
      id: prior.meta?.stockfish?.id ?? 'unknown (carried games)',
      carriedFrom: mergeFrom,
    };
    const priorLevels = /** @type {any} */ (prior.meta?.levels ?? []).join(', ');
    process.stdout.write(
      `--merge-from: reusing ${Object.keys(levelResults).length} saved level pairs ` +
        `(levels ${priorLevels || 'unknown'}) from ${mergeFrom}; no engine games replayed\n`
    );
  } else {
    const binaryPath = findEngineBinary();
    const engineId = probeEngineIdSync(binaryPath);
    stockfish = { binaryPath, id: engineId };
    for (const elo of levels) {
      for (const opponent of OPPONENTS) {
        const levelRung = `sf-elo-${elo}`;
        process.stdout.write(`pair ${levelRung} vs ${opponent.rung}\n`);
        const key = `${levelRung}-vs-${opponent.rung}`;
        levelResults[key] = await runLevelPair(levelRung, opponent, gamesPerColour);
      }
    }
  }

  const calibrationGames = Object.values(levelResults).flatMap((r) =>
    r.games.map((g) => ({ a: r.agentRung, b: r.opponentRung, score: g.agentScore }))
  );
  const fitGames = [...ladderGames, ...calibrationGames];

  const meta = {
    run: 'gauntlet/rating/absolute.js',
    ladderResults: ladderPath,
    ladderMeta: ladder.meta ?? null,
    gamesPerColour,
    levels,
    calibrationNodeBudget: 1000,
    bootstrapReplicates: replicates,
    anchor: { rung: ANCHOR_RUNG, rating: ANCHOR_RATING },
    stockfish,
    git: gitProvenance(),
    finishedAt: new Date().toISOString(),
  };

  if (!mergeFrom) {
    // Raw games hit disk BEFORE the fit: a divergent or throwing fit must
    // not cost the played episodes. This pre-fit file is exactly what
    // --merge-from consumes to refit without replaying anything.
    writeFileSync(
      outPath,
      `${JSON.stringify({ meta, levels: levelResults }, null, 2)}\n`
    );
    process.stdout.write(
      `pre-fit games written to ${outPath} — if the fit fails, refit with --merge-from=${outPath}\n`
    );
  }

  process.stdout.write(
    `\nfitting ${fitGames.length} games (${ladderGames.length} ladder + ${calibrationGames.length} calibration) anchored at ${ANCHOR_RUNG}=${ANCHOR_RATING}\n`
  );
  const fit = fitRatings(fitGames, { anchorPlayer: ANCHOR_RUNG, anchorRating: ANCHOR_RATING });
  const boot = bootstrapRatings(fitGames, {
    anchorPlayer: ANCHOR_RUNG,
    anchorRating: ANCHOR_RATING,
    replicates,
    seed: 'gauntlet/rating/absolute/bootstrap',
  });

  process.stdout.write('\nuci-elo   gauntlet rating   95% interval\n');
  for (const elo of levels) {
    const rung = `sf-elo-${elo}`;
    const rating = fit.ratings[rung];
    const interval = boot.intervals[rung];
    process.stdout.write(
      `${String(elo).padStart(7)}   ${rating.toFixed(1).padStart(6)}   ` +
        `[${interval.low.toFixed(1)}, ${interval.high.toFixed(1)}]\n`
    );
  }
  process.stdout.write(
    `\ncaveat: UCI_Elo is documented against CCRL blitz at TC 120+1s (Stockfish PR #4341);\n` +
      `these games use a fixed 1000-node budget per move, so the mapping is indicative only.\n`
  );

  const results = {
    meta,
    levels: levelResults,
    fit: {
      ratings: fit.ratings,
      iterations: fit.iterations,
      gradientInfNorm: fit.gradientInfNorm,
      intervals: boot.intervals,
      replicates: boot.replicates,
      divergentReplicates: boot.divergentReplicates,
    },
  };
  writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`results written to ${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
