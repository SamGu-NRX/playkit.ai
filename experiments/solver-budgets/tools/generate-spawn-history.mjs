#!/usr/bin/env node
/**
 * Generate experiments/solver-budgets/spawn-history.json: per-seed frozen
 * streams of (uCell, uValue) draws — 32-bit random draws consumed in order by
 * the deterministic rule in lib/spawn-history.mjs (empty-cell selection with
 * the standard 10% four-tile odds). Streams are seeded per game seed and
 * frozen before any arm is evaluated; regenerate rather than edit.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateSpawnHistory } from "../lib/spawn-history.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const SEEDS = [
  102390421, 748250013, 2184029351, 1405507563, 920410571, 3049172549,
  558014027, 1817759143, 2641089319, 432697811, 3319042651, 712205321,
  2095813883, 1645901357, 3802694791, 843329821, 2957014493, 1192047301,
  2675890139, 615494003,
];
const MAX_MOVES_PER_GAME = 5000; // matches manifest.budgets.maxMovesPerGame

const history = generateSpawnHistory(SEEDS, MAX_MOVES_PER_GAME);
const outPath = path.join(here, "../spawn-history.json");
writeFileSync(outPath, `${JSON.stringify(history, null, 1)}\n`);
process.stdout.write(
  `wrote ${outPath} (${Object.keys(history.games).length} games, ${2 + MAX_MOVES_PER_GAME} draws/game, streams frozen before any arm was evaluated)\n`,
);
