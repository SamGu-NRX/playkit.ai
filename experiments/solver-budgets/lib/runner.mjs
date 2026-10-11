/**
 * Experiment runner: plays every (arm, game) cell of the manifest against the
 * INDEPENDENT reference move model with the game's frozen spawn history.
 *
 * Guarantees:
 *   - Board state advances ONLY via test/helpers/reference-2048.mjs
 *     (simulateMove / spawn cursor). Solver-internal simulators are never
 *     trusted to advance state.
 *   - Identical frozen spawn streams for every arm on a game (paired by seed).
 *   - Every engine output is validated against the reference model: illegal
 *     (out-of-range) and no-op (board unchanged) entries in the order are
 *     REJECTED and counted; the first board-changing entry is applied.
 *   - Fallbacks: on engine timeout (latency > timeBudgetMsPerMove), engine
 *     error, or an order with no legal entry, the naive fallback arm (or the
 *     canonical Up,Right,Down,Left order if naive itself is unavailable)
 *     supplies the applied move. Raw engine output is still committed.
 *   - Scoring: standard 2048 scoring via the reference model's `moveGain` —
 *     each merge of two tiles a,a -> 2a earns 2a points, accumulated across
 *     the game (`finalScore` = cumulative merged-tile points). Spawning
 *     earns no points. Tile sums are never used as score.
 *   - Raw per-move records: raw order, rejections, applied dir, fallback,
 *     latency, timeout flag, merge gain, cumulative score/max tile after the
 *     move.
 *   - Budget enforcement: a move whose engine call exceeds
 *     timeBudgetMsPerMove falls back AND increments the arm's
 *     over-budget count; an arm with any over-budget move is marked
 *     failed/unavailable by the run summary and is excluded from paired
 *     comparisons by --analyze.
 */

import { performance } from "node:perf_hooks";
import {
  simulateMove,
  boardsEqual,
  isValidMove,
  isGameOver,
  maxTile,
  moveGain,
} from "../../../test/helpers/reference-2048.mjs";
import { SpawnCursor } from "./spawn-history.mjs";

const CANONICAL_ORDER = [0, 1, 2, 3];

/**
 * Classify why a candidate direction from an engine order was rejected.
 * Returns null when the direction is applicable (board-changing).
 */
export function classifyRejection(board, dir) {
  if (!Number.isInteger(dir) || dir < 0 || dir > 3) {
    return "illegal";
  }
  if (!isValidMove(board, dir)) {
    return "no-op";
  }
  return null;
}

/**
 * Play one game for one arm.
 *
 * @param {object} args
 * @param {object} args.binding        arm binding (see engines.mjs)
 * @param {object|null} args.fallbackBinding  naive binding or null
 * @param {number} args.seed           game seed
 * @param {Array}  args.spawnPairs     frozen [uCell, uValue] draws
 * @param {number} args.timeBudgetMs   per-move wall-clock budget
 * @param {number} args.maxMoves       per-game move cap (declared)
 */
export async function playGame({ binding, fallbackBinding, seed, spawnPairs, timeBudgetMs, maxMoves }) {
  const cursor = new SpawnCursor(spawnPairs);
  const board = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];

  // Initial board: two frozen spawns.
  const initialSpawns = [cursor.nextSpawn(board), cursor.nextSpawn(board)];

  const moves = [];
  let truncated = false;
  let spawnExhausted = false;
  let cumulativeScore = 0;
  let overBudgetMoves = 0;
  let peakTile = maxTile(board);

  while (!isGameOver(board)) {
    if (moves.length >= maxMoves) {
      truncated = true;
      break;
    }
    if (cursor.index >= cursor.pairs.length) {
      // No spawn budget left for the next post-move spawn.
      spawnExhausted = true;
      break;
    }

    const n = moves.length;
    let result;
    try {
      result = await binding.getMoveOrder(board);
    } catch (error) {
      result = { order: [], latencyMs: NaN, meta: { error: String(error.message || error) } };
    }

    const timeout = Number.isFinite(result.latencyMs) && result.latencyMs > timeBudgetMs;
    if (timeout) overBudgetMoves += 1;
    const rejections = [];
    let appliedDir = null;

    if (!timeout) {
      for (const dir of result.order) {
        const reason = classifyRejection(board, dir);
        if (reason) {
          rejections.push({ dir, reason });
        } else {
          appliedDir = dir;
          break;
        }
      }
    }

    let fallback = null;
    if (appliedDir === null) {
      // Timeout, error, empty order, or no legal entry in the order.
      const reason = timeout
        ? "time-budget-exceeded"
        : result.meta && result.meta.error
          ? "engine-error"
          : result.order.length === 0
            ? "empty-order"
            : "no-legal-entry";
      let fallbackOrder = null;
      if (fallbackBinding) {
        try {
          const fb = await fallbackBinding.getMoveOrder(board);
          fallbackOrder = fb.order;
        } catch {
          fallbackOrder = null;
        }
      }
      const candidates = fallbackOrder && fallbackOrder.length ? fallbackOrder : CANONICAL_ORDER;
      for (const dir of candidates) {
        const reason2 = classifyRejection(board, dir);
        if (!reason2) {
          appliedDir = dir;
          break;
        }
      }
      if (appliedDir === null) {
        throw new Error(`no legal move available but game not over (seed ${seed}, move ${n})`);
      }
      fallback = { reason, source: fallbackBinding ? "naive" : "canonical-order" };
    }

    // Scoring: cumulative merged-tile points. The move's gain is measured by
    // the reference model BEFORE state advances; the spawn that follows earns
    // nothing (a spawn places a tile, it never merges).
    const gain = moveGain(board, appliedDir);
    const preTile = maxTile(board);
    const moved = simulateMove(board, appliedDir);
    if (boardsEqual(moved, board)) {
      throw new Error(`applied move was a no-op (seed ${seed}, move ${n}) — runner bug`);
    }
    cumulativeScore += gain;
    const spawn = cursor.nextSpawn(moved);
    board.length = 0;
    board.push(...moved);

    const tileAfter = maxTile(board);
    peakTile = Math.max(peakTile, tileAfter, preTile);

    moves.push({
      n,
      rawOrder: result.order,
      rejections,
      dirApplied: appliedDir,
      fallback,
      latencyMs: Number.isFinite(result.latencyMs) ? Math.round(result.latencyMs * 1000) / 1000 : null,
      timeout,
      mergedGain: gain,
      scoreAfter: cumulativeScore,
      maxTileAfter: tileAfter,
      spawn: spawn ? { r: spawn.r, c: spawn.c, value: spawn.value } : null,
      meta: result.meta,
    });
  }

  return {
    seed,
    arm: binding.id ?? binding.kind,
    initialSpawns: initialSpawns.map((s) => ({ r: s.r, c: s.c, value: s.value })),
    moves,
    moveCount: moves.length,
    truncated,
    spawnExhausted,
    gameOver: !truncated && !spawnExhausted,
    finalBoard: board.map((row) => [...row]),
    finalScore: cumulativeScore,
    maxTileReached: peakTile,
    overBudgetMoves,
  };
}

/** Control counts aggregated over a set of game records. */
export function controlCounts(records) {
  const counts = {
    games: records.length,
    moves: 0,
    timeouts: 0,
    fallbacks: 0,
    rejectedIllegal: 0,
    rejectedNoop: 0,
    truncatedGames: 0,
    spawnExhaustedGames: 0,
    gameOverGames: 0,
  };
  for (const record of records) {
    counts.moves += record.moveCount;
    counts.truncatedGames += record.truncated ? 1 : 0;
    counts.spawnExhaustedGames += record.spawnExhausted ? 1 : 0;
    counts.gameOverGames += record.gameOver ? 1 : 0;
    for (const move of record.moves) {
      if (move.timeout) counts.timeouts += 1;
      if (move.fallback) counts.fallbacks += 1;
      for (const rejection of move.rejections) {
        if (rejection.reason === "illegal") counts.rejectedIllegal += 1;
        else counts.rejectedNoop += 1;
      }
    }
  }
  return counts;
}
