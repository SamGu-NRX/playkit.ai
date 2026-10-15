/**
 * REAL-WASM tests — the actual Emscripten solver, not test/helpers/mock-wasm-solver.mjs.
 *
 * The binary is a build artifact and stays out of git (*.wasm is ignored; the
 * Node-loadable glue with `-sENVIRONMENT=web,node` is a local build too — the
 * committed src/extension/wasm/solver.mjs is web-only and cannot fetch its
 * solver.wasm under Node). When the artifacts are absent these four tests
 * SKIP so the suite stays green in a fresh checkout / CI; they RUN anywhere
 * the solver was built.
 *
 * Build the artifacts (Linux/macOS, emcc on PATH — proven by the sibling
 * solver-budgets study, PR #2; same flags as scripts/build-wasm.js but with
 * Node in the environment set and written to build/wasm/, never touching the
 * committed extension artifacts):
 *
 *   apt-get install -y libsparsehash-dev   # header-only sparsehash
 *   mkdir -p build/sparsehash-include build/wasm
 *   cp -r /usr/include/sparsehash build/sparsehash-include/
 *   em++ solver/wasm/export_solver.cpp -std=c++17 -O3 -sASSERTIONS=0 \
 *     --bind -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,node \
 *     -sALLOW_MEMORY_GROWTH=1 -sWASM_BIGINT=1 -sSUPPORT_LONGJMP=0 \
 *     -sDISABLE_EXCEPTION_CATCHING=1 \
 *     -sEXPORTED_RUNTIME_METHODS=['cwrap','ccall'] \
 *     -sEXPORT_NAME=createSolverModule -I solver -I build/sparsehash-include \
 *     -o build/wasm/solver.mjs
 *   # (solver/ is the 2048-solver submodule; the staged sparsehash include dir
 *   #  is required — pointing -I at /usr/include leaks host glibc headers into
 *   #  the wasm build and the compile dies on bits/libc-header-start.h)
 *
 * Run: node --test test/real-wasm.test.mjs
 *
 * The tests load the real module through test/helpers/real-wasm-node-glue.mjs,
 * which adapts ONLY boardFromArray's vector argument (embind registers
 * std::vector<int> as IntVector and does not accept JS arrays — the same
 * mismatch the sibling solver-budgets study bridged) so the production
 * wasm-solver.js / SolverManager code runs unchanged against the real C++
 * solver.
 *
 * VERIFIED CONVENTION (probed against the independent reference, 5 asymmetric
 * boards, zero exceptions): the C++ solver numbers directions Right, Down,
 * Left, Up (0-3) while the project uses Up, Right, Down, Left. C++ direction
 * c is the physical move of project direction (c + 1) % 4. wasm-solver.js
 * serves the C++ numbers UNREMAPPED, so every order it returns is rotated in
 * the project's reading; the driver-side rejection walk (first entry that is
 * a legal project move) is what keeps gameplay legal. These tests pin that
 * current behavior; TODO(FIX-4) marks the post-remap contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { WASMSolverEngine } from "../src/solver/wasm-solver.js";
import { SolverManager } from "../src/solver/solver-manager.js";
import { mulberry32, simulateMove, validMoves, isGameOver } from "./helpers/reference-2048.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gluePath = path.join(repoRoot, "build", "wasm", "solver.mjs");
const binaryPath = path.join(repoRoot, "build", "wasm", "solver.wasm");
const hasRealWasm = existsSync(gluePath) && existsSync(binaryPath);
const testReal = hasRealWasm ? test : test.skip;
const SKIP_NOTE = "real solver.wasm absent (gitignored build artifact — see the build recipe in the header of this file)";

const glueUrl = () => new URL("./helpers/real-wasm-node-glue.mjs", import.meta.url).href;
const binaryUrl = () => pathToFileURL(binaryPath).href;
const engine = () => new WASMSolverEngine({ moduleUrl: glueUrl(), wasmUrl: binaryUrl() });

/** C++ direction c performs the physical move of project direction (c+1)%4. */
const cppToJs = (c) => (c + 1) % 4;
const jsToCpp = (j) => (j + 3) % 4;

/** Cumulative merge points: building tile v from 2s scores v*(log2(v)-1); 2s score 0. Verified on 7 probed fixtures. */
const cppScore = (board) =>
  board.flat().reduce((sum, v) => sum + (v > 2 ? v * (Math.log2(v) - 1) : 0), 0);

/** Seeded values-board with `tiles` tiles drawn from {2,2,4,4,8}. */
function seededBoard(rand, tiles) {
  const values = [2, 2, 4, 4, 8];
  const grid = Array.from({ length: 16 }, (_, i) => i);
  for (let i = grid.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [grid[i], grid[j]] = [grid[j], grid[i]];
  }
  const board = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  for (let t = 0; t < tiles; t++) {
    board[Math.floor(grid[t] / 4)][grid[t] % 4] = values[Math.floor(rand() * values.length)];
  }
  return board;
}

function spawnTile(board, rand) {
  const empties = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (board[r][c] === 0) empties.push([r, c]);
    }
  }
  const [row, col] = empties[Math.floor(rand() * empties.length)];
  board[row][col] = rand() < 0.9 ? 2 : 4;
}

const flatMax = (board) => Math.max(...board.flat());

testReal(`real WASM: module initializes and the engine reports ready (${SKIP_NOTE})`, async () => {
  const wasm = engine();
  await wasm.initialize();
  const status = wasm.getStatus();
  assert.equal(status.type, "wasm");
  assert.equal(status.status, "ready");
  assert.equal(status.ready, true);
  // A real order comes back through the real embind surface.
  const board = [
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const order = await wasm.getMoveOrder(board);
  assert.equal(order.length, 4);
  assert.equal(new Set(order).size, 4, "padded orders are a permutation of 0..3");
  // The leading C++ direction must be the physical move of a legal project move.
  assert.ok(validMoves(board).includes(cppToJs(order[0])));
});

testReal(`real WASM: order leads with legal physical moves across 150 seeded boards, rotated per the C++ convention (${SKIP_NOTE})`, async () => {
  const wasm = engine();
  await wasm.initialize();
  const rand = mulberry32(0x5eed);
  for (let i = 0; i < 150; i++) {
    const board = seededBoard(rand, Math.floor(rand() * 12)); // 0..11 tiles
    const jsValid = validMoves(board);
    if (jsValid.length === 0) continue; // dead boards return the padded all-four order
    const order = await wasm.getMoveOrder(board);
    assert.equal(new Set(order).size, order.length, `board ${i}: order entries unique`);
    assert.equal(order.length, 4, `board ${i}: uniqueDirections pads to all four`);
    // In the C++ reading, the valid directions come first (preferred first,
    // then by evaluateBoard score), and uniqueDirections pads the rest.
    const cppValid = new Set(jsValid.map(jsToCpp));
    const lead = order.slice(0, cppValid.size);
    assert.deepEqual(
      new Set(lead.map(cppToJs)),
      new Set(jsValid),
      `board ${i}: leading entries must be exactly the legal physical moves (board ${JSON.stringify(board)})`,
    );
    for (const c of order.slice(cppValid.size)) {
      assert.ok(!jsValid.includes(cppToJs(c)), `board ${i}: padded tail must hold only illegal project moves`);
    }
    assert.ok(jsValid.includes(cppToJs(order[0])), `board ${i}: first entry must be a legal physical move`);
  }
});

// TODO(FIX-4): wasm-solver.js serves C++ directions unremapped (C++ Right,
// Down, Left, Up = 0-3 vs project Up, Right, Down, Left). After the engine
// remaps (cpp c -> js (c+1)%4) and stops padding, un-skip and assert the
// order contains exactly the project-legal directions, first.
test.skip("real WASM post-remap contract (FIX-4): order is exactly the project-legal directions", async () => {
  const wasm = engine();
  await wasm.initialize();
  const rand = mulberry32(0x5eed);
  for (let i = 0; i < 150; i++) {
    const board = seededBoard(rand, Math.floor(rand() * 12));
    const jsValid = validMoves(board);
    if (jsValid.length === 0) continue;
    const order = await wasm.getMoveOrder(board);
    assert.deepEqual([...order].sort((a, b) => a - b), [...jsValid].sort((a, b) => a - b));
  }
});

testReal(`real WASM: getBoardInfo returns merge-point score, tile-value maxTile, reference gameOver (${SKIP_NOTE})`, async () => {
  const wasm = engine();
  await wasm.initialize();
  // Probed fixtures: score is cumulative merge points (an 8-tile built from
  // 2s scores 8*(3-1)=16), NOT the sum of tile values.
  const fixtures = [
    { board: [[8, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], score: 16, max: 8, over: false },
    { board: [[4, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], score: 4, max: 4, over: false },
    { board: [[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], score: 0, max: 2, over: false },
    { board: [[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], score: 0, max: 2, over: false },
    { board: [[4, 4, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], score: 8, max: 4, over: false },
    { board: [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]], score: 32, max: 4, over: true },
    // C++ quirk (probed): the all-zero bitboard reports gameOver === true even
    // though an empty board always has a legal move. Pinned as current behavior.
    { board: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], score: 0, max: 0, over: true },
  ];
  for (const f of fixtures) {
    const info = await wasm.getBoardInfo(f.board);
    assert.equal(info.score, f.score, `score fixture ${JSON.stringify(f.board)}`);
    assert.equal(info.maxTile, f.max, `maxTile fixture ${JSON.stringify(f.board)}`);
    assert.equal(info.gameOver, f.over, `gameOver fixture ${JSON.stringify(f.board)}`);
  }
  const rand = mulberry32(0xb04d);
  for (let i = 0; i < 40; i++) {
    const board = seededBoard(rand, 1 + Math.floor(rand() * 12)); // 1..12 tiles: the empty board hits the gameOver quirk pinned above
    const info = await wasm.getBoardInfo(board);
    assert.equal(info.score, cppScore(board), `board ${i}: merge-point score`);
    assert.equal(info.maxTile, flatMax(board), `board ${i}: maxTile`);
    assert.equal(info.gameOver, isGameOver(board), `board ${i}: gameOver`);
  }
});

testReal(`real WASM: SolverManager drives a full seeded game to maxTile >= 128 via the driver's rejection walk (${SKIP_NOTE})`, async () => {
  const manager = new SolverManager({ moduleUrl: glueUrl(), wasmUrl: binaryUrl() });
  await manager.initialize();
  assert.equal(manager.getStatus().mode, "wasm", "the real engine must serve the moves");
  assert.equal(manager.isWasmActive(), true);

  const rand = mulberry32(0x9a2e);
  // Witness: count real StrategyWrapper.pickMove calls so a silent naive
  // fallback can never fake this test (the engine/manager swallow per-call
  // WASM failures and keep status.mode === "wasm" while serving naive moves).
  const realModule = manager.wasmEngine.module;
  const rawPickMove = realModule.StrategyWrapper.prototype.pickMove;
  let realPickCalls = 0;
  realModule.StrategyWrapper.prototype.pickMove = function (...args) {
    realPickCalls += 1;
    return rawPickMove.apply(this, args);
  };

  let board = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  spawnTile(board, rand);
  spawnTile(board, rand);

  for (let move = 0; move < 400; move++) {
    if (isGameOver(board)) break;
    const order = await manager.getMoveOrder(board);
    // Read the order in the C++ convention (cpp c = js (c+1)%4) so the real
    // solver's INTENDED policy is exercised — under the current unremapped
    // bridge the driver plays rotated moves (FIX-4), which this test's
    // sibling contract test pins separately.
    const dir = order.map(cppToJs).find((d) => validMoves(board).includes(d));
    assert.ok(dir !== undefined, `move ${move}: order must contain a legal move`);
    board = simulateMove(board, dir);
    spawnTile(board, rand);
  }
  assert.ok(realPickCalls > 0, "the real WASM solver must serve at least one pickMove");
  assert.ok(flatMax(board) >= 128, `seeded game should reach 128, ended at ${flatMax(board)}: ${JSON.stringify(board)}`);
});
