/**
 * @fileoverview Orchestrates WASM solver loading with naive fallback.
 */

import { BoardEncoder } from "./board-utils.js";
import { NaiveSolverEngine } from "./naive-solver.js";
import { WASMSolverEngine } from "./wasm-solver.js";

const DEFAULT_STRATEGY = {
  type: "expectimax-depth",
  heuristic: "corner",
  depth: 4,
  probability: 0.0025,
};

function mergeStrategy(base, overrides) {
  return {
    ...base,
    ...(overrides || {}),
  };
}

export class SolverManager {
  constructor(options = {}) {
    this.options = options;
    this.strategy = mergeStrategy(DEFAULT_STRATEGY, options.strategy);

    this.naiveEngine = new NaiveSolverEngine(this.strategy);
    this.wasmEngine = options.disableWasm
      ? null
      : new WASMSolverEngine({ ...options, strategy: this.strategy });

    this.activeEngine = this.naiveEngine;
    this.status = this.wasmEngine ? "idle" : "fallback"; // idle | ready | fallback
    this.lastError = null;
    this._initializationPromise = null;
  }

  async initialize() {
    if (!this.wasmEngine) {
      await this.naiveEngine.initialize();
      this.status = "fallback";
      return;
    }

    if (this.status === "ready" || this.status === "fallback") {
      return;
    }

    if (this._initializationPromise) {
      return this._initializationPromise;
    }

    await this.naiveEngine.initialize();

    this._initializationPromise = this.wasmEngine
      .initialize()
      .then(() => {
        this.activeEngine = this.wasmEngine;
        this.status = "ready";
        this.lastError = null;
      })
      .catch((error) => {
        console.warn("SolverManager: WASM initialization failed, using fallback", error);
        this.activeEngine = this.naiveEngine;
        this.status = "fallback";
        this.lastError = error;
      })
      .finally(() => {
        this._initializationPromise = null;
      });

    return this._initializationPromise;
  }

  async ensureInitialized() {
    if (this.status === "idle") {
      await this.initialize();
    }
  }

  async getMoveOrder(board) {
    const normalized = BoardEncoder.ensureBoard(board);
    await this.ensureInitialized();

    try {
      const order = await this.activeEngine.getMoveOrder(normalized);
      return BoardEncoder.uniqueDirections(order || []);
    } catch (error) {
      if (this.activeEngine === this.wasmEngine && this.naiveEngine) {
        console.warn("SolverManager: WASM getMoveOrder failed, switching to fallback", error);
        this.lastError = error;
        this.activeEngine = this.naiveEngine;
        this.status = "fallback";
        const fallbackOrder = await this.naiveEngine.getMoveOrder(normalized);
        return BoardEncoder.uniqueDirections(fallbackOrder || []);
      }
      throw error;
    }
  }

  async getBoardInfo(board) {
    if (this.activeEngine === this.wasmEngine && this.wasmEngine) {
      return this.wasmEngine.getBoardInfo(board);
    }
    return null;
  }

  async setStrategy(strategy) {
    this.strategy = mergeStrategy(this.strategy, strategy);
    await Promise.all([
      this.naiveEngine?.setStrategy?.(this.strategy),
      this.wasmEngine?.setStrategy?.(this.strategy),
    ]);
  }

  isWasmActive() {
    return this.activeEngine === this.wasmEngine && this.status === "ready";
  }

  getStatus() {
    return {
      mode: this.isWasmActive() ? "wasm" : "fallback",
      status: this.status,
      lastError: this.lastError ? String(this.lastError.message || this.lastError) : null,
      strategy: { ...this.strategy },
      wasm: this.wasmEngine ? this.wasmEngine.getStatus() : null,
      naive: this.naiveEngine.getStatus(),
    };
  }
}

export function createSolverManager(options = {}) {
  return new SolverManager(options);
}

