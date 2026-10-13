/**
 * Mock WASM solver module — a faithful stand-in for src/extension/wasm/solver.mjs.
 *
 * Matches the exact surface WASMSolverEngine consumes (src/solver/wasm-solver.js):
 *   default export: factory({ locateFile }) -> Promise<module>
 *   module.StrategyWrapper: class(type, heuristic, depth, probability)
 *     .configure(type, heuristic, depth, probability)
 *     .pickMove(boardBig) -> BigInt direction
 *     .evaluateBoard(boardBig) -> number
 *   module.boardFromArray(int16[16]) -> BigInt
 *   module.makeMove(boardBig, dir) -> BigInt
 *   module.isValidMove(boardBig, dir) -> boolean
 *   module.getScore(boardBig) -> number
 *   module.getMaxTile(boardBig) -> number
 *   module.isGameOver(boardBig) -> boolean
 *
 * BigInt layout: 16 nibbles, little-endian (nibble i at bits 4*i, row-major).
 * Nibbles hold EXPONENTS (0 = empty, v = 2^v), mirroring BoardEncoder's
 * exponent form. Loading this module proves the dynamic import() + factory +
 * StrategyWrapper path works end-to-end without the 5.1 MB binary.
 */

const CORNER_WEIGHTS = [
  [15, 14, 13, 12],
  [8, 9, 10, 11],
  [7, 6, 5, 4],
  [0, 1, 2, 3],
];

function packNibbles(exponents) {
  let value = 0n;
  for (let i = 0; i < 16; i++) {
    value |= BigInt(exponents[i] & 0xf) << BigInt(4 * i);
  }
  return value;
}

function unpackNibbles(boardValue) {
  const exponents = new Array(16);
  for (let i = 0; i < 16; i++) {
    exponents[i] = Number((boardValue >> BigInt(4 * i)) & 0xfn);
  }
  return exponents;
}

// Exponent form -> tile values, row-major 4x4.
function decodeBoard(boardValue) {
  return unpackNibbles(boardValue).map((e) => (e === 0 ? 0 : 2 ** e));
}

function slideLine(lineValues) {
  const tiles = lineValues.filter((v) => v !== 0);
  const out = [];
  let gained = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
      const merged = tiles[i] * 2;
      out.push(merged);
      gained += merged;
      i++;
    } else {
      out.push(tiles[i]);
    }
  }
  while (out.length < 4) out.push(0);
  return { line: out, gained };
}

function rotateBoard(board, times) {
  let current = board.map((row) => row.slice());
  for (let t = 0; t < times; t++) {
    const rotated = [[], [], [], []];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        rotated[c][3 - r] = current[r][c];
      }
    }
    current = rotated;
  }
  return current;
}

function moveBoard(board, direction) {
  // 0 up, 1 right, 2 down, 3 left (driver convention)
  const rotateBy = [1, 2, 3, 0][direction]; // rotate so the move becomes "left"
  const rotated = rotateBoard(board, rotateBy);
  let gained = 0;
  const moved = rotated.map((row) => {
    const result = slideLine(row);
    gained += result.gained;
    return result.line;
  });
  return { board: rotateBoard(moved, (4 - rotateBy) % 4), gained };
}

function boardsEqual(a, b) {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (a[r][c] !== b[r][c]) return false;
    }
  }
  return true;
}

function hasEmpty(board) {
  return board.some((row) => row.some((v) => v === 0));
}

function canMove(board) {
  if (hasEmpty(board)) return true;
  for (const dir of [0, 1, 2, 3]) {
    if (!boardsEqual(moveBoard(board, dir).board, board)) return true;
  }
  return false;
}

class StrategyWrapper {
  constructor(type, heuristic, depth, probability) {
    this.configure(type, heuristic, depth, probability);
    this.callCount = 0;
  }

  configure(type, heuristic, depth, probability) {
    this.type = type;
    this.heuristic = heuristic;
    this.depth = depth;
    this.probability = probability;
  }

  evaluateBoard(boardValue) {
    const flat = decodeBoard(boardValue);
    let score = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        score += flat[r * 4 + c] * CORNER_WEIGHTS[r][c];
      }
    }
    return score;
  }

  pickMove(boardValue) {
    // Deterministic preference: down, right, left, up among valid moves.
    this.callCount += 1;
    const flat = decodeBoard(boardValue);
    const board = [flat.slice(0, 4), flat.slice(4, 8), flat.slice(8, 12), flat.slice(12, 16)];
    for (const dir of [2, 1, 3, 0]) {
      const next = moveBoard(board, dir).board;
      if (!boardsEqual(next, board)) return BigInt(dir);
    }
    return 0n;
  }
}

export default function createSolverMockModule() {
  return Promise.resolve({
    StrategyWrapper,
    boardFromArray: (exponents) => packNibbles(exponents),
    makeMove: (boardValue, direction) => {
      const flat = decodeBoard(boardValue);
      const board = [flat.slice(0, 4), flat.slice(4, 8), flat.slice(8, 12), flat.slice(12, 16)];
      const { board: next } = moveBoard(board, Number(direction));
      return packNibbles(next.flatMap((row) => row.map((v) => (v === 0 ? 0 : Math.log2(v)))));
    },
    isValidMove: (boardValue, direction) => {
      const flat = decodeBoard(boardValue);
      const board = [flat.slice(0, 4), flat.slice(4, 8), flat.slice(8, 12), flat.slice(12, 16)];
      return !boardsEqual(moveBoard(board, Number(direction)).board, board);
    },
    getScore: (boardValue) => {
      const flat = decodeBoard(boardValue);
      return flat.reduce((sum, v) => (v ? sum + v : sum), 0);
    },
    getMaxTile: (boardValue) => Math.max(...decodeBoard(boardValue)),
    isGameOver: (boardValue) => {
      const flat = decodeBoard(boardValue);
      const board = [flat.slice(0, 4), flat.slice(4, 8), flat.slice(8, 12), flat.slice(12, 16)];
      return !canMove(board);
    },
  });
}
