/**
 * @fileoverview WASM-backed solver engine that bridges to the C++ strategy.
 */

import { BoardEncoder } from "./board-utils.js";

const DEFAULT_STRATEGY = {
  type: "expectimax-depth",
  heuristic: "corner",
  depth: 4,
  probability: 0.0025,
};

const ALL_DIRECTIONS = [0, 1, 2, 3];

// The C++ solver's move indices are Right(0), Down(1), Left(2), Up(3) —
// verified empirically against the real binary with single-tile corner
// boards (isValidMove validity patterns). The project's Direction enum is
// Up(0), Right(1), Down(2), Left(3), so map on the way out.
const WASM_TO_PROJECT_DIRECTION = [1, 2, 3, 0];

function getRuntimeAPI() {
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime;
  }
  if (typeof browser !== "undefined" && browser.runtime && browser.runtime.getURL) {
    return browser.runtime;
  }
  return null;
}

/**
 * URL of the script tag that loaded the bundled runtime (bookmarklet path).
 *
 * The bundle is a classic-script IIFE, so while it evaluates `document.currentScript`
 * still points at the <script src="…/2048-hud.min.js"> tag the host page injected.
 * Solver assets live next to that bundle under `wasm/`, so its directory is the
 * bundle origin. Extension content scripts and native-ESM loads leave it null.
 */
const bundleScriptUrl = (() => {
  try {
    if (typeof document !== "undefined" && document.currentScript && document.currentScript.src) {
      return document.currentScript.src;
    }
  } catch (error) {
    // Non-DOM environment: fall through to the other resolution strategies.
  }
  return null;
})();

/**
 * Resolve a solver asset (`solver.mjs`, `solver.wasm`) to an absolute URL.
 *
 * Precedence: explicit option → extension runtime.getURL → the bundle origin
 * (bookmarklet: assets load from where the bundle was served, NOT the host
 * page's base URI, which produced 404s like `/2048/solver.mjs`) → page base.
 */
function resolveAssetUrl(filename, options = {}) {
  if (filename === "solver.mjs" && options.moduleUrl) {
    return options.moduleUrl;
  }
  if (filename === "solver.wasm" && options.wasmUrl) {
    return options.wasmUrl;
  }
  if (options.baseUrl) {
    return new URL(filename, options.baseUrl).toString();
  }
  const runtime = getRuntimeAPI();
  if (runtime) {
    return runtime.getURL(`wasm/${filename}`);
  }
  if (bundleScriptUrl) {
    return new URL(`wasm/${filename}`, bundleScriptUrl).toString();
  }
  if (typeof document !== "undefined") {
    const base = options.documentBase || document.baseURI || window.location.href;
    return new URL(filename, base).toString();
  }
  throw new Error(`Unable to resolve solver asset: ${filename}`);
}

function sanitizeStrategy(config = {}) {
  return {
    type: (typeof config.type === "string" ? config.type.trim() : "") || DEFAULT_STRATEGY.type,
    heuristic:
      (typeof config.heuristic === "string" ? config.heuristic.trim() : "") ||
      DEFAULT_STRATEGY.heuristic,
    depth:
      typeof config.depth === "number" && Number.isFinite(config.depth)
        ? Math.min(8, Math.max(1, Math.floor(config.depth)))
        : DEFAULT_STRATEGY.depth,
    probability:
      typeof config.probability === "number" && Number.isFinite(config.probability)
        ? Math.max(0.0001, config.probability)
        : DEFAULT_STRATEGY.probability,
  };
}

/**
 * One clean failure when solver.wasm is missing, instead of the Emscripten
 * glue's multi-line abort stack. Only a definitive HTTP failure (404 etc.)
 * short-circuits: a network/CORS error here is not proof the artifact is
 * absent, so we let the module load attempt proceed unchanged.
 */
async function assertWasmArtifactPresent(wasmUrl) {
  try {
    const response = await fetch(wasmUrl, { method: "HEAD" });
    if (!response.ok) {
      throw new Error(
        `WASM solver artifact missing (${response.status} at ${wasmUrl}). Build it with "node scripts/build-wasm.js --release"; the JS fallback engine will be used.`,
      );
    }
  } catch (error) {
    if (error instanceof TypeError) {
      // fetch itself failed (offline / opaque CORS) — not evidence of a
      // missing artifact. Let the Emscripten loader speak for itself.
      return;
    }
    throw error;
  }
}

export function sanitizeStrategyForTest(config = {}) {
  return sanitizeStrategy(config);
}

export { resolveAssetUrl, assertWasmArtifactPresent };

export class WASMSolverEngine {
  constructor(options = {}) {
    this.options = options;
    this.status = "idle"; // idle | loading | ready | error
    this.lastError = null;
    this.module = null;
    this.strategyWrapper = null;
    this._loadPromise = null;
    this.strategyConfig = sanitizeStrategy(options.strategy);
  }

  async initialize() {
    if (this.status === "ready") {
      return;
    }
    if (this._loadPromise) {
      return this._loadPromise;
    }

    this.status = "loading";
    this._loadPromise = this.loadModule()
      .then(() => {
        this.status = "ready";
        this.lastError = null;
      })
      .catch((error) => {
        this.status = "error";
        this.lastError = error;
        throw error;
      })
      .finally(() => {
        this._loadPromise = null;
      });

    return this._loadPromise;
  }

  async ensureReady() {
    if (this.status === "ready") {
      return;
    }
    await this.initialize();
  }

  async loadModule() {
    const moduleUrl = resolveAssetUrl("solver.mjs", this.options);
    const wasmUrl = resolveAssetUrl("solver.wasm", this.options);

    // Fail fast and quietly when the artifact was never built. Without this
    // check the Emscripten glue downloads nothing, logs its own abort stack,
    // and throws a RuntimeError — three noisy lines instead of one.
    await assertWasmArtifactPresent(wasmUrl);

    const importResult = await import(/* webpackIgnore: true */ moduleUrl);
    const factory = importResult && importResult.default ? importResult.default : importResult;
    if (typeof factory !== "function") {
      throw new Error("Invalid solver module factory");
    }

    const module = await factory({
      locateFile: (path) => (path.endsWith(".wasm") ? wasmUrl : path),
    });

    if (!module || typeof module.StrategyWrapper !== "function") {
      throw new Error("Solver module missing StrategyWrapper export");
    }

    this.module = module;
    this.strategyWrapper = new module.StrategyWrapper(
      this.strategyConfig.type,
      this.strategyConfig.heuristic,
      this.strategyConfig.depth,
      this.strategyConfig.probability,
    );
  }

  async setStrategy(config = {}) {
    this.strategyConfig = sanitizeStrategy({ ...this.strategyConfig, ...config });

    if (this.status !== "ready" || !this.strategyWrapper) {
      return;
    }

    try {
      this.strategyWrapper.configure(
        this.strategyConfig.type,
        this.strategyConfig.heuristic,
        this.strategyConfig.depth,
        this.strategyConfig.probability,
      );
    } catch (error) {
      console.warn("WASMSolverEngine: failed to apply strategy", error);
    }
  }

  async getMoveOrder(board) {
    await this.ensureReady();
    if (!this.module || !this.strategyWrapper) {
      throw new Error("WASM solver not initialized");
    }

    const exponents = BoardEncoder.toExponentArray(board);

    // Pass an explicit IntVector: embind's array -> std::vector auto-conversion
    // lives in the dynamic invoker, which -sNO_DYNAMIC_EXECUTION=1 removes (the
    // MV3 content-script CSP forbids string evaluation). The registered vector
    // binding exposes only the default constructor under fixed-arity invokers,
    // so build it with push_back and free it after the call.
    const tiles = new this.module.IntVector();
    let boardValue;
    try {
      for (const exponent of exponents) {
        tiles.push_back(exponent);
      }
      boardValue = this.module.boardFromArray(tiles);
    } finally {
      tiles.delete();
    }

    let preferred = 0;
    try {
      preferred = this.strategyWrapper.pickMove(boardValue);
    } catch (error) {
      console.warn("WASMSolverEngine: pickMove failed", error);
    }

    const candidates = [];
    for (const direction of ALL_DIRECTIONS) {
      let valid = false;
      let score = Number.NEGATIVE_INFINITY;
      try {
        valid = this.module.isValidMove(boardValue, direction);
        if (valid) {
          const nextBoard = this.module.makeMove(boardValue, direction);
          score = this.strategyWrapper.evaluateBoard(nextBoard);
        }
      } catch (error) {
        valid = false;
      }

      candidates.push({ direction, valid, score });
    }

    const validMoves = candidates.filter((item) => item.valid);
    const ordered = validMoves
      .sort((a, b) => {
        if (a.direction === preferred && b.direction !== preferred) return -1;
        if (b.direction === preferred && a.direction !== preferred) return 1;
        return b.score - a.score;
      })
      .map((item) => item.direction);

    if (!ordered.length) {
      return BoardEncoder.uniqueDirections([preferred]).map(
        (direction) => WASM_TO_PROJECT_DIRECTION[direction],
      );
    }

    return BoardEncoder.uniqueDirections(ordered).map(
      (direction) => WASM_TO_PROJECT_DIRECTION[direction],
    );
  }

  async getBoardInfo(board) {
    if (this.status !== "ready" || !this.module) {
      return null;
    }

    try {
      const exponents = BoardEncoder.toExponentArray(board);
      const boardValue = this.module.boardFromArray(exponents);
      return {
        score: this.module.getScore(boardValue),
        maxTile: this.module.getMaxTile(boardValue),
        gameOver: this.module.isGameOver(boardValue),
      };
    } catch (error) {
      console.warn("WASMSolverEngine: getBoardInfo failed", error);
      return null;
    }
  }

  getStatus() {
    return {
      type: "wasm",
      status: this.status,
      ready: this.status === "ready",
      lastError: this.lastError ? String(this.lastError.message || this.lastError) : null,
      strategy: { ...this.strategyConfig },
    };
  }
}

