/**
 * Runner semantics tests (scripted bindings — no solver involved):
 *   - rejection accounting: illegal and no-op orders are rejected and counted
 *   - fallback: timeout and empty-order cases fall back, raw output committed
 *   - determinism: two arms sharing a seed replay identical spawn streams
 *   - spawn exhaustion is declared, never improvised
 * Run: node --test experiments/solver-budgets/tests/runner-semantics.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedBinding } from "../lib/engines.mjs";
import { playGame, controlCounts, classifyRejection } from "../lib/runner.mjs";
import { generateSpawnHistory } from "../lib/spawn-history.mjs";

test("classifyRejection distinguishes illegal from no-op", () => {
  // Every occupied column is bottom-packed and non-mergeable, so Down is the
  // only no-op; Left/Right/Up all change the board.
  const board = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 2, 4, 0],
    [2, 4, 8, 2],
  ];
  assert.equal(classifyRejection(board, 7), "illegal");
  assert.equal(classifyRejection(board, -1), "illegal");
  assert.equal(classifyRejection(board, 2.5), "illegal"); // out of range, even though 2 would be board-changing here
  assert.equal(classifyRejection(board, 2), "no-op"); // Down does not change the board (JS reference: 0=Up, 1=Right, 2=Down, 3=Left)
  assert.equal(classifyRejection(board, 1), null); // Right
  assert.equal(classifyRejection(board, 0), null); // Up
  assert.equal(classifyRejection(board, 3), null); // Left
});

test("scripted arm: rejections counted, first board-changing entry applied", async () => {
  const history = generateSpawnHistory([11], 4000, 777);
  const pairs = history.games["11"];
  // Move 0's order starts with an illegal index and then entries that may or
  // may not change the board; expected values are computed from the reference
  // model so the assertions are board-independent.
  const order0 = [9, 1, 1, 2];
  const { isValidMove } = await import("../../../test/helpers/reference-2048.mjs");
  const { SpawnCursor } = await import("../lib/spawn-history.mjs");
  const firstBoard = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const probeCursor = new SpawnCursor(pairs);
  probeCursor.nextSpawn(firstBoard);
  probeCursor.nextSpawn(firstBoard);
  const expectedRejections0 = [];
  let expectedApplied0 = null;
  for (const dir of order0) {
    if (!Number.isInteger(dir) || dir < 0 || dir > 3) expectedRejections0.push("illegal");
    else if (!isValidMove(firstBoard, dir)) expectedRejections0.push("no-op");
    else {
      expectedApplied0 = dir;
      break;
    }
  }

  const binding = new ScriptedBinding([order0, [9, 2, 3], [0, 1, 2, 3]]);
  await binding.start();
  binding.id = "scripted";
  const record = await playGame({
    binding,
    fallbackBinding: null,
    seed: 11,
    spawnPairs: pairs,
    timeBudgetMs: 200,
    maxMoves: 4,
  });

  assert.equal(record.moves[0].rawOrder.length, order0.length);
  assert.deepEqual(
    record.moves[0].rejections.map((r) => r.reason),
    expectedRejections0,
  );
  assert.equal(record.moves[0].dirApplied, expectedApplied0);
  assert.equal(record.moves[0].fallback, null);

  assert.equal(record.moves[1].rejections[0].reason, "illegal");
  assert.equal(record.moves[1].rejections[0].dir, 9);
  assert.ok(record.moves[1].dirApplied !== null && record.moves[1].dirApplied >= 0 && record.moves[1].dirApplied <= 3);
  assert.equal(record.moves[1].fallback, null);
  await binding.close();
});

test("timeout falls back to canonical order and commits raw output", async () => {
  const history = generateSpawnHistory([12], 4000, 778);
  const pairs = history.games["12"];
  const binding = new ScriptedBinding([[0, 1, 2, 3]], 500); // latency 500 > budget
  await binding.start();
  binding.id = "slow";
  const record = await playGame({
    binding,
    fallbackBinding: null, // canonical Up,Right,Down,Left fallback
    seed: 12,
    spawnPairs: pairs,
    timeBudgetMs: 200,
    maxMoves: 1,
  });

  assert.equal(record.moves.length, 1);
  assert.equal(record.moves[0].timeout, true);
  assert.equal(record.moves[0].fallback.reason, "time-budget-exceeded");
  assert.equal(record.moves[0].fallback.source, "canonical-order");
  assert.deepEqual(record.moves[0].rawOrder, [0, 1, 2, 3]); // raw committed
  await binding.close();
});

test("empty order falls back and is counted", async () => {
  const history = generateSpawnHistory([13], 4000, 779);
  const pairs = history.games["13"];
  const binding = new ScriptedBinding([[], []]);
  await binding.start();
  binding.id = "empty";
  const record = await playGame({
    binding,
    fallbackBinding: null,
    seed: 13,
    spawnPairs: pairs,
    timeBudgetMs: 200,
    maxMoves: 2,
  });
  assert.equal(record.moves[0].fallback.reason, "empty-order");
  const counts = controlCounts([record]);
  assert.equal(counts.fallbacks, 2);
  await binding.close();
});

test("two arms sharing a seed see identical spawn streams", async () => {
  const history = generateSpawnHistory([21], 4000, 780);
  const pairs = history.games["21"];
  const makeRecord = async (id, order) => {
    const binding = new ScriptedBinding(Array.from({ length: 60 }, () => order));
    await binding.start();
    binding.id = id;
    const record = await playGame({
      binding,
      fallbackBinding: null,
      seed: 21,
      spawnPairs: pairs,
      timeBudgetMs: 200,
      maxMoves: 2,
    });
    await binding.close();
    return record;
  };
  const a = await makeRecord("arm-a", [3, 2, 0, 1]);
  const b = await makeRecord("arm-b", [0, 1, 3, 2]);
  assert.deepEqual(a.initialSpawns, b.initialSpawns);
  assert.deepEqual(a.moves.map((m) => m.spawn), b.moves.map((m) => m.spawn));
  // Under cumulative merged-tile scoring, different first moves legitimately
  // earn different points — spawn-stream identity is what this test pins.
});

test("spawn exhaustion is declared, not improvised", async () => {
  const history = generateSpawnHistory([31], 3, 781); // only 3 draws
  const pairs = history.games["31"];
  const binding = new ScriptedBinding(Array.from({ length: 10 }, () => [0, 1, 2, 3]));
  await binding.start();
  binding.id = "starved";
  const record = await playGame({
    binding,
    fallbackBinding: null,
    seed: 31,
    spawnPairs: pairs,
    timeBudgetMs: 200,
    maxMoves: 10,
  });
  assert.equal(record.spawnExhausted, true);
  assert.equal(record.gameOver, false);
  await binding.close();
});

test("game records end only on real game over", async () => {
  // A scripted arm on a real board must end in one of the three declared ways,
  // and a gameOver record must have a dead final board under the reference model.
  const { isGameOver } = await import("../../../test/helpers/reference-2048.mjs");
  const history = generateSpawnHistory([41], 6000, 782);
  const pairs = history.games["41"];
  const binding = new ScriptedBinding(Array.from({ length: 5000 }, () => [2, 0, 3, 1]));
  await binding.start();
  binding.id = "lefty";
  const record = await playGame({
    binding,
    fallbackBinding: null,
    seed: 41,
    spawnPairs: pairs,
    timeBudgetMs: 200,
    maxMoves: 5000,
  });
  if (record.gameOver) {
    assert.ok(isGameOver(record.finalBoard), "gameOver record must have a dead final board");
  } else {
    assert.ok(record.truncated || record.spawnExhausted);
  }
  await binding.close();
});
