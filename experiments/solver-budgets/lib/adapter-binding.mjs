/**
 * Adapter arm binding: drives the ACTUAL production orchestration path —
 * src/solver/solver-manager.js SolverManager, exactly as the extension
 * runtime constructs it (ensureBoard normalization, wasm->naive engine
 * dispatch, declared fallback on WASM failure). The runner still owns all
 * board simulation through the independent reference model; this binding
 * only ever translates a board into a preferred move order.
 *
 * In an environment where the real solver.wasm cannot be built (no emsdk),
 * SolverManager.initialize() declares its own naive fallback — that
 * declared fallback is the production behavior being measured, recorded
 * per-move in meta (engine + manager status), never hidden.
 */

import { performance } from "node:perf_hooks";
import { SolverManager } from "../../../src/solver/solver-manager.js";

export class AdapterBinding {
  constructor(strategy) {
    this.kind = "adapter";
    this.strategy = strategy;
    this.manager = new SolverManager({ strategy });
  }

  async start() {
    await this.manager.initialize();
  }

  async getMoveOrder(board) {
    const t0 = performance.now();
    const order = await this.manager.getMoveOrder(board);
    const engine =
      this.manager.wasmEngine && this.manager.activeEngine === this.manager.wasmEngine
        ? "wasm"
        : "naive";
    return {
      order,
      latencyMs: performance.now() - t0,
      meta: { engine, managerStatus: this.manager.status, managerLastError: this.manager.lastError ? String(this.manager.lastError.message || this.manager.lastError) : null },
    };
  }

  async close() {}
}
