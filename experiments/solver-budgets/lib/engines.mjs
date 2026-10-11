/**
 * Arm bindings: adapt each actual solver interface to the uniform
 * `getMoveOrder(board) -> { order, latencyMs, meta }` contract the runner
 * drives. The runner owns all board simulation (independent reference model);
 * bindings only ever translate a board into a preferred move order.
 *
 * Arms present here:
 *   - naive      — src/solver/naive-solver.js NaiveSolverEngine (the real
 *                  production fallback; real offline arm)
 *   - native-cpp — the 2048-solver submodule's C++ strategies compiled natively
 *                  with g++ (separately labelled; distinct build from WASM)
 *   - wasm       — the same C++ sources compiled by Emscripten, driven through
 *                  the same embind surface the extension uses (included only
 *                  when the local build actually succeeded)
 *   - scripted   — test-only binding with canned orders (no solver involved)
 */

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { NaiveSolverEngine } from "../../../src/solver/naive-solver.js";
import { NativeSolverBridge } from "./native-bridge.mjs";

/** Row-major exponent encoder — independent of src/solver/board-utils.js. */
export function toExponents(board) {
  const out = new Array(16);
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      const v = board[r][c];
      out[r * 4 + c] = v <= 1 ? 0 : Math.round(Math.log2(v));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ naive */

export class NaiveBinding {
  constructor() {
    this.kind = "naive";
    this.engine = new NaiveSolverEngine({});
  }

  async start() {
    await this.engine.initialize();
  }

  async getMoveOrder(board) {
    const t0 = performance.now();
    const order = await this.engine.getMoveOrder(board);
    return { order, latencyMs: performance.now() - t0, meta: {} };
  }

  async close() {}
}

/* ------------------------------------------------------------- native-cpp */

export class NativeCppBinding {
  constructor(binaryPath, strategy) {
    this.kind = "native-cpp";
    this.bridge = new NativeSolverBridge(binaryPath);
    this.strategy = strategy; // { type, heuristic, depth, probability, trials? }
    this._configureLatencyMs = null;
  }

  async start() {
    await this.bridge.start();
    this._configureLatencyMs = await this.bridge.configure(
      this.strategy.type,
      this.strategy.heuristic,
      this.strategy.depth,
      this.strategy.probability,
      this.strategy.trials,
    );
  }

  async getMoveOrder(board) {
    const result = await this.bridge.pickMove(toExponents(board));
    if (result.error) {
      return { order: [], latencyMs: NaN, meta: { error: String(result.error) } };
    }
    // The C++ interface returns ONE preferred move; the order is a single
    // entry and the runner's rejection walk handles the (rare) illegal pick.
    return {
      order: [result.jsDir],
      latencyMs: result.roundTripMs,
      meta: { cppDir: result.cppDir, computeUs: result.computeUs },
    };
  }

  async close() {
    await this.bridge.close();
  }
}

/* ------------------------------------------------------------------- wasm */

/**
 * Drives the SAME embind surface the extension loads
 * (module.StrategyWrapper / boardFromArray / isValidMove / makeMove /
 * evaluateBoard), mirroring src/solver/wasm-solver.js#getMoveOrder's ordering
 * logic (preferred first, remaining valid directions by evaluateBoard score).
 * Built locally into experiments/solver-budgets/build/wasm/ — the repo's
 * committed src/extension/wasm/ glue ships without a solver.wasm binary.
 */
export class WasmBinding {
  constructor(modulePath, wasmPath, strategy) {
    this.kind = "wasm";
    this.modulePath = modulePath;
    this.wasmPath = wasmPath;
    this.strategy = strategy;
    this.module = null;
    this.wrapper = null;
  }

  static available(modulePath, wasmPath) {
    return existsSync(modulePath) && existsSync(wasmPath);
  }

  async start() {
    const imported = await import(pathToFileURL(this.modulePath).href);
    const factory = imported.default ?? imported;
    this.module = await factory({ wasmBinary: new Uint8Array((await import("node:fs")).readFileSync(this.wasmPath)) });
    this.wrapper = new this.module.StrategyWrapper(
      this.strategy.type,
      this.strategy.heuristic,
      this.strategy.depth,
      this.strategy.probability,
    );
  }

  async getMoveOrder(board) {
    const t0 = performance.now();
    // The embind surface registers std::vector<int> as IntVector; JS arrays
    // are not accepted, so the exponents go in through push_back.
    const exponents = toExponents(board);
    const boardValue = this.module.boardFromArray(
      (() => {
        const vec = new this.module.IntVector();
        for (const v of exponents) vec.push_back(v);
        return vec;
      })(),
    );

    let preferred = 0;
    let pickError = null;
    try {
      preferred = this.wrapper.pickMove(boardValue);
    } catch (error) {
      pickError = String(error.message || error);
    }
    // The embind surface returns the C++ pick_move index; same empirical
    // convention as the native build (cpp: 0=Right, 1=Down, 2=Left, 3=Up).
    const CPP_TO_JS = [1, 2, 3, 0];

    const candidates = [];
    for (const dir of [0, 1, 2, 3]) {
      let valid = false;
      let score = Number.NEGATIVE_INFINITY;
      try {
        valid = this.module.isValidMove(boardValue, dir);
        if (valid) {
          const nextBoard = this.module.makeMove(boardValue, dir);
          score = this.wrapper.evaluateBoard(nextBoard);
        }
      } catch {
        valid = false;
      }
      candidates.push({ dir, valid, score });
    }

    // Order: preferred first, then remaining valid dirs by score (mirrors
    // wasm-solver.js). C++ makeMove/isValidMove use the C++ convention, so
    // candidate dirs are mapped C++ -> JS for the runner.
    const validMoves = candidates.filter((item) => item.valid);
    const orderedCpp = validMoves
      .sort((a, b) => {
        if (a.dir === Number(preferred) && b.dir !== Number(preferred)) return -1;
        if (b.dir === Number(preferred) && a.dir !== Number(preferred)) return 1;
        return b.score - a.score;
      })
      .map((item) => item.dir);

    return {
      order: orderedCpp.map((d) => CPP_TO_JS[d]),
      latencyMs: performance.now() - t0,
      meta: { preferredCpp: Number(preferred), pickError },
    };
  }

  async close() {}
}

/* ---------------------------------------------------------------- scripted */

/** Test-only binding returning canned orders one move at a time. */
export class ScriptedBinding {
  constructor(orders, latencyMs = 1) {
    this.kind = "scripted";
    this.orders = orders;
    this.latencyMs = latencyMs;
    this.i = 0;
  }

  async start() {}

  async getMoveOrder() {
    const order = this.i < this.orders.length ? this.orders[this.i] : [];
    this.i += 1;
    return { order, latencyMs: this.latencyMs, meta: {} };
  }

  async close() {}
}
