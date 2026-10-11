/**
 * Move-log tests: canonical byte-identical round trip, strict refusal
 * matrix (wrong / incomplete / corrupt logs are refused, never repaired),
 * and replay verification.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLog,
  appendMove,
  serializeLog,
  parseLog,
  verifyDocument,
  finalBoardOf,
  currentBoard,
  PracticeLogError,
} from "../js/log.mjs";
import { DIRECTIONS } from "../js/engine.mjs";

const E = () => [0, 0, 0, 0];

function sampleDoc() {
  const doc = createLog({ initialBoard: [[2, 2, 4, 4], E(), E(), E()], backendLabel: "test" });
  appendMove(doc, {
    direction: DIRECTIONS.LEFT,
    spawn: { r: 0, c: 2, value: 2 },
    solver: { backend: "fallback-naive", order: [3, 0, 1, 2], chosen: 3 },
  });
  appendMove(doc, {
    direction: DIRECTIONS.RIGHT,
    spawn: { r: 1, c: 0, value: 4 },
    solver: { backend: "fallback-naive", order: [1, 3, 0, 2], chosen: 1 },
  });
  return doc;
}

test("round trip: serialize -> parse -> serialize is byte-identical; parse deep-equals the live doc", () => {
  const doc = sampleDoc();
  const text = serializeLog(doc);
  const parsed = parseLog(text);
  assert.deepEqual(parsed, doc);
  assert.equal(serializeLog(parsed), text);
});

test("round trip: a two-move game replays to the recorded score and final board", () => {
  const doc = sampleDoc();
  const result = verifyDocument(doc);
  assert.equal(result.agrees, true);
  assert.equal(result.score, doc.score);
  assert.deepEqual(result.finalBoard, finalBoardOf(doc));
  // Move 1: [2,2,4,4] -> [4,8], +12, spawn 2 at (0,2) -> [4,8,2,0]
  assert.equal(doc.moves[0].scoreGain, 12);
  assert.deepEqual(doc.moves[0].boardAfter, [[4, 8, 0, 0], E(), E(), E()]);
  // Move 2: RIGHT shifts [4,8,2,0] -> [0,4,8,2], no merges, +0.
  assert.equal(doc.moves[1].scoreGain, 0);
});

test("cumulative score equals the sum of merge gains", () => {
  const doc = createLog({ initialBoard: [[2, 2, 4, 4], E(), E(), E()] });
  appendMove(doc, { direction: DIRECTIONS.LEFT, spawn: { r: 0, c: 2, value: 2 }, solver: { backend: "manual", order: [], chosen: 3 } });
  assert.equal(doc.score, 12);
});

function expectRefusal(text, code) {
  assert.throws(
    () => parseLog(text),
    (e) => {
      assert.ok(e instanceof PracticeLogError, `expected PracticeLogError, got ${e?.name}: ${e?.message}`);
      assert.equal(e.code, code, `expected code ${code}, got ${e.code}: ${e.message}`);
      return true;
    },
    `expected refusal ${code}`,
  );
}

test("refusal matrix: syntax, kind, version, encoding, dimensions, unknown fields, missing fields", () => {
  expectRefusal("{oops", "SYNTAX_INVALID");
  expectRefusal("[]", "DOCUMENT_INVALID");
  expectRefusal("42", "DOCUMENT_INVALID");
  const doc = sampleDoc();
  const bad = (mutate) => {
    const copy = JSON.parse(serializeLog(doc));
    mutate(copy);
    return JSON.stringify(copy, null, 2) + "\n";
  };
  expectRefusal(bad((d) => { d.kind = "something-else"; }), "KIND_MISMATCH");
  expectRefusal(bad((d) => { d.logVersion = 2; }), "VERSION_UNSUPPORTED");
  expectRefusal(bad((d) => { d.encoding = "exponents"; }), "ENCODING_MISMATCH");
  expectRefusal(bad((d) => { d.boardSize = 5; }), "DIMENSIONS_MISMATCH");
  expectRefusal(bad((d) => { d.spawnPolicy = "whatever"; }), "FIELD_MISSING");
  expectRefusal(bad((d) => { delete d.moves; }), "FIELD_MISSING");
  expectRefusal(bad((d) => { d.notes = "extra"; }), "CORRUPT_LOG");
  expectRefusal(bad((d) => { d.moves[0].extra = 1; }), "CORRUPT_LOG");
  expectRefusal(bad((d) => { d.initialBoard[0][0] = 1; }), "AMBIGUOUS_VALUE");
  expectRefusal(bad((d) => { d.initialBoard[0][0] = -2; }), "INVALID_VALUE");
  expectRefusal(bad((d) => { d.initialBoard[2] = [0, 0, 0]; }), "INVALID_DIMENSIONS");
});

test("refusal matrix: transitions, boards, scores, spawns, solver records, directions", () => {
  const doc = sampleDoc();
  const bad = (mutate) => {
    const copy = JSON.parse(serializeLog(doc));
    mutate(copy);
    return JSON.stringify(copy, null, 2) + "\n";
  };
  expectRefusal(bad((d) => { d.moves[0].direction = 4; }), "UNKNOWN_DIRECTION");
  expectRefusal(bad((d) => { d.moves[0].boardAfter[0][0] = 44; }), "BOARD_MISMATCH");
  expectRefusal(bad((d) => { d.moves[0].boardAfter[0] = [8, 4, 0, 0]; }), "BOARD_MISMATCH");
  expectRefusal(bad((d) => { d.moves[0].scoreGain = 11; }), "SCORE_MISMATCH");
  expectRefusal(bad((d) => { d.moves[1].scoreGain = 0; }), "SCORE_MISMATCH");
  expectRefusal(bad((d) => { d.score = 999; }), "SCORE_MISMATCH");
  expectRefusal(bad((d) => { d.moves[0].spawn = { r: 0, c: 0, value: 2 }; }), "SPAWN_INVALID");
  expectRefusal(bad((d) => { d.moves[0].spawn = { r: 0, c: 2, value: 8 }; }), "SPAWN_INVALID");
  expectRefusal(bad((d) => { d.moves[0].spawn = { r: 9, c: 0, value: 2 }; }), "SPAWN_INVALID");
  expectRefusal(bad((d) => { d.moves[0].spawn = null; }), "INCOMPLETE_MOVE");
  expectRefusal(bad((d) => { delete d.moves[0].solver; }), "SOLVER_RECORD_MISSING");
  expectRefusal(bad((d) => { d.moves[0].solver.backend = ""; }), "SOLVER_RECORD_MISSING");
  expectRefusal(bad((d) => { d.moves[0].solver.order = [3, 3, 0, 1]; }), "CORRUPT_LOG");
  expectRefusal(bad((d) => { d.moves[0].solver.chosen = 9; }), "CORRUPT_LOG");
});

test("refusal: a recorded no-op move is an illegal transition", () => {
  const text = JSON.stringify({
    kind: "playkit.practice-board.log",
    logVersion: 1,
    boardSize: 4,
    encoding: "values",
    spawnPolicy: "explicit-user-selected",
    defaultSpawnPolicy: "first-empty-row-major-2",
    createdUtc: "2026-10-11T00:00:00.000Z",
    backendLabel: "test",
    initialBoard: [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]],
    score: 0,
    moves: [
      { index: 0, direction: 3, boardAfter: [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]], spawn: null, scoreGain: 0, solver: { backend: "manual", chosen: 3 } },
    ],
  }, null, 2) + "\n";
  expectRefusal(text, "ILLEGAL_TRANSITION");
});

test("appendMove refuses no-ops and never records them", () => {
  const doc = createLog({ initialBoard: [[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]] });
  assert.throws(
    () => appendMove(doc, { direction: DIRECTIONS.LEFT, spawn: null, solver: { backend: "manual" } }),
    (e) => e.code === "ILLEGAL_TRANSITION",
  );
  assert.equal(doc.moves.length, 0);
  assert.equal(doc.score, 0);
});

test("appendMove refuses a missing spawn while empty cells exist (explicit history required)", () => {
  const doc = createLog({ initialBoard: [[2, 2, 4, 4], E(), E(), E()] });
  assert.throws(
    () => appendMove(doc, { direction: DIRECTIONS.LEFT, spawn: null, solver: { backend: "manual" } }),
    (e) => e.code === "INCOMPLETE_MOVE",
  );
  assert.equal(doc.moves.length, 0);
});

test("currentBoard folds spawns; verifyDocument catches a tampered live document", () => {
  const doc = sampleDoc();
  const folded = currentBoard(doc);
  assert.equal(folded[0][2], 2); // spawn from move 0
  assert.equal(folded[1][0], 4); // spawn from move 1
  const tampered = JSON.parse(serializeLog(doc));
  tampered.moves[0].boardAfter[0][1] = 7;
  assert.throws(() => verifyDocument(tampered), (e) => e.code === "BOARD_MISMATCH");
});
