/**
 * Engine tests: strict validation, hand-scored merge fixtures, and
 * cross-checks of every transition against the parent public reference
 * (test/helpers/reference-2048.mjs) AND the solver's own simulators
 * (src/solver/naive-solver.js MOVE_SIMULATORS).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyMove,
  applySpawn,
  validateBoard,
  isValidMove,
  isGameOver,
  defaultSpawn,
  emptyCells,
  maxTile,
  DIRECTIONS,
  PracticeBoardError,
} from "../js/engine.mjs";
import {
  simulateMove as refSimulateMove,
  isValidMove as refIsValidMove,
  isGameOver as refIsGameOver,
  mulberry32,
} from "../../test/helpers/reference-2048.mjs";
import { MOVE_SIMULATORS } from "../../src/solver/naive-solver.js";
import { BoardEncoder, BoardEncodingError } from "../../src/solver/board-utils.js";

const DIRS = [DIRECTIONS.UP, DIRECTIONS.RIGHT, DIRECTIONS.DOWN, DIRECTIONS.LEFT];
const E = () => [0, 0, 0, 0];

function loadFixtures() {
  return JSON.parse(readFileSync(new URL("../evidence/controls-fixture.json", import.meta.url), "utf8"));
}

test("hand-scored fixtures: merged tile VALUES count, not tile mass", () => {
  const { fixtures } = loadFixtures();
  assert.ok(fixtures.length >= 5, "expected at least 5 hand-scored fixtures");
  for (const fx of fixtures) {
    const got = applyMove(fx.board, fx.direction);
    assert.equal(got.moved, fx.expectMoved, fx.name);
    assert.deepEqual(got.board, fx.expectBoard, fx.name);
    assert.equal(got.scoreGain, fx.expectScoreGain, fx.name);
    // Cross-check the same transition against the parent reference.
    assert.deepEqual(got.board, refSimulateMove(fx.board, fx.direction), `${fx.name} (reference agreement)`);
  }
});

test("[2,2,4,4] left earns exactly 12 (4 + 8), with merge accounting", () => {
  const got = applyMove([[2, 2, 4, 4], E(), E(), E()], DIRECTIONS.LEFT);
  assert.equal(got.scoreGain, 12);
  assert.equal(got.mergeCount, 2);
  assert.deepEqual(got.merges, [
    { r: 0, c: 0, value: 4 },
    { r: 0, c: 1, value: 8 },
  ]);
});

test("spawning earns 0 (score only accrues from merges)", () => {
  const moved = applyMove([[2, 2, 4, 4], E(), E(), E()], DIRECTIONS.LEFT);
  const spawned = applySpawn(moved.board, { r: 0, c: 2, value: 2 });
  assert.ok(spawned.board[0][2] === 2);
  assert.equal(moved.scoreGain, 12);
  // applySpawn carries no score contribution by construction.
  assert.equal("scoreGain" in spawned, false);
});

test("no-op moves earn 0 and leave the board untouched", () => {
  const board = [[2, 4, 2, 0], E(), E(), E()];
  const got = applyMove(board, DIRECTIONS.LEFT);
  assert.equal(got.moved, false);
  assert.equal(got.scoreGain, 0);
  assert.deepEqual(got.merges, []);
  assert.deepEqual(got.board, board);
  assert.equal(isValidMove(board, DIRECTIONS.LEFT), false);
});

test("validation: invalid dimensions are refused", () => {
  assert.throws(() => validateBoard([[2, 2], [4, 4]]), (e) => e instanceof PracticeBoardError && e.code === "INVALID_DIMENSIONS");
  assert.throws(() => validateBoard([[2, 2, 4, 4], E(), E()]), (e) => e.code === "INVALID_DIMENSIONS");
  assert.throws(() => validateBoard([[2, 2, 4, 4, 8], E(), E(), E()]), (e) => e.code === "INVALID_DIMENSIONS");
  assert.throws(() => validateBoard("nope"), (e) => e.code === "INVALID_DIMENSIONS");
});

test("validation: negative / nonfinite / non-integer / non-power-of-two tiles are refused", () => {
  const bad = [
    [[-2, 0, 0, 0], E(), E(), E()],
    [[1.5, 0, 0, 0], E(), E(), E()],
    [[NaN, 0, 0, 0], E(), E(), E()],
    [[Infinity, 0, 0, 0], E(), E(), E()],
    [[3, 0, 0, 0], E(), E(), E()],
    [[65536, 0, 0, 0], E(), E(), E()],
    [["2", 0, 0, 0], E(), E(), E()],
  ];
  for (const board of bad) {
    assert.throws(() => validateBoard(board), (e) => e instanceof PracticeBoardError && e.code === "INVALID_VALUE", JSON.stringify(board[0][0]));
  }
});

test("validation: the ambiguous value 1 is refused (would encode as empty)", () => {
  assert.throws(
    () => validateBoard([[1, 0, 0, 0], E(), E(), E()]),
    (e) => e instanceof PracticeBoardError && e.code === "AMBIGUOUS_VALUE",
  );
});

test("validation: legal extremes 2 and 32768 pass", () => {
  const ok = validateBoard([[2, 32768, 0, 0], E(), E(), E()]);
  assert.deepEqual(ok, [[2, 32768, 0, 0], E(), E(), E()]);
});

test("the engine contract matches the parent FIX-1 BoardEncoder (values encoding)", () => {
  const board = [[2, 4, 0, 0], [1024, 0, 0, 0], E(), E()];
  // Parent encoder accepts the same boards the practice engine accepts...
  assert.deepEqual(BoardEncoder.toExponentArray(board, { encoding: "values" }), [1, 2, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // ...and rejects the same ambiguous cell with the same classification.
  assert.throws(() => BoardEncoder.toExponentArray([[1, 0, 0, 0], E(), E(), E()], { encoding: "values" }), (e) => e instanceof BoardEncodingError && e.code === "AMBIGUOUS_VALUE");
  assert.throws(() => BoardEncoder.toExponentArray([[-2, 0, 0, 0], E(), E(), E()], { encoding: "values" }), (e) => e instanceof BoardEncodingError);
});

test("250 seeded random boards: engine transitions agree with the parent reference", () => {
  const rng = mulberry32(20261011);
  for (let i = 0; i < 250; i += 1) {
    const board = Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, () => {
        const roll = rng();
        if (roll < 0.55) return 0;
        return 2 ** (1 + Math.floor(rng() * 9)); // 2..512
      }),
    );
    for (const dir of DIRS) {
      const got = applyMove(board, dir);
      const expected = refSimulateMove(board, dir);
      assert.deepEqual(got.board, expected, `board ${i} dir ${dir}`);
      assert.equal(got.moved, refIsValidMove(board, dir), `board ${i} dir ${dir} moved flag`);
    }
    assert.equal(isGameOver(board), refIsGameOver(board), `board ${i} game over`);
  }
});

test("250 seeded random boards: engine transitions agree with the solver MOVE_SIMULATORS", () => {
  const rng = mulberry32(777);
  for (let i = 0; i < 250; i += 1) {
    const board = Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, () => {
        const roll = rng();
        if (roll < 0.5) return 0;
        return 2 ** (1 + Math.floor(rng() * 10));
      }),
    );
    for (const dir of DIRS) {
      const got = applyMove(board, dir);
      const expected = MOVE_SIMULATORS[dir](board);
      assert.deepEqual(got.board, expected, `board ${i} dir ${dir}`);
    }
  }
});

test("defaultSpawn is deterministic: first empty cell row-major, value 2", () => {
  assert.deepEqual(defaultSpawn([[2, 2, 2, 2], E(), E(), E()]), { r: 1, c: 0, value: 2 });
  assert.deepEqual(defaultSpawn([[0, 4, 0, 0], E(), E(), E()]), { r: 0, c: 0, value: 2 });
  const full = [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]];
  assert.equal(defaultSpawn(full), null);
});

test("applySpawn refuses occupied cells, out-of-range cells, and values other than 2/4", () => {
  const board = [[2, 0, 0, 0], E(), E(), E()];
  assert.throws(() => applySpawn(board, { r: 0, c: 0, value: 2 }), (e) => e.code === "SPAWN_INVALID");
  assert.throws(() => applySpawn(board, { r: 0, c: 1, value: 8 }), (e) => e.code === "SPAWN_INVALID");
  assert.throws(() => applySpawn(board, { r: -1, c: 0, value: 2 }), (e) => e.code === "SPAWN_INVALID");
  assert.throws(() => applySpawn(board, { r: 0, c: 4, value: 2 }), (e) => e.code === "SPAWN_INVALID");
  assert.throws(() => applySpawn(board, { r: 0, c: 1, value: 0 }), (e) => e.code === "SPAWN_INVALID");
});

test("emptyCells and maxTile behave on value-encoded boards", () => {
  const board = [[2, 0, 4, 0], E(), [128, 0, 0, 0], E()];
  assert.equal(emptyCells(board).length, 13);
  assert.equal(maxTile(board), 128);
});
