/**
 * SolverManager orchestration (src/solver/solver-manager.js) plus the
 * WASMSolverEngine contract it depends on — no browser, no DOM. The WASM
 * module is faked by ./helpers/mock-wasm-solver.mjs (real solver.wasm can
 * never load here: the repo has no *.wasm and no emcc). Run:
 *   node --test test/solver-manager.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { SolverManager, createSolverManager } from "../src/solver/solver-manager.js";
import { WASMSolverEngine } from "../src/solver/wasm-solver.js";
import { NaiveSolverEngine } from "../src/solver/naive-solver.js";
import { validMoves } from "./helpers/reference-2048.mjs";

const MOCK_URL = new URL("./helpers/mock-wasm-solver.mjs", import.meta.url).href;
// Never exists — exercises the dynamic-import failure path.
const MISSING_URL = pathToFileURL("/nonexistent/playkit-solver-mock.mjs").href;

const BOARD = [
  [2, 2, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
];

/** Run a test fn with MOCK_WASM_MODE set, restoring the env afterwards. */
function withMockMode(mode, fn) {
  return async () => {
    const previous = process.env.MOCK_WASM_MODE;
    process.env.MOCK_WASM_MODE = mode;
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.MOCK_WASM_MODE;
      else process.env.MOCK_WASM_MODE = previous;
    }
  };
}

test("createSolverManager is the exported factory", () => {
  assert.ok(createSolverManager({ disableWasm: true }) instanceof SolverManager);
});

test("happy path: working mock WASM engine — initialize() reaches ready, mode wasm", async () => {
  const manager = new SolverManager({ moduleUrl: MOCK_URL, wasmUrl: MOCK_URL });
  await manager.initialize();
  assert.equal(manager.isWasmActive(), true);
  const status = manager.getStatus();
  assert.equal(status.mode, "wasm");
  assert.equal(status.status, "ready");
  assert.equal(status.lastError, null);
});

test("happy path: getMoveOrder delegates to the mock WASM engine (distinctive order + call log)", async () => {
  const manager = new SolverManager({ moduleUrl: MOCK_URL, wasmUrl: MOCK_URL });
  await manager.initialize();

  // Mock pickMove = lowest-index valid direction; remaining valid dirs ascend
  // by the mock's evaluateBoard score; uniqueDirections pads to all four.
  assert.deepEqual(validMoves(BOARD), [1, 2, 3]); // Right, Down, Left valid per reference
  const order = await manager.getMoveOrder(BOARD);
  assert.deepEqual(order, [1, 2, 3, 0]);

  // The mock saw the exact BigInt bitboard 17 (= exponents [1,1,0...]) and a
  // 16-tile array, and the wrapper was constructed with the default strategy.
  const calls = manager.wasmEngine.module.__calls;
  assert.ok(calls.includes("boardFromArray:16"));
  assert.ok(calls.includes("pickMove:17"));
  assert.ok(calls.some((entry) => entry.startsWith("StrategyWrapper:expectimax-depth,corner,4,")));
});

test("happy path: getBoardInfo delegates to the mock with distinctive values", async () => {
  const manager = new SolverManager({ moduleUrl: MOCK_URL, wasmUrl: MOCK_URL });
  await manager.initialize();
  assert.deepEqual(await manager.getBoardInfo(BOARD), { score: 4, maxTile: 2, gameOver: false });
});

test("engine-level: WASMSolverEngine.initialize() rejects when the module URL is missing", async () => {
  // The ENGINE rejects; it is the MANAGER that swallows the rejection (next tests).
  const engine = new WASMSolverEngine({ moduleUrl: MISSING_URL, wasmUrl: MISSING_URL });
  await assert.rejects(() => engine.initialize(), /Cannot find module|ERR_MODULE_NOT_FOUND/);
  const status = engine.getStatus();
  assert.equal(status.type, "wasm");
  assert.equal(status.status, "error");
  assert.equal(status.ready, false);
  assert.match(status.lastError, /Cannot find module|ERR_MODULE_NOT_FOUND/);
});

test("engine-level: garbage module without StrategyWrapper rejects with the source's exact error", withMockMode("missing-wrapper", async () => {
  const engine = new WASMSolverEngine({ moduleUrl: MOCK_URL, wasmUrl: MOCK_URL });
  await assert.rejects(() => engine.initialize(), /Solver module missing StrategyWrapper export/);
}));

test("engine-level: throwing factory rejects with the mock error", withMockMode("factory-throws", async () => {
  const engine = new WASMSolverEngine({ moduleUrl: MOCK_URL, wasmUrl: MOCK_URL });
  await assert.rejects(() => engine.initialize(), /mock factory failure/);
}));

test("engine-level: pickMove failures are swallowed by getMoveOrder (preferred falls back to 0)", withMockMode("pickmove-throws", async () => {
  const engine = new WASMSolverEngine({ moduleUrl: MOCK_URL, wasmUrl: MOCK_URL });
  await engine.initialize(); // loads fine — only pickMove throws
  const order = await engine.getMoveOrder(BOARD);
  // preferred = 0 (swallowed error); valid {1,2,3} sorted by the mock's
  // evaluateBoard score: Down (862) beats Right/Left (854); padded to four.
  assert.deepEqual(order, [2, 1, 3, 0]);
  assert.equal(engine.getStatus().status, "ready"); // the failure never surfaced
}));

test("failure path: missing module URL — initialize() falls back (resolves), getMoveOrder serves the naive order", async () => {
  const manager = new SolverManager({ moduleUrl: MISSING_URL, wasmUrl: MISSING_URL });
  // Current behavior: the manager swallows the WASM failure and falls back.
  await assert.doesNotReject(() => manager.initialize());
  const status = manager.getStatus();
  assert.equal(status.mode, "fallback");
  assert.equal(status.status, "fallback");
  assert.match(status.lastError, /Cannot find module|ERR_MODULE_NOT_FOUND/);

  const order = await manager.getMoveOrder(BOARD);
  const expected = await new NaiveSolverEngine().getMoveOrder(BOARD);
  assert.deepEqual(order, expected);
  assert.equal(manager.isWasmActive(), false);

  // Repeated calls after fallback: no rethrow, no hang, stable output.
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await manager.getMoveOrder(BOARD), expected);
  }
});

test("failure path: throwing factory — same fallback orchestration, mock error in lastError", withMockMode("factory-throws", async () => {
  const manager = new SolverManager({ moduleUrl: MOCK_URL, wasmUrl: MOCK_URL });
  await manager.initialize();
  assert.equal(manager.getStatus().mode, "fallback");
  assert.match(manager.getStatus().lastError, /mock factory failure/);
  await manager.getMoveOrder(BOARD); // naive serves it; must not throw
}));

test("failure path: garbage module (no StrategyWrapper) — falls back, exact source error in lastError", withMockMode("missing-wrapper", async () => {
  const manager = new SolverManager({ moduleUrl: MOCK_URL, wasmUrl: MOCK_URL });
  await manager.initialize();
  assert.equal(manager.getStatus().mode, "fallback");
  assert.match(manager.getStatus().lastError, /Solver module missing StrategyWrapper export/);
}));

test("disableWasm: no WASM engine is ever constructed or imported", async () => {
  const manager = new SolverManager({ disableWasm: true });
  assert.equal(manager.wasmEngine, null); // nothing exists to import with
  assert.equal(manager.getStatus().status, "fallback");
  await manager.initialize();
  assert.equal(manager.isWasmActive(), false);
  const status = manager.getStatus();
  assert.equal(status.mode, "fallback");
  assert.equal(status.wasm, null);
  assert.deepEqual(await manager.getMoveOrder(BOARD), await new NaiveSolverEngine().getMoveOrder(BOARD));
});

test("getStatus() shape pin (fresh manager, wasm enabled, never initialized)", () => {
  const manager = new SolverManager({ moduleUrl: MOCK_URL, wasmUrl: MOCK_URL });
  const status = manager.getStatus();
  assert.deepEqual(
    Object.keys(status).sort(),
    ["lastError", "mode", "naive", "status", "strategy", "wasm"],
  );
  // Before initialize(), mode already reads "fallback" (naive is active) with idle status.
  assert.equal(status.mode, "fallback");
  assert.equal(status.status, "idle");
  assert.equal(status.lastError, null);
  assert.deepEqual(status.strategy, { type: "expectimax-depth", heuristic: "corner", depth: 4, probability: 0.0025 });
  assert.equal(status.wasm.type, "wasm");
  assert.equal(status.wasm.status, "idle");
  assert.equal(status.wasm.ready, false);
  assert.deepEqual(status.naive, { type: "naive", ready: true, strategy: { bias: 2 } });
});

test("getMoveOrder validates the board BEFORE initializing (bad boards never touch WASM)", async () => {
  const manager = new SolverManager({ moduleUrl: MOCK_URL, wasmUrl: MISSING_URL });
  await assert.rejects(() => manager.getMoveOrder(undefined), /expected a 4x4 matrix/);
  assert.equal(manager.getStatus().status, "idle"); // initialization never even started
});

// TODO(FIX-3): SolverManager.getMoveOrder never surfaces WHICH engine served
// the move. When the WASM engine fails, the manager silently switches to the
// naive engine and returns an identical-looking order; callers cannot tell a
// WASM answer from a fallback answer except by polling getStatus().mode
// around each call. Noted in the task report instead of inventing API.
test.skip("getMoveOrder result identifies the serving engine (post FIX-3)", async () => {
  const manager = new SolverManager({ moduleUrl: MOCK_URL, wasmUrl: MOCK_URL });
  await manager.initialize();
  const result = await manager.getMoveOrder(BOARD);
  assert.equal(result.engine, "wasm"); // proposed contract, not current API
});

// TODO(FIX-3): getBoardInfo returns null BOTH when the naive engine is active
// and when the WASM engine is merely not ready — the null is ambiguous.
test.skip("getBoardInfo distinguishes naive-active from wasm-not-ready (post FIX-3)", async () => {
  const manager = new SolverManager({ disableWasm: true });
  await manager.initialize();
  assert.notEqual(await manager.getBoardInfo(BOARD), null); // proposed, not current API
});
