/**
 * Adapter tests: the narrow adapter must drive the REAL SolverManager and
 * label the OBSERVED backend verbatim. In this environment solver.wasm is
 * absent (gitignored; see parent HANDOFF.md), so the honest expectation is
 * the manager's DECLARED naive fallback — never a simulated WASM result.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPracticeSolver, BACKEND_LABELS } from "../js/solver-adapter.mjs";
import { isValidMove } from "../js/engine.mjs";
import {
  isValidMove as refIsValidMove,
  validMoves as refValidMoves,
  mulberry32,
} from "../../test/helpers/reference-2048.mjs";

const E = () => [0, 0, 0, 0];

test("declared-fallback path: the real manager runs and is labeled verbatim", async () => {
  const solver = createPracticeSolver({ disableWasm: true });
  const observed = await solver.initialize();
  assert.equal(observed.backend, "fallback-naive");
  assert.equal(observed.label, BACKEND_LABELS["fallback-naive"]);
  assert.equal(observed.detail.mode, "fallback");
});

test("WASM attempt with solver.wasm absent: manager switches to its declared fallback and records the error", async () => {
  const solver = createPracticeSolver({});
  const observed = await solver.initialize();
  assert.equal(observed.backend, "fallback-naive");
  assert.equal(observed.detail.status, "fallback");
  assert.ok(observed.detail.lastError, "expected the manager to record the WASM failure (honest recording)");
});

test("nextMove: chosen is legal, order is a unique permutation of 0..3, backend labeled", async () => {
  const solver = createPracticeSolver({ disableWasm: true });
  await solver.initialize();
  const step = await solver.nextMove([[2, 2, 4, 4], E(), E(), E()]);
  assert.equal(step.backend, "fallback-naive");
  assert.equal(new Set(step.order).size, 4);
  assert.ok(step.order.every((d) => Number.isInteger(d) && d >= 0 && d <= 3));
  assert.ok(step.chosen !== null && isValidMove([[2, 2, 4, 4], E(), E(), E()], step.chosen));
  assert.ok(refIsValidMove([[2, 2, 4, 4], E(), E(), E()], step.chosen));
});

test("nextMove on a game-over board: chosen is null (no move, no spawn, no document change)", async () => {
  const solver = createPracticeSolver({ disableWasm: true });
  await solver.initialize();
  const full = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];
  const step = await solver.nextMove(full);
  assert.equal(step.chosen, null);
});

test("30 seeded random boards: chosen is always legal per the parent reference", async () => {
  const solver = createPracticeSolver({ disableWasm: true });
  await solver.initialize();
  const rng = mulberry32(424242);
  for (let i = 0; i < 30; i += 1) {
    const board = Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, () => {
        const roll = rng();
        if (roll < 0.45) return 0;
        return 2 ** (1 + Math.floor(rng() * 9));
      }),
    );
    const step = await solver.nextMove(board);
    const reference = refValidMoves(board);
    if (reference.length === 0) {
      assert.equal(step.chosen, null, `board ${i}: expected null on a game-over board`);
    } else {
      assert.ok(step.chosen !== null, `board ${i}: expected a legal chosen move`);
      assert.ok(reference.includes(step.chosen), `board ${i}: chosen ${step.chosen} not in reference legal set`);
    }
  }
});
