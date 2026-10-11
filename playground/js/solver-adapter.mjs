/**
 * @fileoverview Narrow adapter from the practice board to the ACTUAL Playkit
 * solver stack (src/solver/solver-manager.js).
 *
 * No solver is reimplemented here and nothing is simulated: whatever the
 * manager reports — the WASM engine or its DECLARED naive fallback — is
 * recorded verbatim as the observed backend, in the UI and in every log
 * entry. If the manager cannot produce a move order, the adapter surfaces
 * SolverUnavailableError instead of inventing a move.
 *
 * The manager itself catches WASM load failures and switches to its declared
 * fallback (its designed behavior, visible in getStatus().mode = "fallback");
 * the adapter only maps that state to an honest label.
 */

import { SolverManager } from "../../src/solver/solver-manager.js";
import { isValidMove } from "./engine.mjs";

export const BACKEND_LABELS = Object.freeze({
  wasm: "WASM solver (expectimax-depth, corner heuristic)",
  "fallback-naive": "naive fallback — the runtime's declared fallback engine (WASM unavailable)",
  unavailable: "solver unavailable — no move order can be produced",
});

export class SolverUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "SolverUnavailableError";
    this.code = "SOLVER_UNAVAILABLE";
  }
}

export class PracticeSolverAdapter {
  constructor(options = {}) {
    this.manager = new SolverManager(options);
  }

  async initialize() {
    await this.manager.initialize();
    return this.observedBackend();
  }

  observedBackend() {
    const status = this.manager.getStatus();
    const backend = status.mode === "wasm" ? "wasm" : "fallback-naive";
    return { backend, label: BACKEND_LABELS[backend], detail: status };
  }

  async nextMove(board) {
    const order = await this.manager.getMoveOrder(board);
    const legal = order.filter((dir) => isValidMove(board, dir));
    return { order, chosen: legal.length ? legal[0] : null, ...this.observedBackend() };
  }
}

export function createPracticeSolver(options = {}) {
  return new PracticeSolverAdapter(options);
}
