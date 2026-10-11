/**
 * Replay: re-simulate every recorded game from its committed raw record using
 * the independent reference model and the game's frozen spawn history, and
 * verify full agreement — per-step score/max-tile progression and the final
 * board. Replay does NOT re-consult any solver; it validates that the
 * committed record fully determines the game (determinism + completeness).
 */

import {
  simulateMove,
  boardsEqual,
  isGameOver,
  maxTile,
  moveGain,
} from "../../../test/helpers/reference-2048.mjs";
import { SpawnCursor } from "./spawn-history.mjs";

/**
 * Replay one game record.
 * Returns { seed, agrees, firstDivergence, checkedMoves, replayedFinalBoard }.
 */
export function replayGame(record, spawnPairs) {
  const cursor = new SpawnCursor(spawnPairs);
  const board = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const s0 = cursor.nextSpawn(board);
  const s1 = cursor.nextSpawn(board);

  const initialAgrees =
    record.initialSpawns.length === 2 &&
    record.initialSpawns[0].r === s0.r &&
    record.initialSpawns[0].c === s0.c &&
    record.initialSpawns[0].value === s0.value &&
    record.initialSpawns[1].r === s1.r &&
    record.initialSpawns[1].c === s1.c &&
    record.initialSpawns[1].value === s1.value;

  let firstDivergence = initialAgrees ? null : { move: -1, kind: "initial-spawns" };
  let checkedMoves = 0;
  let cumulativeScore = 0;

  for (const move of record.moves) {
    const moved = simulateMove(board, move.dirApplied);
    // Independent scoring expectation: the merge points the reference model
    // says this move earns; the following spawn earns nothing.
    const gain = moveGain(board, move.dirApplied);
    cumulativeScore += gain;
    const spawn = cursor.nextSpawn(moved);
    board.length = 0;
    board.push(...moved);

    const scoreAfter = cumulativeScore;
    const tileAfter = maxTile(board);
    checkedMoves += 1;

    const agrees =
      gain === move.mergedGain &&
      scoreAfter === move.scoreAfter &&
      tileAfter === move.maxTileAfter &&
      JSON.stringify(spawn ? { r: spawn.r, c: spawn.c, value: spawn.value } : null) ===
        JSON.stringify(move.spawn);
    if (!agrees && !firstDivergence) {
      firstDivergence = { move: move.n, kind: "progression", scoreAfter, tileAfter, mergedGain: gain };
    }
  }

  const finalAgrees = boardsEqual(board, record.finalBoard) && cumulativeScore === record.finalScore;
  if (!finalAgrees && !firstDivergence) {
    firstDivergence = { move: record.moveCount, kind: "final-board" };
  }

  return {
    seed: record.seed,
    arm: record.arm,
    agrees: initialAgrees && finalAgrees && !firstDivergence,
    firstDivergence,
    checkedMoves,
    replayedFinalBoard: board.map((row) => [...row]),
  };
}

/** Over an entire results run: replay every game of every arm. */
export function replayRun(records, spawnHistory) {
  const perGame = [];
  for (const record of records) {
    const pairs = spawnHistory.games[String(record.seed)];
    if (!pairs) {
      perGame.push({ arm: record.arm, seed: record.seed, agrees: false, error: "no frozen history for seed" });
      continue;
    }
    perGame.push(replayGame(record, pairs));
  }
  const agreed = perGame.filter((r) => r.agrees).length;
  return {
    totalGames: perGame.length,
    agreed,
    finalBoardAgreement: perGame.length === 0 ? null : agreed / perGame.length,
    disagreements: perGame.filter((r) => !r.agrees),
    perGame,
  };
}

/** Purity check helper for tests: does a game record end because the game is over? */
export function recordEndsGameOver(record) {
  return record.gameOver && isGameOver(record.finalBoard);
}
