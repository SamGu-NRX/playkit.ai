/**
 * Puzzle data access for the chess-puzzles game. Browser-safe: the public
 * sample ships as a generated ES module (so the overlay can load it without
 * `node:*`), and the hidden eval sample is injected at runtime by the
 * Node-only loader in `eval-loader.node.js`. The solution line of an eval
 * puzzle is grader-side data, exactly like the public one: it lives in the
 * game state (so step() can adjudicate) but never in an observation.
 *
 * @module
 */

import { PUZZLES } from './data/public.generated.js';
import { PER_TIER, TIERS, tierForRating } from './selection.js';

/** @import { PuzzleRecord } from './selection.js' */

/**
 * The public sample, grouped by tier, in sample order: index i of a tier's
 * array is the puzzle public seed i resolves to.
 *
 * @type {Map<string, PuzzleRecord[]>}
 */
const publicByTier = new Map(
  TIERS.map((tier) => [tier.id, /** @type {PuzzleRecord[]} */ ([])])
);
for (const record of PUZZLES) {
  const tier = tierForRating(record.Rating);
  const group = publicByTier.get(tier.id);
  if (group) group.push(record);
}

/**
 * The eval sample, populated only by the Node-only loader: tier id -> map of
 * PuzzleId -> record.
 *
 * @type {Map<string, Map<string, PuzzleRecord>>}
 */
const evalByTier = new Map(TIERS.map((tier) => [tier.id, new Map()]));

/** How many public puzzles a tier carries. */
export const PUBLIC_SEEDS = PER_TIER;

for (const [tierId, group] of publicByTier) {
  if (group.length !== PUBLIC_SEEDS) {
    throw new Error(
      `chess-puzzles: the committed public sample for tier ${tierId} has ${group.length} puzzles, expected ${PUBLIC_SEEDS}; regenerate with scripts/sample.js`
    );
  }
}

/**
 * The i-th public puzzle of a tier.
 *
 * @param {string} tierId
 * @param {number} index
 * @returns {PuzzleRecord}
 * @throws {Error} loudly on an out-of-range index or unknown tier.
 */
export function getPublicPuzzle(tierId, index) {
  const group = publicByTier.get(tierId);
  if (!group) {
    throw new Error(
      `chess-puzzles: unknown tier "${tierId}" (tiers: ${TIERS.map((t) => t.id).join(', ')})`
    );
  }
  if (!Number.isInteger(index) || index < 0 || index >= group.length) {
    throw new Error(
      `chess-puzzles: tier ${tierId} has public seeds 0..${group.length - 1}, not ${JSON.stringify(index)}`
    );
  }
  return /** @type {PuzzleRecord} */ (group[index]);
}

/**
 * The highest number of player moves in a tier's public sample; the tier's
 * maxActions is this plus 2.
 *
 * @param {string} tierId
 * @returns {number}
 */
export function publicMaxPlayerMoves(tierId) {
  const group = publicByTier.get(tierId);
  if (!group) {
    throw new Error(`chess-puzzles: unknown tier "${tierId}"`);
  }
  let max = 0;
  for (const record of group) {
    const count = Math.floor(record.Moves.split(' ').length / 2);
    if (count > max) max = count;
  }
  return max;
}

/**
 * Register the eval sample from parsed records. Called by the Node-only
 * loader; calling it again replaces the previous eval sample.
 *
 * @param {PuzzleRecord[]} records
 * @returns {{ total: number, byTier: Record<string, number> }} Counts.
 */
export function registerEvalPuzzles(records) {
  for (const map of evalByTier.values()) map.clear();
  /** @type {Record<string, number>} */
  const byTier = {};
  let total = 0;
  for (const record of records) {
    const tier = tierForRating(record.Rating);
    const map = evalByTier.get(tier.id);
    if (map) {
      map.set(record.PuzzleId, record);
      byTier[tier.id] = (byTier[tier.id] ?? 0) + 1;
      total++;
    }
  }
  return { total, byTier };
}

/** Drop the registered eval sample (used by tests). */
export function clearEvalPuzzles() {
  for (const map of evalByTier.values()) map.clear();
}

/**
 * An eval puzzle by id.
 *
 * @param {string} tierId
 * @param {string} puzzleId
 * @returns {PuzzleRecord}
 * @throws {Error} loudly when the eval sample is not loaded or lacks the id.
 */
export function getEvalPuzzle(tierId, puzzleId) {
  const map = evalByTier.get(tierId);
  if (!map || map.size === 0) {
    throw new Error(
      `chess-puzzles: no eval sample loaded for tier "${tierId}"; call loadEvalPuzzles(path) from eval-loader.node.js (Node only) before resolving eval seeds`
    );
  }
  const record = map.get(puzzleId);
  if (!record) {
    throw new Error(
      `chess-puzzles: eval sample for tier "${tierId}" (${map.size} puzzles) has no puzzle "${puzzleId}"; the seed does not match the loaded eval sample`
    );
  }
  return record;
}
