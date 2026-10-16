/**
 * Node-only loader for the hidden eval sample. This module imports `node:fs`
 * and must NEVER be imported by game code (`index.js`, `puzzles.js`) or by
 * anything the browser overlay loads: harnesses call it under Node to inject
 * the eval sample, then hand `chess-puzzles/<tier>/eval/<PuzzleId>` seeds to
 * the game as usual.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { registerEvalPuzzles } from './puzzles.js';

/** @import { PuzzleRecord } from './selection.js' */

/**
 * Read an eval sample written by `scripts/sample.js --salt-file --eval-out`
 * and register it. Every line is a JSON puzzle record (the same fields as
 * data/public.jsonl).
 *
 * @param {string} path Path to the eval sample JSONL (kept outside the repo).
 * @returns {Promise<{ total: number, byTier: Record<string, number> }>} Counts.
 */
export async function loadEvalPuzzles(path) {
  const text = await readFile(path, 'utf8');
  /** @type {PuzzleRecord[]} */
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    records.push(JSON.parse(line));
  }
  return registerEvalPuzzles(records);
}
