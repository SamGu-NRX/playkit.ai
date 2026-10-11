/**
 * Replay verification test: a scripted run's committed records must replay
 * exactly against the frozen spawn histories — per-step progression and final
 * boards. Also asserts replay catches a tampered record.
 * Run: node --test experiments/solver-budgets/tests/replay.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ScriptedBinding } from "../lib/engines.mjs";
import { playGame } from "../lib/runner.mjs";
import { replayGame, replayRun } from "../lib/replay.mjs";
import { generateSpawnHistory } from "../lib/spawn-history.mjs";

test("committed scripted records replay exactly", async () => {
  const history = generateSpawnHistory([51, 52], 6000, 900);
  const records = [];
  for (const seed of [51, 52]) {
    const binding = new ScriptedBinding(Array.from({ length: 4000 }, () => [0, 3, 2, 1]));
    await binding.start();
    binding.id = "scripted";
    records.push(
      await playGame({
        binding,
        fallbackBinding: null,
        seed,
        spawnPairs: history.games[String(seed)],
        timeBudgetMs: 200,
        maxMoves: 4000,
      }),
    );
    await binding.close();
  }

  const report = replayRun(records, history);
  assert.equal(report.totalGames, 2);
  assert.equal(report.agreed, 2, `replay disagreements: ${JSON.stringify(report.disagreements)}`);
  assert.equal(report.finalBoardAgreement, 1);
});

test("replay detects a tampered record", async () => {
  const history = generateSpawnHistory([61], 6000, 901);
  const binding = new ScriptedBinding(Array.from({ length: 4000 }, () => [1, 2, 3, 0]));
  await binding.start();
  binding.id = "scripted";
  const record = await playGame({
    binding,
    fallbackBinding: null,
    seed: 61,
    spawnPairs: history.games["61"],
    timeBudgetMs: 200,
    maxMoves: 4000,
  });
  await binding.close();

  const clean = replayGame(record, history.games["61"]);
  assert.equal(clean.agrees, true);

  const tampered = structuredClone(record);
  tampered.moves[5].dirApplied = (tampered.moves[5].dirApplied + 1) % 4;
  const dirty = replayGame(tampered, history.games["61"]);
  assert.equal(dirty.agrees, false);
  assert.ok(dirty.firstDivergence, "tamper must be localized to the edited move");
});
