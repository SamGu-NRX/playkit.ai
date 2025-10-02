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

function getRuntimeAPI() {
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime;
  }
  if (typeof browser !== "undefined" && browser.runtime && browser.runtime.getURL) {
    return browser.runtime;
  }
  return null;
}

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
  if (typeof document !== "undefined") {
    const base = options.documentBase || document.baseURI || window.location.href;
    return new URL(filename, base).toString();
  }
  throw new Error(`Unable to resolve solver asset: ${filename}`);
}

function sanitizeStrategy(config = {}) {
  return {
    type: config.type || DEFAULT_STRATEGY.type,
    heuristic: config.heuristic || DEFAULT_STRATEGY.heuristic,
    depth:
      typeof config.depth === "number" && Number.isFinite(config.depth)
        ? Math.max(1, Math.floor(config.depth))
        : DEFAULT_STRATEGY.depth,
    probability:
      typeof config.probability === "number" && Number.isFinite(config.probability)
        ? Math.max(0.0001, config.probability)
        : DEFAULT_STRATEGY.probability,
  };
}

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
    const boardValue = this.module.boardFromArray(exponents);

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
      return BoardEncoder.uniqueDirections([preferred]);
    }

    return BoardEncoder.uniqueDirections(ordered);
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

