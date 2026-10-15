/**
 * Baseline agents for the Gauntlet 2048 game: greedy and an expectimax
 * engine. Both are baseline-track Agents (`act(ctx) -> { text }`); neither
 * uses randomness, clocks, or `node:*` imports, so their play is a pure
 * function of the observation.
 *
 * @module
 */

import { slide } from './rules.js';

/** @import { Agent, TurnContext } from '../../core/types.js' */
/** @import { Board, Direction } from './rules.js' */

/**
 * Greedy's tie order: when several moves gain the same score, the earliest
 * direction in this list wins. Fixed, so greedy play is deterministic.
 * @type {Direction[]}
 */
const TIE_ORDER = ['up', 'right', 'down', 'left'];

const DIRS = /** @type {Direction[]} */ (['up', 'right', 'down', 'left']);

/**
 * The greedy baseline: play the legal direction with the largest immediate
 * merge gain (the score the move would add); ties break in TIE_ORDER. If no
 * legal move gains anything, the first legal direction in TIE_ORDER plays.
 *
 * @returns {Agent}
 */
export function greedy() {
  return {
    id: '2048-greedy',
    track: 'baseline',
    async act(/** @type {TurnContext} */ ctx) {
      const board = /** @type {{ board: Board }} */ (ctx.observation.data).board;
      let best = /** @type {Direction | null} */ (null);
      let bestGain = -1;
      for (const dir of TIE_ORDER) {
        const result = slide(board, dir);
        if (!result.moved) continue;
        if (result.gained > bestGain) {
          bestGain = result.gained;
          best = dir;
        }
      }
      return { text: best === null ? '' : best };
    },
  };
}

// ---------------------------------------------------------------------------
// Expectimax engine over a 16-bit row encoding (4 tiles x 4-bit log2
// exponents, the classic 2048 AI layout). Slide results and a per-row
// heuristic (empty cells, merge potential, monotonicity, log-sum) are
// precomputed for all 65536 rows and reused through lookups; column moves go
// through a transpose. Boards with tiles above 2^15 or non-power-of-two
// values fall back to a slow path built on rules.slide.
// ---------------------------------------------------------------------------

const LOST_PENALTY = 200000;
const MONOTONICITY_WEIGHT = 47;
const MONOTONICITY_POWER = 4;
const SUM_WEIGHT = 11;
const SUM_POWER = 3.5;
const MERGES_WEIGHT = 700;
const EMPTY_WEIGHT = 270;

/** @type {{ resLeft: Uint16Array, movedLeft: Uint8Array, resRight: Uint16Array, movedRight: Uint8Array, heur: Float64Array } | null} */
let tables = null;

/**
 * @param {number[]} ranks Four 4-bit exponents, left to right.
 * @returns {number} The row heuristic for this rank sequence.
 */
function rowHeuristic(ranks) {
  let empty = 0;
  let sum = 0;
  let merges = 0;
  for (let i = 0; i < 4; i++) {
    const rank = ranks[i];
    if (rank === 0) {
      empty++;
    } else {
      sum += Math.pow(rank, SUM_POWER);
      if (i > 0 && ranks[i - 1] === rank) merges++;
    }
  }
  let monoLeft = 0;
  let monoRight = 0;
  for (let i = 0; i < 3; i++) {
    const a = ranks[i];
    const b = ranks[i + 1];
    if (a > b) {
      monoLeft += Math.pow(a, MONOTONICITY_POWER) - Math.pow(b, MONOTONICITY_POWER);
    } else {
      monoRight += Math.pow(b, MONOTONICITY_POWER) - Math.pow(a, MONOTONICITY_POWER);
    }
  }
  return (
    EMPTY_WEIGHT * empty +
    MERGES_WEIGHT * merges -
    MONOTONICITY_WEIGHT * Math.min(monoLeft, monoRight) -
    SUM_WEIGHT * sum
  );
}

/**
 * Slide one 4-bit row toward the low nibble (left). Returns the new packed
 * row.
 *
 * @param {number[]} ranks
 * @returns {number}
 */
function packSlideLeft(ranks) {
  const values = [];
  for (const rank of ranks) {
    if (rank !== 0) values.push(rank);
  }
  const out = [0, 0, 0, 0];
  let o = 0;
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < values.length && values[i] === values[i + 1] && values[i] < 15) {
      out[o++] = values[i] + 1;
      i++;
    } else {
      out[o++] = values[i];
    }
  }
  return out[0] | (out[1] << 4) | (out[2] << 8) | (out[3] << 12);
}

/**
 * Build (once) the slide and heuristic lookup tables.
 *
 * @returns {{ resLeft: Uint16Array, movedLeft: Uint8Array, resRight: Uint16Array, movedRight: Uint8Array, heur: Float64Array }}
 */
function buildTables() {
  const n = 65536;
  const resLeft = new Uint16Array(n);
  const movedLeft = new Uint8Array(n);
  const resRight = new Uint16Array(n);
  const movedRight = new Uint8Array(n);
  const heur = new Float64Array(n);
  for (let row = 0; row < n; row++) {
    const ranks = [row & 15, (row >> 4) & 15, (row >> 8) & 15, (row >> 12) & 15];
    heur[row] = rowHeuristic(ranks);
    const left = packSlideLeft(ranks);
    resLeft[row] = left;
    movedLeft[row] = left !== row ? 1 : 0;
    const right = packSlideLeft(ranks.slice().reverse());
    const rightRanks = [
      right & 15,
      (right >> 4) & 15,
      (right >> 8) & 15,
      (right >> 12) & 15,
    ].reverse();
    const packed = rightRanks[0] | (rightRanks[1] << 4) | (rightRanks[2] << 8) | (rightRanks[3] << 12);
    resRight[row] = packed;
    movedRight[row] = packed !== row ? 1 : 0;
  }
  return { resLeft, movedLeft, resRight, movedRight, heur };
}

/**
 * @returns {NonNullable<typeof tables>}
 */
function getTables() {
  if (tables === null) tables = buildTables();
  return tables;
}

/**
 * Encode a board as four packed rows. Returns null when the board does not
 * fit the encoding (non-power-of-two tiles or any tile above 2^15).
 *
 * @param {Board} board
 * @returns {number[] | null}
 */
function encodeBoard(board) {
  /** @type {number[]} */
  const rows = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const v = board[r][c];
      if (v === 0) continue;
      const exp = Math.round(Math.log2(v));
      if (exp < 1 || exp > 15 || 2 ** exp !== v) return null;
      rows[r] |= exp << (4 * c);
    }
  }
  return rows;
}

/**
 * Transpose packed rows.
 *
 * @param {number[]} rows
 * @returns {number[]}
 */
function transpose(rows) {
  /** @type {number[]} */
  const out = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) {
    const v = rows[r];
    out[0] |= (v & 15) << (4 * r);
    out[1] |= ((v >> 4) & 15) << (4 * r);
    out[2] |= ((v >> 8) & 15) << (4 * r);
    out[3] |= ((v >> 12) & 15) << (4 * r);
  }
  return out;
}

/**
 * Heuristic of a packed board: row terms plus column terms (via transpose).
 *
 * @param {number[]} rows
 * @returns {number}
 */
function heuristic(rows) {
  const t = transpose(rows);
  const h = getTables().heur;
  return (
    h[rows[0]] + h[rows[1]] + h[rows[2]] + h[rows[3]] +
    h[t[0]] + h[t[1]] + h[t[2]] + h[t[3]]
  );
}

/**
 * Apply a slide to packed rows; returns null when nothing moves.
 *
 * @param {number[]} rows
 * @param {Direction} dir
 * @returns {number[] | null}
 */
function moveRows(rows, dir) {
  const { resLeft, movedLeft, resRight, movedRight } = getTables();
  /** @type {number[]} */
  let moved;
  if (dir === 'left') {
    moved = [
      resLeft[rows[0]],
      resLeft[rows[1]],
      resLeft[rows[2]],
      resLeft[rows[3]],
    ];
    if (
      !movedLeft[rows[0]] && !movedLeft[rows[1]] &&
      !movedLeft[rows[2]] && !movedLeft[rows[3]]
    ) return null;
    return moved;
  }
  if (dir === 'right') {
    moved = [
      resRight[rows[0]],
      resRight[rows[1]],
      resRight[rows[2]],
      resRight[rows[3]],
    ];
    if (
      !movedRight[rows[0]] && !movedRight[rows[1]] &&
      !movedRight[rows[2]] && !movedRight[rows[3]]
    ) return null;
    return moved;
  }
  const t = transpose(rows);
  const table = dir === 'up' ? resLeft : resRight;
  const movedTable = dir === 'up' ? movedLeft : movedRight;
  moved = [table[t[0]], table[t[1]], table[t[2]], table[t[3]]];
  if (
    !movedTable[t[0]] && !movedTable[t[1]] &&
    !movedTable[t[2]] && !movedTable[t[3]]
  ) return null;
  return transpose(moved);
}

/**
 * Chance node: an expected value over the spawn in every empty cell
 * (0.9 for a 2, 0.1 for a 4). `depth` is the number of player move plies
 * still to come after this spawn.
 *
 * @param {number[]} rows Post-move board, spawn pending.
 * @param {number} depth
 * @returns {number}
 */
function chanceNode(rows, depth) {
  let total = 0;
  let count = 0;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (((rows[r] >> (4 * c)) & 15) !== 0) continue;
      const withTwo = rows.slice();
      withTwo[r] |= 1 << (4 * c);
      const withFour = rows.slice();
      withFour[r] |= 2 << (4 * c);
      total += 0.9 * maxNode(withTwo, depth - 1) + 0.1 * maxNode(withFour, depth - 1);
      count++;
    }
  }
  if (count === 0) return maxNode(rows, depth - 1);
  return total / count;
}

/**
 * Player node: the best expected value over legal slides.
 *
 * @param {number[]} rows
 * @param {number} depth Player move plies remaining (0 = evaluate).
 * @returns {number}
 */
function maxNode(rows, depth) {
  if (depth <= 0) return heuristic(rows);
  let best = -Infinity;
  for (const dir of DIRS) {
    const moved = moveRows(rows, dir);
    if (moved === null) continue;
    const value = chanceNode(moved, depth);
    if (value > best) best = value;
  }
  if (best === -Infinity) return heuristic(rows) - LOST_PENALTY;
  return best;
}

/**
 * Slow-path heuristic for boards that do not fit the packed encoding:
 * the same formula computed directly on tile values.
 *
 * @param {Board} board
 * @returns {number}
 */
function heuristicSlow(board) {
  /** @type {(line: number[]) => number} */
  const lineHeuristic = (line) => {
    const ranks = line.map((v) => (v === 0 ? 0 : Math.round(Math.log2(v))));
    return rowHeuristic(ranks);
  };
  let total = 0;
  for (let i = 0; i < 4; i++) {
    total += lineHeuristic(board[i]);
    total += lineHeuristic(board.map((row) => row[i]));
  }
  return total;
}

/**
 * The expectimax engine baseline. Depth 2 (two move plies with spawn chance
 * nodes between) is the default: depth 3 is available via `{ depth: 3 }` and
 * plays somewhat stronger at several times the cost per move.
 *
 * Heuristic: empty cells, merge potential, row/column monotonicity, and a
 * log-scale sum penalty — the standard weights for this search shape.
 *
 * @param {{ depth?: number }} [options]
 * @returns {Agent}
 */
export function engine({ depth = 2 } = {}) {
  const plies = depth;
  return {
    id: `2048-engine-d${plies}`,
    track: 'baseline',
    async act(/** @type {TurnContext} */ ctx) {
      const board = /** @type {{ board: Board }} */ (ctx.observation.data).board;
      const encoded = encodeBoard(board);
      if (encoded === null) {
        // Slow fallback: 1-ply max of the direct heuristic over rules.slide.
        let best = /** @type {Direction | null} */ (null);
        let bestValue = -Infinity;
        for (const dir of DIRS) {
          const result = slide(board, dir);
          if (!result.moved) continue;
          const value = heuristicSlow(result.board);
          if (value > bestValue) {
            bestValue = value;
            best = dir;
          }
        }
        return { text: best === null ? '' : best };
      }
      let best = /** @type {Direction | null} */ (null);
      let bestValue = -Infinity;
      for (const dir of DIRS) {
        const moved = moveRows(encoded, dir);
        if (moved === null) continue;
        const value = chanceNode(moved, plies);
        if (value > bestValue) {
          bestValue = value;
          best = dir;
        }
      }
      return { text: best === null ? '' : best };
    },
  };
}
