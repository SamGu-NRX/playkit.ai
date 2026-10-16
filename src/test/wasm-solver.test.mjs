/**
 * @fileoverview Tests for the WASM solver engine bridge (node --test).
 *
 * Run from the repository root (no dependencies to install; Node >= 20):
 *
 *   node --test src/test/wasm-solver.test.mjs
 *
 * The engine is exercised against a fake solver module served as a data: URL
 * and against tiny local HTTP servers for the artifact pre-flight check. One
 * end-to-end test loads the REAL committed Emscripten binary over HTTP and
 * skips when the artifacts are not present (e.g. a stripped checkout).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  WASMSolverEngine,
  SolverManager,
} from "../solver/index.js";
import {
  sanitizeStrategyForTest,
  resolveAssetUrl,
} from "../solver/wasm-solver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake Emscripten-style module served to the engine via a data: URL. */
const FAKE_MODULE_SOURCE = `
const instances = { wrappers: [], locateFile: [] };
class StrategyWrapper {
  constructor(type, heuristic, depth, probability) {
    this.config = { type, heuristic, depth, probability };
    instances.wrappers.push(this);
  }
  configure(type, heuristic, depth, probability) {
    this.config = { type, heuristic, depth, probability };
  }
  pickMove() { return 0; }
  evaluateBoard() { return 1; }
}
export default function createSolverModule(options) {
  if (options && options.locateFile) {
    instances.locateFile.push(options.locateFile("solver.wasm"));
  }
  return {
    StrategyWrapper,
    boardFromArray: () => 0,
    isValidMove: () => false,
    makeMove: () => 0,
    getScore: () => 0,
    getMaxTile: () => 0,
    isGameOver: () => false,
    __instances: instances,
  };
}
`;

const FAKE_MODULE_URL = `data:text/javascript;base64,${Buffer.from(
  FAKE_MODULE_SOURCE,
).toString("base64")}`;

/** Minimal HTTP server: 200 for /ok.wasm, 404 for everything else. */
async function startAssetServer() {
  const server = createServer((req, res) => {
    if (req.url === "/ok.wasm") {
      res.writeHead(200, { "Content-Type": "application/wasm" });
      res.end();
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: (path) => `http://127.0.0.1:${server.address().port}${path}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

function makeEngineOptions(overrides = {}) {
  return {
    moduleUrl: FAKE_MODULE_URL,
    wasmUrl: null, // filled per-test
    strategy: { type: "expectimax-depth", heuristic: "corner", depth: 4 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Strategy sanitization
// ---------------------------------------------------------------------------

test("sanitizeStrategy fills defaults and clamps inputs", () => {
  const sanitized = sanitizeStrategyForTest({
    type: "  expectimax-probability ",
    heuristic: "",
    depth: 12.7,
    probability: -5,
  });

  assert.equal(sanitized.type, "expectimax-probability");
  assert.equal(sanitized.heuristic, "corner", "empty heuristic falls back to default");
  assert.equal(sanitized.depth, 8, "depth is floored and clamped to sane bounds");
  assert.ok(sanitized.probability > 0, "probability is clamped positive");
});

test("sanitizeStrategy keeps a valid config untouched", () => {
  const sanitized = sanitizeStrategyForTest({
    type: "expectimax-depth",
    heuristic: "monotonicity",
    depth: 3,
    probability: 0.01,
  });

  assert.deepEqual(sanitized, {
    type: "expectimax-depth",
    heuristic: "monotonicity",
    depth: 3,
    probability: 0.01,
  });
});

// ---------------------------------------------------------------------------
// Asset URL resolution
// ---------------------------------------------------------------------------

test("resolveAssetUrl prefers explicit module and wasm URLs", () => {
  assert.equal(
    resolveAssetUrl("solver.mjs", { moduleUrl: "https://cdn.example/a/solver.mjs" }),
    "https://cdn.example/a/solver.mjs",
  );
  assert.equal(
    resolveAssetUrl("solver.wasm", { wasmUrl: "https://cdn.example/a/solver.wasm" }),
    "https://cdn.example/a/solver.wasm",
  );
});

test("resolveAssetUrl joins against baseUrl when given", () => {
  assert.equal(
    resolveAssetUrl("solver.mjs", { baseUrl: "https://cdn.example/bundle-dir/" }),
    "https://cdn.example/bundle-dir/solver.mjs",
  );
});

test("resolveAssetUrl falls back to the page base (old page-relative behavior)", () => {
  // In the browser bundle this branch is only reached when neither the
  // bundle-origin capture nor an explicit option exists; a page at /2048/
  // therefore produced the historical /2048/solver.mjs 404.
  globalThis.document = { baseURI: "https://games.example/2048/" };
  try {
    assert.equal(
      resolveAssetUrl("solver.mjs", {}),
      "https://games.example/2048/solver.mjs",
    );
  } finally {
    delete globalThis.document;
  }
});

test("resolveAssetUrl honors documentBase over page baseURI", () => {
  globalThis.document = { baseURI: "https://games.example/2048/" };
  try {
    assert.equal(
      resolveAssetUrl("solver.wasm", { documentBase: "https://cdn.example/hosted/" }),
      "https://cdn.example/hosted/solver.wasm",
    );
  } finally {
    delete globalThis.document;
  }
});

// ---------------------------------------------------------------------------
// Engine: construction, strategy reach-through, missing artifact
// ---------------------------------------------------------------------------

test("engine constructs StrategyWrapper with its strategy config", async () => {
  const assets = await startAssetServer();
  try {
    const engine = new WASMSolverEngine(
      makeEngineOptions({ wasmUrl: assets.url("/ok.wasm") }),
    );

    await engine.initialize();

    assert.equal(engine.status, "ready");
    assert.ok(engine.strategyWrapper, "wrapper instance exists after load");
    assert.deepEqual(engine.strategyWrapper.config, {
      type: "expectimax-depth",
      heuristic: "corner",
      depth: 4,
      probability: 0.0025,
    });
    assert.equal(
      engine.getStatus().strategy.type,
      "expectimax-depth",
    );
  } finally {
    await assets.close();
  }
});

test("engine routes solver.wasm through the locateFile option", async () => {
  const assets = await startAssetServer();
  try {
    const wasmUrl = assets.url("/ok.wasm");
    const engine = new WASMSolverEngine(makeEngineOptions({ wasmUrl }));
    await engine.initialize();

    assert.equal(
      engine.module.__instances.locateFile.at(-1),
      wasmUrl,
      "locateFile returns the resolved artifact URL",
    );
  } finally {
    await assets.close();
  }
});

test("setStrategy applies the new configuration to the ready engine", async () => {
  const assets = await startAssetServer();
  try {
    const engine = new WASMSolverEngine(
      makeEngineOptions({ wasmUrl: assets.url("/ok.wasm") }),
    );
    await engine.initialize();

    await engine.setStrategy({
      type: "expectimax-probability",
      heuristic: "monotonicity",
      depth: 2,
      probability: 0.01,
    });

    assert.deepEqual(engine.strategyWrapper.config, {
      type: "expectimax-probability",
      heuristic: "monotonicity",
      depth: 2,
      probability: 0.01,
    });
    assert.equal(engine.getStatus().strategy.heuristic, "monotonicity");
  } finally {
    await assets.close();
  }
});

test("strategy set before load is used when the engine becomes ready", async () => {
  const assets = await startAssetServer();
  try {
    const engine = new WASMSolverEngine(
      makeEngineOptions({ wasmUrl: assets.url("/ok.wasm") }),
    );
    await engine.setStrategy({ depth: 6, heuristic: "wall" });
    await engine.initialize();

    assert.equal(engine.strategyWrapper.config.depth, 6);
    assert.equal(engine.strategyWrapper.config.heuristic, "wall");
  } finally {
    await assets.close();
  }
});

test("missing solver.wasm produces one clean error, not an emscripten stack", async () => {
  const assets = await startAssetServer();
  try {
    const engine = new WASMSolverEngine(
      makeEngineOptions({ wasmUrl: assets.url("/missing.wasm") }),
    );

    await assert.rejects(engine.initialize(), (error) => {
      assert.match(error.message, /WASM solver artifact missing \(404/);
      assert.match(error.message, /build-wasm\.js --release/);
      assert.doesNotMatch(error.message, /Aborted/, "no emscripten abort text");
      assert.doesNotMatch(error.message, /RuntimeError/, "no runtime error leak");
      return true;
    });

    assert.equal(engine.status, "error");
  } finally {
    await assets.close();
  }
});

// ---------------------------------------------------------------------------
// SolverManager: WASM activation and fallback
// ---------------------------------------------------------------------------

test("SolverManager activates the WASM engine when the artifact exists", async () => {
  const assets = await startAssetServer();
  try {
    const manager = new SolverManager({
      moduleUrl: FAKE_MODULE_URL,
      wasmUrl: assets.url("/ok.wasm"),
    });

    await manager.initialize();

    assert.equal(manager.status, "ready");
    assert.equal(manager.isWasmActive(), true);
    assert.equal(manager.getStatus().mode, "wasm");
    assert.equal(manager.getStatus().wasm.status, "ready");
  } finally {
    await assets.close();
  }
});

test("SolverManager falls back with a clean lastError when the artifact is missing", async () => {
  const assets = await startAssetServer();
  try {
    const manager = new SolverManager({
      moduleUrl: FAKE_MODULE_URL,
      wasmUrl: assets.url("/missing.wasm"),
    });

    await manager.initialize();

    assert.equal(manager.status, "fallback");
    assert.equal(manager.isWasmActive(), false);
    assert.equal(manager.getStatus().mode, "fallback");
    assert.match(manager.getStatus().lastError, /WASM solver artifact missing/);
    assert.equal(
      manager.lastError instanceof Error && manager.lastError.name === "RuntimeError",
      false,
      "fallback reports the clean gate error, not an emscripten RuntimeError",
    );
  } finally {
    await assets.close();
  }
});

// ---------------------------------------------------------------------------
// Real WASM binary end-to-end (skipped when the artifacts are absent)
// ---------------------------------------------------------------------------

const realWasmDir = new URL("../extension/wasm/", import.meta.url);

test("real WASM binary solves a position end to end", { skip: !existsSync(new URL("solver.wasm", realWasmDir)) }, async () => {
  const server = createServer(async (req, res) => {
    const name =
      req.url === "/solver.mjs" ? "solver.mjs" :
      req.url === "/solver.wasm" ? "solver.wasm" : null;
    if (!name) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    try {
      const body = await readFile(new URL(name, realWasmDir));
      res.writeHead(200, {
        "Content-Type": name === "solver.wasm" ? "application/wasm" : "text/javascript",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("missing");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const manager = new SolverManager({
    // Node cannot import() an http URL, so load the real glue from disk; the
    // engine routes solver.wasm through the locateFile option, which points at
    // the HTTP server (Node fetch handles http, not file://).
    moduleUrl: pathToFileURL(fileURLToPath(new URL("solver.mjs", realWasmDir))).href,
    wasmUrl: `http://127.0.0.1:${server.address().port}/solver.wasm`,
  });

  try {
    await manager.initialize();
    assert.equal(manager.isWasmActive(), true, "real solver.wasm should activate");

    // The exact path that regressed under -sNO_DYNAMIC_EXECUTION=1: a plain JS
    // array must reach boardFromArray through an explicit IntVector (embind's
    // array auto-conversion lives in the dynamic invoker, which the CSP-safe
    // build removes).
    const board = [
      [2, 0, 0, 0],
      [0, 4, 0, 0],
      [0, 0, 2, 0],
      [0, 0, 0, 8],
    ];
    const order = await manager.getMoveOrder(board);
    assert.ok(Array.isArray(order), "getMoveOrder returns an order array");
    assert.ok(order.length > 0, "at least one move is valid on a non-full board");
    for (const direction of order) {
      assert.ok(direction >= 0 && direction <= 3, "directions are 0..3");
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
