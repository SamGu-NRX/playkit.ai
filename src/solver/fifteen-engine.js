/**
 * @fileoverview 15-puzzle solver engine for the shared driver loop.
 *
 * The driver asks an engine for a direction order with getMoveOrder(board)
 * and tries directions until the board changes. For the 15-puzzle a wrong
 * direction is not merely wasted - it moves the wrong tile - so this engine
 * returns exactly one direction per call: the next move of a cached optimal
 * plan. The plan is verified against the observed board before each step and
 * recomputed when the page drifts (a site quirk, a stray user click, or a
 * random un-stuck move by the driver), so play stays correct without the
 * driver needing game-specific changes.
 */

import { Direction } from "../adapters/adapter.js";
import {
  applyFifteenMove,
  isFifteenSolved,
  isValidFifteenBoard,
  solveFifteen,
} from "./fifteen-solver.js";

export class FifteenSolverEngine {
  /**
   * @param {{maxNodes?: number}} config
   */
  constructor(config = {}) {
    this.maxNodes = config.maxNodes ?? 400000;
    this.status = "ready";
    this.plan = null; // { moves: number[], states: number[][][] }
    this.planIndex = 0;
    this.lastSolveNodes = 0;
  }

  async initialize() {
    this.status = "ready";
  }

  async ensureReady() {
    return;
  }

  /**
   * Next direction for the driver. Returns a one-element array (the verified
   * next move), or an empty array when the engine cannot help (solved board,
   * unsolvable board, node budget exhausted); the driver then falls back to
   * its own direction priority.
   * @param {number[][]} board
   * @returns {Promise<number[]>}
   */
  async getMoveOrder(board) {
    if (!isValidFifteenBoard(board)) {
      this.plan = null;
      return [];
    }
    if (isFifteenSolved(board)) {
      this.plan = null;
      return [];
    }

    // Continue the cached plan only if the page is exactly where we expect.
    if (
      this.plan &&
      this.planIndex < this.plan.moves.length &&
      boardsEqual(board, this.plan.states[this.planIndex])
    ) {
      const next = this.plan.moves[this.planIndex];
      this.planIndex++;
      return [next];
    }

    // Replan from the observed board.
    const result = solveFifteen(board, { maxNodes: this.maxNodes });
    this.lastSolveNodes = result.nodes;

    if (result.status !== "solved" || !result.moves || result.moves.length === 0) {
      this.plan = null;
      return [];
    }

    // Precompute intermediate states so future calls can verify the page.
    const states = [board.map((row) => [...row])];
    for (const move of result.moves) {
      states.push(applyFifteenMove(states[states.length - 1], move));
    }

    this.plan = { moves: result.moves, states };
    this.planIndex = 1;
    return [result.moves[0]];
  }

  async setStrategy() {
    // No tunables for the 15-puzzle solver yet.
  }

  getStatus() {
    return {
      type: "fifteen-ida",
      ready: this.status === "ready",
      hasPlan: !!this.plan,
      planIndex: this.planIndex,
      lastSolveNodes: this.lastSolveNodes,
    };
  }

  /** Drop the cached plan (used when the adapter reattaches). */
  resetPlan() {
    this.plan = null;
    this.planIndex = 0;
  }
}

function boardsEqual(a, b) {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (a[r][c] !== b[r][c]) return false;
    }
  }
  return true;
}
