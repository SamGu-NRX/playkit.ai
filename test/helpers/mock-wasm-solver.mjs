/**
 * Mock stand-in for the Emscripten `solver.mjs` embind bundle.
 *
 * src/solver/wasm-solver.js dynamically imports this URL and consumes the
 * surface below (verified against source; the C++ contract lives in
 * .kiro/specs/browser-extension-2048-solver/design.md — the repo has no
 * docs/solver-instructions.md):
 *   default export — async factory, invoked as `factory({ locateFile })`
 *   module.StrategyWrapper — new StrategyWrapper(type, heuristic, depth, probability)
 *     .pickMove(bits) -> preferred direction (Number 0-3)
 *     .evaluateBoard(bits) -> Number; .configure(type, heuristic, depth, probability)
 *   module.boardFromArray(16 log2/exponent ints) -> BigInt bitboard
 *   module.isValidMove(bits, dir) -> boolean; makeMove(bits, dir) -> BigInt
 *   module.getScore / getMaxTile / isGameOver (getBoardInfo path only)
 *
 * Boards cross the boundary as BigInt (real build uses -sWASM_BIGINT,
 * uint64 board_t). Directions follow the project convention 0=Up, 1=Right,
 * 2=Down, 3=Left. design.md's pickMove comment ("0=left,1=up,...") is stale:
 * wasm-solver.js compares pickMove's result against project-convention
 * numbers, which is what this mock honours — and why it returns a Number
 * (the engine's `a.direction === preferred` sort would drop a BigInt pick).
 *
 * Failure variants for tests — select with MOCK_WASM_MODE at factory-call
 * time (env is read per call, so the URL-cached module can switch modes):
 *   (unset) fully working mock | factory-throws | missing-wrapper (garbage
 *   module without StrategyWrapper) | pickmove-throws
 *
 * Move semantics are an independent re-implementation, not imported from
 * src/ — same rule as reference-2048.mjs.
 */

function decode(bits) {
  const grid = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < 16; i++) {
    const exp = Number((bits >> BigInt(i * 4)) & 0xFn);
    grid[(i / 4) | 0][i % 4] = exp === 0 ? 0 : 2 ** exp;
  }
  return grid;
}

function encode(grid) {
  let bits = 0n;
  for (let i = 0; i < 16; i++) {
    const value = grid[(i / 4) | 0][i % 4];
    bits |= (value === 0 ? 0n : BigInt(Math.round(Math.log2(value)))) << BigInt(i * 4);
  }
  return bits;
}

// Slide + one merge pass toward `dir`, mirroring standard 2048 rules.
function moved(grid, dir) {
  const next = grid.map((row) => row.slice());
  for (let line = 0; line < 4; line++) {
    const cells = []; // indexed so cell 0 is furthest in the direction of travel
    for (let k = 0; k < 4; k++) {
      cells.push(dir === 0 ? [k, line] : dir === 1 ? [line, 3 - k]
        : dir === 2 ? [3 - k, line] : [line, k]);
    }
    const tiles = cells.map(([r, c]) => next[r][c]).filter((v) => v !== 0);
    const out = [];
    for (let j = 0; j < tiles.length; j++) {
      if (j + 1 < tiles.length && tiles[j] === tiles[j + 1]) {
        out.push(tiles[j] * 2);
        j += 1; // merged neighbour is consumed
      } else out.push(tiles[j]);
    }
    while (out.length < 4) out.push(0);
    cells.forEach(([r, c], j) => { next[r][c] = out[j]; });
  }
  return next;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canMove = (grid, dir) => !same(moved(grid, dir), grid);

class MockStrategyWrapper {
  constructor(calls, mode, type, heuristic, depth, probability) {
    calls.push(`StrategyWrapper:${type},${heuristic},${depth},${probability}`);
    this._calls = calls;
    this._mode = mode;
  }

  // The real solver runs expectimax; the mock deterministically prefers the
  // lowest-index valid direction (0 when dead) — predictable enough for
  // delegation assertions.
  pickMove(bits) {
    this._calls.push(`pickMove:${bits}`);
    if (this._mode === "pickmove-throws") throw new Error("mock pickMove failure");
    const grid = decode(bits);
    return [0, 1, 2, 3].find((dir) => canMove(grid, dir)) ?? 0;
  }

  // Deterministic heuristic (distinctive for sort-order assertions).
  evaluateBoard(bits) {
    const flat = decode(bits).flat();
    return 1000 + Math.max(...flat) - flat.filter((v) => v === 0).length * 10;
  }

  configure(type, heuristic, depth, probability) {
    this._calls.push(`configure:${type},${heuristic},${depth},${probability}`);
  }
}

export default async function factory({ locateFile } = {}) {
  const mode = process.env.MOCK_WASM_MODE || "";
  const calls = [`factory:locateFile=${typeof locateFile}`];
  if (mode === "factory-throws") throw new Error("mock factory failure");

  const module = { __calls: calls, __mode: mode };
  if (mode === "missing-wrapper") return module; // garbage: no StrategyWrapper

  module.boardFromArray = (tiles) => {
    calls.push(`boardFromArray:${tiles.length}`);
    let bits = 0n;
    for (let i = 0; i < 16; i++) bits |= BigInt(tiles[i] & 0xF) << BigInt(i * 4);
    return bits;
  };
  module.isValidMove = (bits, dir) => { calls.push(`isValidMove:${dir}`); return canMove(decode(bits), dir); };
  module.makeMove = (bits, dir) => { calls.push(`makeMove:${dir}`); return encode(moved(decode(bits), dir)); };
  module.getScore = (bits) => { calls.push("getScore"); return decode(bits).flat().reduce((sum, v) => sum + v, 0); };
  module.getMaxTile = (bits) => { calls.push("getMaxTile"); return Math.max(...decode(bits).flat()); };
  module.isGameOver = (bits) => {
    calls.push("isGameOver");
    return ![0, 1, 2, 3].some((dir) => canMove(decode(bits), dir));
  };
  module.StrategyWrapper = class extends MockStrategyWrapper {
    constructor(type, heuristic, depth, probability) {
      super(calls, mode, type, heuristic, depth, probability);
    }
  };
  return module;
}
