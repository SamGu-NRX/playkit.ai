/**
 * @fileoverview Practice-board engine: strict validation, moves with
 * merge-value scoring, explicit spawns.
 *
 * Pure ES module — no DOM, no imports. Boards are 4x4 arrays of tile VALUES
 * (0 = empty, 2, 4, 8, ... 32768): the same "values" encoding the parent
 * FIX-1 contract (src/solver/board-utils.js, BoardEncodingError) enforces.
 * Direction convention (project-wide): 0 = Up, 1 = Right, 2 = Down, 3 = Left.
 *
 * Move transitions are cross-checked in playground/test/engine.test.mjs
 * against BOTH the parent public reference (test/helpers/reference-2048.mjs)
 * and the solver's own simulators (src/solver/naive-solver.js
 * MOVE_SIMULATORS). Nothing here imports from src/ so the engine stays
 * independently checkable.
 */

export const BOARD_SIZE = 4;
export const MAX_TILE = 1 << 15; // 32768 — the solver's 4-bit nibble cap
export const DIRECTIONS = Object.freeze({ UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 });
export const DIRECTION_NAMES = Object.freeze(["up", "right", "down", "left"]);
export const SPAWN_VALUES = Object.freeze([2, 4]);

export class PracticeBoardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PracticeBoardError";
    this.code = code;
  }
}

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

function describeCell(value) {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return String(value);
  }
  return JSON.stringify(value) ?? String(value);
}

function describeShape(board) {
  if (!Array.isArray(board)) return typeof board;
  return `${board.length}x${board[0] && board[0].length ?? "?"}`;
}

/**
 * Validate a 4x4 value-encoded board and return a defensive copy.
 * Rejects: invalid dimensions (not exactly 4 rows of 4), non-numeric,
 * non-finite, negative, non-integer tiles, non-powers-of-two, tiles above
 * the 2^15 solver cap, and the value 1 (ambiguous: it would encode as
 * exponent 0, which decodes as an EMPTY cell — mirrors the parent FIX-1
 * contract).
 */
export function validateBoard(board) {
  if (!Array.isArray(board) || board.length !== BOARD_SIZE) {
    throw new PracticeBoardError(
      "INVALID_DIMENSIONS",
      `expected a ${BOARD_SIZE}x${BOARD_SIZE} board (4 rows), got ${describeShape(board)}`,
    );
  }
  const copy = [];
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    const row = board[r];
    if (!Array.isArray(row) || row.length !== BOARD_SIZE) {
      throw new PracticeBoardError("INVALID_DIMENSIONS", `row ${r} must be an array of ${BOARD_SIZE} cells`);
    }
    const copyRow = [];
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      const value = row[c];
      if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
        throw new PracticeBoardError(
          "INVALID_VALUE",
          `cell [${r}][${c}]: tile value must be a finite integer, got ${describeCell(value)}`,
        );
      }
      if (value < 0) {
        throw new PracticeBoardError(
          "INVALID_VALUE",
          `cell [${r}][${c}]: negative tile value ${value} — tiles are 0 or a power of two in [2, ${MAX_TILE}]`,
        );
      }
      if (value === 1) {
        throw new PracticeBoardError(
          "AMBIGUOUS_VALUE",
          `cell [${r}][${c}]: value 1 is ambiguous under values encoding — it would encode as exponent 0, which decodes as an EMPTY cell. Tile values start at 2.`,
        );
      }
      if (value !== 0 && (!isPowerOfTwo(value) || value > MAX_TILE)) {
        throw new PracticeBoardError(
          "INVALID_VALUE",
          `cell [${r}][${c}]: tile value ${value} is not a valid tile — expected 0 or a power of two in [2, ${MAX_TILE}]`,
        );
      }
      copyRow.push(value);
    }
    copy.push(copyRow);
  }
  return copy;
}

export function cloneBoard(board) {
  return board.map((row) => row.slice());
}

export function boardsEqual(a, b) {
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      if (a[r][c] !== b[r][c]) return false;
    }
  }
  return true;
}

// Same (line, k) -> [row, col] mapping as the parent reference
// (test/helpers/reference-2048.mjs LINE_POINTS): cell 0 of a line is the
// tile furthest in the direction of travel, so collapsing moves tiles
// toward k = 0. For LEFT that is column 0; for RIGHT column 3; for UP row 0;
// for DOWN row 3.
function linePoint(dir, line, k) {
  switch (dir) {
    case DIRECTIONS.UP: return [k, line];
    case DIRECTIONS.DOWN: return [BOARD_SIZE - 1 - k, line];
    case DIRECTIONS.LEFT: return [line, k];
    case DIRECTIONS.RIGHT: return [line, BOARD_SIZE - 1 - k];
    default:
      throw new PracticeBoardError("UNKNOWN_DIRECTION", `unknown direction: ${dir}`);
  }
}

/**
 * Apply one 2048 move. Scoring counts MERGED TILE VALUES, not tile mass:
 * moving [2,2,4,4] left merges 2+2 -> 4 and 4+4 -> 8 and earns 4 + 8 = 12.
 * A no-op move (board unchanged) earns 0 and reports moved: false — callers
 * must not spawn and must not advance the document for it. Spawning earns 0
 * by construction (applySpawn returns no score; the log only accrues merge
 * gains).
 */
export function applyMove(board, dir) {
  const start = validateBoard(board);
  const next = cloneBoard(start);
  let scoreGain = 0;
  let mergeCount = 0;
  const merges = [];
  for (let line = 0; line < BOARD_SIZE; line += 1) {
    const cells = [];
    for (let k = 0; k < BOARD_SIZE; k += 1) {
      const [r, c] = linePoint(dir, line, k);
      cells.push(next[r][c]);
    }
    const tiles = cells.filter((v) => v !== 0);
    const out = new Array(BOARD_SIZE).fill(0);
    let w = 0;
    for (let i = 0; i < tiles.length; i += 1) {
      if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
        const merged = tiles[i] * 2;
        out[w] = merged;
        scoreGain += merged;
        mergeCount += 1;
        const [r, c] = linePoint(dir, line, w);
        merges.push({ r, c, value: merged });
        w += 1;
        i += 1; // the merged neighbour is consumed
      } else {
        out[w] = tiles[i];
        w += 1;
      }
    }
    for (let k = 0; k < BOARD_SIZE; k += 1) {
      const [r, c] = linePoint(dir, line, k);
      next[r][c] = out[k];
    }
  }
  const moved = !boardsEqual(start, next);
  return {
    board: next,
    moved,
    scoreGain: moved ? scoreGain : 0,
    mergeCount: moved ? mergeCount : 0,
    merges: moved ? merges : [],
  };
}

export function isValidMove(board, dir) {
  if (!Number.isInteger(dir) || dir < 0 || dir > 3) return false;
  return applyMove(board, dir).moved;
}

export function validMoves(board, order = [DIRECTIONS.UP, DIRECTIONS.RIGHT, DIRECTIONS.DOWN, DIRECTIONS.LEFT]) {
  return order.filter((dir) => isValidMove(board, dir));
}

export function isGameOver(board) {
  return validMoves(board).length === 0;
}

export function emptyCells(board) {
  const cells = [];
  for (let r = 0; r < BOARD_SIZE; r += 1) {
    for (let c = 0; c < BOARD_SIZE; c += 1) {
      if (board[r][c] === 0) cells.push({ r, c });
    }
  }
  return cells;
}

/**
 * Explicit, user-selected spawn. Every spawn is recorded in the versioned
 * log for reproducible replay; spawning itself earns 0.
 */
export function applySpawn(board, spawn) {
  const start = validateBoard(board);
  if (!spawn || typeof spawn !== "object" || Array.isArray(spawn)) {
    throw new PracticeBoardError("SPAWN_INVALID", "spawn must be {r, c, value}");
  }
  const { r, c, value } = spawn;
  if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) {
    throw new PracticeBoardError("SPAWN_INVALID", `spawn cell [${r}][${c}] is outside the 4x4 board`);
  }
  if (!SPAWN_VALUES.includes(value)) {
    throw new PracticeBoardError("SPAWN_INVALID", `spawn value must be 2 or 4, got ${describeCell(value)}`);
  }
  if (start[r][c] !== 0) {
    throw new PracticeBoardError("SPAWN_INVALID", `spawn cell [${r}][${c}] is occupied (value ${start[r][c]})`);
  }
  const next = cloneBoard(start);
  next[r][c] = value;
  return { board: next, spawn: { r, c, value } };
}

/**
 * Deterministic default spawn policy used by auto-step: first empty cell in
 * row-major order, value 2. Recorded in the log so replays are exact.
 */
export const DEFAULT_SPAWN_POLICY = "first-empty-row-major-2";

export function defaultSpawn(board) {
  const cells = emptyCells(board);
  if (!cells.length) return null;
  return { r: cells[0].r, c: cells[0].c, value: 2 };
}

export function maxTile(board) {
  let max = 0;
  for (const row of board) {
    for (const value of row) {
      if (value > max) max = value;
    }
  }
  return max;
}
