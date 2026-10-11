#!/usr/bin/env node
/**
 * CLI for the solver-budgets study.
 *
 *   node experiments/solver-budgets/run.mjs --manifest experiments/solver-budgets/manifest.json
 *       Play every (available arm, game) cell; write raw per-game records,
 *       per-arm control counts, identity, and a run summary under
 *       experiments/solver-budgets/results/run-<timestamp>/.
 *
 *   node experiments/solver-budgets/run.mjs --replay <runDir>
 *       Replay every recorded game against the frozen spawn histories;
 *       write replay-agreement.json into the run dir.
 *
 *   node experiments/solver-budgets/run.mjs --analyze <runDir>
 *       Compute paired bootstrap intervals vs the naive baseline;
 *       write paired-intervals.json into the run dir.
 *
 * Arms run only when their build actually works; unavailable arms are
 * recorded as not-run with the reason — never estimated.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NaiveBinding, NativeCppBinding, WasmBinding } from "./lib/engines.mjs";
import { AdapterBinding } from "./lib/adapter-binding.mjs";
import { playGame, controlCounts } from "./lib/runner.mjs";
import { replayRun } from "./lib/replay.mjs";
import { pairedIntervals } from "./lib/stats.mjs";
import { buildIdentity } from "./lib/identity.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "../..");
const nativeBinary = path.join(here, "build/native-solver");
const wasmModule = path.join(here, "build/wasm/solver.mjs");
const wasmBinaryPath = path.join(here, "build/wasm/solver.wasm");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--manifest") args.manifest = argv[i + 1];
    if (argv[i] === "--replay") args.replay = argv[i + 1];
    if (argv[i] === "--analyze") args.analyze = argv[i + 1];
  }
  return args;
}

/** Build the bindings for the arms a manifest declares, skipping arms whose
 *  builds do not work. Returns { bindings: Map, notRun: Array }. */
export async function createBindings(manifest) {
  const bindings = new Map();
  const notRun = [];

  for (const arm of manifest.arms) {
    if (arm.engine === "naive") {
      const binding = new NaiveBinding();
      await binding.start();
      binding.id = arm.id;
      bindings.set(arm.id, binding);
    } else if (arm.engine === "native-cpp") {
      if (!existsSync(nativeBinary)) {
        notRun.push({ arm: arm.id, reason: "native binary not built (run native/build-native.sh)" });
        continue;
      }
      const binding = new NativeCppBinding(nativeBinary, arm.strategy);
      try {
        await binding.start();
      } catch (error) {
        notRun.push({ arm: arm.id, reason: `native bridge failed to start: ${error.message}` });
        continue;
      }
      binding.id = arm.id;
      bindings.set(arm.id, binding);
    } else if (arm.engine === "wasm") {
      if (!WasmBinding.available(wasmModule, wasmBinaryPath)) {
        notRun.push({
          arm: arm.id,
          reason: "wasm build not available (emscripten build of solver.wasm did not succeed locally)",
        });
        continue;
      }
      const binding = new WasmBinding(wasmModule, wasmBinaryPath, arm.strategy);
      try {
        await binding.start();
      } catch (error) {
        notRun.push({ arm: arm.id, reason: `wasm binding failed to start: ${error.message}` });
        continue;
      }
      binding.id = arm.id;
      bindings.set(arm.id, binding);
    } else if (arm.engine === "adapter") {
      const binding = new AdapterBinding(arm.strategy);
      try {
        await binding.start();
      } catch (error) {
        notRun.push({ arm: arm.id, reason: `adapter failed to start: ${error.message}` });
        continue;
      }
      binding.id = arm.id;
      bindings.set(arm.id, binding);
    } else {
      notRun.push({ arm: arm.id, reason: `unknown engine kind ${arm.engine}` });
    }
  }

  return { bindings, notRun };
}

function loadRecords(resultsDir) {
  const rawDir = path.join(resultsDir, "raw");
  if (!existsSync(rawDir)) throw new Error(`no raw/ under ${resultsDir}`);
  const records = [];
  for (const armDir of readdirSync(rawDir)) {
    const armPath = path.join(rawDir, armDir);
    for (const file of readdirSync(armPath)) {
      if (file.endsWith(".json")) {
        records.push(JSON.parse(readFileSync(path.join(armPath, file), "utf8")));
      }
    }
  }
  return records;
}

async function runManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.__path = path.relative(repoRoot, manifestPath);

  const spawnHistory = JSON.parse(
    readFileSync(path.join(path.dirname(manifestPath), manifest.games.spawnHistoryFile), "utf8"),
  );

  const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(here, "results", `run-${runStamp}`);
  mkdirSync(runDir, { recursive: true });

  const { bindings, notRun } = await createBindings(manifest);
  // Pre-run control: the naive binding must be available — it is the study's
  // baseline and the fallback engine.
  if (!bindings.has("naive")) {
    throw new Error("naive binding unavailable — cannot run the study without its baseline arm");
  }
  const naiveBinding = bindings.get("naive");

  const perArm = {};
  for (const [armId, binding] of bindings) {
    const armRecords = [];
    for (const seed of manifest.games.seeds) {
      const pairs = spawnHistory.games[String(seed)];
      if (!pairs) throw new Error(`frozen spawn history missing for seed ${seed}`);
      const record = await playGame({
        binding,
        fallbackBinding: armId === "naive" ? null : naiveBinding,
        seed,
        spawnPairs: pairs,
        timeBudgetMs: manifest.budgets.timeBudgetMsPerMove,
        maxMoves: manifest.budgets.maxMovesPerGame,
      });
      armRecords.push(record);
      process.stdout.write(
        `[${armId}] seed ${seed}: score ${record.finalScore}, max tile ${record.maxTileReached}, moves ${record.moveCount} (${record.gameOver ? "game over" : record.truncated ? "truncated" : "spawn-exhausted"})\n`,
      );
    }
    perArm[armId] = { records: armRecords, controls: controlCounts(armRecords) };
  }

  for (const binding of bindings.values()) await binding.close();

  const rawDir = path.join(runDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  for (const [armId, { records }] of Object.entries(perArm)) {
    const armDir = path.join(rawDir, armId);
    mkdirSync(armDir, { recursive: true });
    for (const record of records) {
      writeFileSync(path.join(armDir, `game-${record.seed}.json`), JSON.stringify(record, null, 1));
    }
  }

  const summary = {
    manifest: manifest.__path,
    runStartedAt: runStamp,
    budgets: manifest.budgets,
    armsDeclared: manifest.arms.map((arm) => arm.id),
    armsRun: [...bindings.keys()],
    armsNotRun: notRun,
    controls: Object.fromEntries(Object.entries(perArm).map(([armId, { controls }]) => [armId, controls])),
    perArmOutcomes: Object.fromEntries(
      Object.entries(perArm).map(([armId, { records }]) => [
        armId,
        records.map((r) => ({
          seed: r.seed,
          finalScore: r.finalScore,
          maxTileReached: r.maxTileReached,
          moveCount: r.moveCount,
          gameOver: r.gameOver,
          truncated: r.truncated,
        })),
      ]),
    ),
  };
  writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 1));

  const identity = buildIdentity(repoRoot, manifest, [
    { name: "native-solver", path: nativeBinary },
    { name: "wasm-solver", path: wasmBinaryPath },
  ]);
  writeFileSync(path.join(runDir, "identity.json"), JSON.stringify(identity, null, 1));

  process.stdout.write(`\nrun complete: ${runDir}\n`);
  process.stdout.write(`arms run: ${[...bindings.keys()].join(", ")}\n`);
  for (const entry of notRun) {
    process.stdout.write(`arm not run: ${entry.arm} — ${entry.reason}\n`);
  }
}

function replayResults(resultsDir) {
  const manifestPath = path.join(here, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const spawnHistory = JSON.parse(
    readFileSync(path.join(here, manifest.games.spawnHistoryFile), "utf8"),
  );

  const records = loadRecords(resultsDir);
  const report = replayRun(records, spawnHistory);
  writeFileSync(path.join(resultsDir, "replay-agreement.json"), JSON.stringify(report, null, 1));
  process.stdout.write(
    `replay: ${report.agreed}/${report.totalGames} games agree (final-board agreement ${(report.finalBoardAgreement * 100).toFixed(1)}%)\n`,
  );
  if (report.disagreements.length > 0) {
    process.stdout.write(
      `DISAGREEMENTS: ${JSON.stringify(report.disagreements.map(({ arm, seed, firstDivergence }) => ({ arm, seed, firstDivergence })), null, 1)}\n`,
    );
    process.exitCode = 1;
  }
}

function analyzeResults(resultsDir) {
  const records = loadRecords(resultsDir);

  // Budget enforcement at analysis time: an arm with any over-budget move is
  // failed/unavailable — it never enters a paired comparison.
  const overBudgetArms = new Set(
    records.filter((r) => (r.overBudgetMoves ?? 0) > 0).map((r) => r.arm),
  );
  for (const arm of overBudgetArms) {
    process.stdout.write(
      `arm ${arm}: OVER BUDGET — marked failed/unavailable, excluded from paired comparisons\n`,
    );
  }
  if (overBudgetArms.has("naive")) {
    const intervals = {
      error: "baseline arm (naive) exceeded its time budget — no valid comparison possible for this run",
      excludedArms: [...overBudgetArms],
    };
    writeFileSync(path.join(resultsDir, "paired-intervals.json"), JSON.stringify(intervals, null, 1));
    process.exitCode = 1;
    return;
  }
  const usableRecords = records.filter((r) => !overBudgetArms.has(r.arm));

  const intervals = pairedIntervals(usableRecords, { baseline: "naive" });
  intervals.budgetExcludedArms = [...overBudgetArms];
  writeFileSync(path.join(resultsDir, "paired-intervals.json"), JSON.stringify(intervals, null, 1));
  process.stdout.write(`paired intervals written: ${path.join(resultsDir, "paired-intervals.json")}\n`);
  for (const [pair, data] of Object.entries(intervals.pairs ?? {})) {
    const s = data.score;
    process.stdout.write(
      `${pair}: paired score diff mean ${s.meanDiff?.toFixed(1)} (95% CI ${s.ciLow?.toFixed(1)} .. ${s.ciHigh?.toFixed(1)}), n=${s.n}; tile reach W/T/L ${data.tileReachWins}/${data.tileReachTies}/${data.tileReachLosses}\n`,
    );
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.manifest) {
  await runManifest(args.manifest);
} else if (args.replay) {
  replayResults(args.replay);
} else if (args.analyze) {
  analyzeResults(args.analyze);
} else {
  process.stderr.write("usage: run.mjs --manifest <path> | --replay <runDir> | --analyze <runDir>\n");
  process.exit(2);
}
