/**
 * Native convention cross-check: pins the C++ direction convention against the
 * independent JS reference model using the native shim's own MAKE (move
 * simulation), which exists ONLY for this test — the study runner advances
 * games exclusively through the reference model.
 *
 * Verifies, over sample boards:
 *   1. C++ MAKE[dir] reproduces the reference model's simulateMove(board, [1,2,3,0][dir])
 *   2. pickMove's JS-mapped direction is in range and, when applied, is
 *      board-changing (never an illegal index — that would mean the mapping,
 *      not the move, is wrong)
 *
 * Skips (with a clear reason) when the native binary has not been built.
 * Run: node --test experiments/solver-budgets/tests/native-crosscheck.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NativeSolverBridge } from "../lib/native-bridge.mjs";
import { toExponents } from "../lib/engines.mjs";
import { simulateMove, boardsEqual } from "../../../test/helpers/reference-2048.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const binary = path.join(here, "../build/native-solver");
const CPP_TO_JS = [1, 2, 3, 0];

const SAMPLE_BOARDS = [
  [
    [2, 0, 2, 0],
    [0, 4, 0, 4],
    [2, 2, 2, 2],
    [0, 0, 0, 1024],
  ],
  [
    [1024, 512, 256, 128],
    [8, 16, 32, 64],
    [4, 2, 2, 4],
    [2, 0, 0, 0],
  ],
  [
    [0, 0, 0, 0],
    [0, 2, 0, 0],
    [0, 0, 4, 0],
    [0, 0, 0, 0],
  ],
  [
    [2, 4, 8, 16],
    [32, 64, 128, 256],
    [512, 1024, 2, 4],
    [8, 16, 32, 64],
  ],
];

test("C++ move simulation matches the reference model under the pinned mapping", { skip: !existsSync(binary) && "native binary not built (native/build-native.sh)" }, async () => {
  const bridge = new NativeSolverBridge(binary);
  await bridge.start();
  try {
    for (let b = 0; b < SAMPLE_BOARDS.length; b += 1) {
      const board = SAMPLE_BOARDS[b];
      const exponents = toExponents(board);
      for (let cppDir = 0; cppDir < 4; cppDir += 1) {
        const cppNext = await bridge.makeMoveCpp(cppDir, exponents);
        const cppBoard = [];
        for (let r = 0; r < 4; r += 1) cppBoard.push(cppNext.slice(r * 4, r * 4 + 4));
        const jsBoard = simulateMove(
          board.map((row) => [...row]),
          CPP_TO_JS[cppDir],
        );
        // No-spawn comparison: both models simulate the slide/merge only.
        // The shim speaks flat exponent arrays; reshape the reference to match.
        const jsExponents = toExponents(jsBoard);
        const jsRows = [0, 1, 2, 3].map((r) => jsExponents.slice(r * 4, r * 4 + 4));
        assert.ok(
          boardsEqual(cppBoard, jsRows),
          `board ${b} cppDir ${cppDir}: C++ board ${JSON.stringify(cppBoard)} != reference exponents ${JSON.stringify(jsRows)}`,
        );
      }
    }
  } finally {
    await bridge.close();
  }
});

test("pickMove convention: JS-mapped direction is in range and applicable or a no-op", { skip: !existsSync(binary) && "native binary not built (native/build-native.sh)" }, async () => {
  const bridge = new NativeSolverBridge(binary);
  await bridge.start();
  try {
    await bridge.configure(0, 3, 5, 0.5, 256);
    for (const board of SAMPLE_BOARDS) {
      // Dead boards have no board-changing move at all; any pick maps to a
      // no-op there and carries no convention information. Skip them.
      const hasLegalMove = [0, 1, 2, 3].some((d) => !boardsEqual(simulateMove(board.map((row) => [...row]), d), board));
      if (!hasLegalMove) continue;
      const result = await bridge.pickMove(toExponents(board));
      assert.ok(!result.error, `pickMove failed: ${result.error}`);
      assert.ok(Number.isInteger(result.jsDir) && result.jsDir >= 0 && result.jsDir <= 3, "mapped direction in range");
      // Applied to the reference model, the pick must change the board (the
      // C++ solver only picks among moves it considers legal) — a persistent
      // no-op classification here would mean the mapping is wrong.
      const next = simulateMove(board.map((row) => [...row]), result.jsDir);
      assert.ok(!boardsEqual(next, board), `pick mapped to a no-op: cppDir ${result.cppDir} jsDir ${result.jsDir}`);
    }
  } finally {
    await bridge.close();
  }
});
