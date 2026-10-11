/**
 * Frozen spawn histories for the solver-budgets study.
 *
 * A spawn history is a pre-generated, committed sequence of random draws —
 * two 32-bit integers per spawn: [uCell, uValue]. Games consume the stream in
 * order, so every arm plays the exact same spawn sequence for a given game
 * regardless of how it plays. The draws are frozen in spawn-history.json at
 * manifest-generation time, BEFORE any arm is evaluated (no tuning on
 * evaluated histories is possible by construction).
 *
 * Consumption rule (deterministic, arm-independent):
 *   - Take the next pair [uCell, uValue].
 *   - Compute the list of empty cells of the CURRENT board (row-major order).
 *   - Position = empties[floor(uCell / 2^32 * empties.length)].
 *   - Value = (uValue / 2^32) < 0.9 ? 2 : 4  (standard 2048 spawn odds).
 *   - If the chosen cell is occupied (possible when the board is nearly
 *     full), SKIP that pair and consume the next one; repeat until a pair
 *     lands on an empty cell or the stream is exhausted (game ends,
 *     recorded as spawnExhausted).
 */

import { mulberry32 } from "../../../test/helpers/reference-2048.mjs";

export const TWO_POW_32 = 4294967296;

/**
 * Generate the frozen draw stream for one game.
 * Two draws per spawn entry; `spawnCount` = 2 initial spawns + maxMoves.
 */
export function generateGameDraws(seed, spawnCount) {
  const rng = mulberry32(seed);
  const pairs = [];
  for (let i = 0; i < spawnCount; i += 1) {
    const uCell = Math.floor(rng() * TWO_POW_32);
    const uValue = Math.floor(rng() * TWO_POW_32);
    pairs.push([uCell, uValue]);
  }
  return pairs;
}

/** Full spawn-history document for the manifest's companion file. */
export function generateSpawnHistory(seeds, maxMovesPerGame) {
  const games = {};
  for (const seed of seeds) {
    games[String(seed)] = generateGameDraws(seed, 2 + maxMovesPerGame);
  }
  return {
    version: 1,
    rule: "two 32-bit draws per spawn [uCell, uValue]; uCell picks the row-major empty cell of the current board, uValue picks 2 (p=0.9) or 4; occupied cells skip to the next pair; exhaustion ends the game",
    generator: "mulberry32(seed) from test/helpers/reference-2048.mjs, frozen before any arm was evaluated",
    games,
  };
}

/**
 * Deterministic spawn cursor over a frozen draw stream.
 */
export class SpawnCursor {
  constructor(pairs) {
    this.pairs = pairs;
    this.index = 0;
  }

  /**
   * Place the next spawn on `board` (mutated). Returns the spawn
   * { r, c, value, pairsConsumed } or null when the stream is exhausted.
   */
  nextSpawn(board) {
    const empties = [];
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        if (board[r][c] === 0) empties.push([r, c]);
      }
    }
    if (empties.length === 0) return null;

    while (this.index < this.pairs.length) {
      const [uCell, uValue] = this.pairs[this.index];
      this.index += 1;
      const pos = empties[Math.floor((uCell / TWO_POW_32) * empties.length)];
      if (board[pos[0]][pos[1]] !== 0) continue; // occupied: skip pair
      const value = uValue / TWO_POW_32 < 0.9 ? 2 : 4;
      board[pos[0]][pos[1]] = value;
      return { r: pos[0], c: pos[1], value, pairsConsumed: 1 };
    }
    return null; // spawn history exhausted
  }
}
