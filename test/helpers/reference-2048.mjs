/**
 * Independent 2048 rules — the arbiter for Node tests and the local browser
 * benchmark.
 *
 * Deliberately implemented differently from `src/solver/naive-solver.js`
 * (explicit line extraction + a single collapse pass; no bit rotations, no
 * bitboards). The solver's own move simulators are the system under test;
 * nothing in this file may import from `src/`.
 *
 * Boards are 4x4 arrays of tile VALUES (0 = empty, 2, 4, 8, ...). Encoding to
 * the solver's exponent form happens only inside the system under test.
 *
 * Direction convention (project-wide): 0 = Up, 1 = Right, 2 = Down, 3 = Left.
 */

export const DIRECTIONS = Object.freeze({ UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 });

/**
 * Deterministic 32-bit PRNG (mulberry32). Returns floats in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function nextRandom() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each entry maps (lineIndex, cellIndexWithinLine) to [row, col], oriented so
// cell 0 is the tile furthest in the direction of travel — collapsing always
// moves tiles toward index 0 of the extracted line.
const LINE_POINTS = {
  0: (line, k) => [k, line], // Up: column `line`, top -> bottom
  2: (line, k) => [3 - k, line], // Down: column `line`, bottom -> top
  3: (line, k) => [line, k], // Left: row `line`, left -> right
  1: (line, k) => [line, 3 - k], // Right: row `line`, right -> left
};

export function extractLine(board, dir, line) {
  const point = LINE_POINTS[dir];
  if (!point) {
    throw new Error(`unknown direction: ${dir}`);
  }
  const cells = [];
  for (let k = 0; k < 4; k += 1) {
    const [r, c] = point(line, k);
    cells.push(board[r][c]);
  }
  return cells;
}

export function writeLine(board, dir, line, cells) {
  const point = LINE_POINTS[dir];
  if (!point) {
    throw new Error(`unknown direction: ${dir}`);
  }
  for (let k = 0; k < 4; k += 1) {
    const [r, c] = point(line, k);
    board[r][c] = cells[k];
  }
}

/**
 * Slide-and-merge one line toward index 0: compress non-zero tiles, merge
 * equal neighbours once per move, pad with zeros.
 */
export function collapse(line) {
  const tiles = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== 0) tiles.push(line[i]);
  }
  const out = [];
  for (let i = 0; i < tiles.length; i += 1) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
      out.push(tiles[i] * 2);
      i += 1; // the merged neighbour is consumed
    } else {
      out.push(tiles[i]);
    }
  }
  while (out.length < 4) out.push(0);
  return out;
}

export function simulateMove(board, dir) {
  const next = board.map((row) => row.slice());
  for (let line = 0; line < 4; line += 1) {
    writeLine(next, dir, line, collapse(extractLine(next, dir, line)));
  }
  return next;
}

export function boardsEqual(a, b) {
  return a.length === 4 && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Points earned by moving `board` in `dir` under standard 2048 scoring: each
 * merge of two tiles a,a -> 2a earns 2a points, summed over all merges the
 * move performs. Spawning never earns points. This is the scoring arbiter —
 * deliberately independent of every solver's internal score.
 */
export function moveGain(board, dir) {
  const point = LINE_POINTS[dir];
  if (!point) {
    throw new Error(`unknown direction: ${dir}`);
  }
  let gain = 0;
  for (let line = 0; line < 4; line += 1) {
    const tiles = [];
    for (let k = 0; k < 4; k += 1) {
      const [r, c] = point(line, k);
      if (board[r][c] !== 0) tiles.push(board[r][c]);
    }
    for (let i = 0; i + 1 < tiles.length; i += 1) {
      if (tiles[i] === tiles[i + 1]) {
        gain += tiles[i] * 2;
        i += 1; // the merged neighbour is consumed, matching collapse()
      }
    }
  }
  return gain;
}

export function isValidMove(board, dir) {
  if (dir < 0 || dir > 3) return false;
  return !boardsEqual(simulateMove(board, dir), board);
}

/**
 * Directions that change the board, in the given evaluation order.
 */
export function validMoves(board, order = [0, 1, 2, 3]) {
  return order.filter((dir) => isValidMove(board, dir));
}

export function isGameOver(board) {
  return validMoves(board).length === 0;
}

export function emptyCells(board) {
  const cells = [];
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      if (board[r][c] === 0) cells.push([r, c]);
    }
  }
  return cells;
}

/**
 * Standard 2048 spawn: uniform random empty cell, 2 with p=0.9, else 4.
 * Mutates `board`; returns the spawn that was placed (or null if full).
 */
export function spawnRandomTile(board, rng) {
  const cells = emptyCells(board);
  if (cells.length === 0) return null;
  const [r, c] = cells[Math.floor(rng() * cells.length)];
  const value = rng() < 0.9 ? 2 : 4;
  board[r][c] = value;
  return { r, c, value };
}

/**
 * Full-game step for replays: simulate the move, and if the board changed,
 * spawn the next tile deterministically from `rng`.
 * Returns { board, moved, spawn } (board is a new array).
 */
export function applyMoveWithSpawn(board, dir, rng) {
  const moved = simulateMove(board, dir);
  if (boardsEqual(moved, board)) {
    return { board, moved: false, spawn: null };
  }
  const spawn = spawnRandomTile(moved, rng);
  return { board: moved, moved: true, spawn };
}

export function cloneBoard(board) {
  return board.map((row) => row.slice());
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

export function boardToString(board) {
  return board
    .map((row) => row.map((v) => (v === 0 ? "." : String(v)).padStart(5)).join(""))
    .join("\n");
}
