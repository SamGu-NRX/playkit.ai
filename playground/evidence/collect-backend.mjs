#!/usr/bin/env node
/**
 * Evidence collector: runs the REAL SolverManager (wasm attempt -> declared
 * fallback) from Node and records the OBSERVED backend outcome verbatim.
 * Nothing is simulated; the WASM arm's absence is recorded as such.
 */
import { createPracticeSolver } from "../js/solver-adapter.mjs";

const solver = createPracticeSolver({});
const observed = await solver.initialize();
const board = [
  [2, 2, 4, 4],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
];
const step = await solver.nextMove(board);
const outcome = {
  collectedUtc: new Date().toISOString(),
  environment: typeof document === "undefined" ? "node" : "browser",
  attemptedArm: "SolverManager default: WASM (src/extension/wasm/solver.mjs + solver.wasm) then declared naive fallback",
  observed: {
    backend: step.backend,
    label: step.label,
    managerStatus: step.detail.status,
    wasmLastError: step.detail.lastError ? String(step.detail.lastError) : null,
    order: step.order,
    chosen: step.chosen,
  },
  note: "solver.wasm is gitignored and absent in this environment (parent HANDOFF.md), so the observed engine is the manager's DECLARED naive fallback, labeled verbatim. The compiled WASM arm is recorded as unrun here; no solver rationale or stronger answer is simulated.",
};
console.log(JSON.stringify(outcome, null, 2));
