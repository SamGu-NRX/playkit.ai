/**
 * Tier bands, quality filters and the deterministic selection rule for the
 * Lichess chess-puzzles environment. Pure JS (no `node:*`): the game module,
 * the sampler script and the tests all import this file.
 *
 * ## Selection rule
 *
 * Candidates are dump rows that pass the quality filters below, grouped into
 * the tier whose rating band contains the row's rating. Within a tier, every
 * candidate is keyed by `fnv1a64("<salt>/<PuzzleId>")` and the sample is the
 * first `perTier` rows ordered by (hash, PuzzleId). The same salt and dump
 * always produce the same sample. The eval run repeats the procedure with a
 * different salt and with the public sample excluded, so the two splits are
 * disjoint by construction.
 *
 * @module
 */

import { fnv1a64 } from '../../core/canonical.js';

/**
 * One rating band. `min` inclusive, `max` exclusive; `max` is null for the
 * open-ended top band.
 *
 * @typedef {object} TierBand
 * @property {string} id
 * @property {number} rank
 * @property {number} min
 * @property {number | null} max
 */

/** The six rating bands, easiest first. Ranks are consecutive from 1. */
export const TIERS = [
  /** @type {TierBand} */ ({ id: 'r0400', rank: 1, min: 400, max: 1000 }),
  /** @type {TierBand} */ ({ id: 'r1000', rank: 2, min: 1000, max: 1400 }),
  /** @type {TierBand} */ ({ id: 'r1400', rank: 3, min: 1400, max: 1800 }),
  /** @type {TierBand} */ ({ id: 'r1800', rank: 4, min: 1800, max: 2200 }),
  /** @type {TierBand} */ ({ id: 'r2200', rank: 5, min: 2200, max: 2600 }),
  /** @type {TierBand} */ ({ id: 'r2600', rank: 6, min: 2600, max: null }),
];

/** @returns {string[]} The tier ids, easiest first. */
export function tierIds() {
  return TIERS.map((tier) => tier.id);
}

/**
 * The band containing `rating`.
 *
 * @param {number} rating
 * @returns {TierBand}
 * @throws {Error} when the rating is below the lowest band's floor (400).
 */
export function tierForRating(rating) {
  for (const tier of TIERS) {
    if (rating >= tier.min && (tier.max === null || rating < tier.max)) {
      return tier;
    }
  }
  throw new Error(
    `no tier band contains rating ${rating} (bands start at 400); the puzzle cannot be tiered`
  );
}

/**
 * Quality filters applied to every dump row before selection. Each value is
 * justified in data/SOURCE.md and in the PR; changing one changes the sample
 * and must be re-justified.
 *
 * @typedef {object} QualityFilters
 * @property {number} maxRatingDeviation
 * @property {number} minPopularity
 * @property {number} minNbPlays
 * @property {number} maxPlayerMoves
 */

/**
 * - `maxRatingDeviation`: the rating is the human-calibration signal, so only
 *   puzzles whose Lichess rating has converged (RD <= 100) are sampled.
 * - `minPopularity`: Lichess's 0-100 community vote; >= 90 drops puzzles the
 *   puzzle community flagged as broken or dislikeable.
 * - `minNbPlays`: at least 100 human attempts, so the calibration reflects
 *   measurement rather than a handful of games.
 * - `maxPlayerMoves`: bounds the episode horizon (maxActions = player moves
 *   + 2, so at most 8 agent actions per episode).
 *
 * @type {QualityFilters}
 */
export const QUALITY = {
  maxRatingDeviation: 100,
  minPopularity: 90,
  minNbPlays: 100,
  maxPlayerMoves: 6,
};

/** How many puzzles per tier (public and eval alike). */
export const PER_TIER = 60;

/**
 * A puzzle record, exactly the fields the committed data files carry.
 * `Popularity` and `NbPlays` are optional: they are filter inputs during
 * sampling (aggregated in data/SOURCE.md) and are NOT committed per row.
 *
 * @typedef {object} PuzzleRecord
 * @property {string} PuzzleId
 * @property {string} FEN Position before the opponent's move.
 * @property {string} Moves Full UCI solution line; the first move is the
 *   opponent's.
 * @property {number} Rating
 * @property {number} RatingDeviation
 * @property {number} [Popularity]
 * @property {number} [NbPlays]
 * @property {string} Themes
 * @property {string} GameUrl
 */

/**
 * A dump row as parsed from the Lichess CSV: the committed fields plus the
 * two filter inputs, all present. Scan-side code uses this; the committed
 * data files carry only the PuzzleRecord subset.
 *
 * @typedef {object} DumpRecord
 * @property {string} PuzzleId
 * @property {string} FEN Position before the opponent's move.
 * @property {string} Moves Full UCI solution line; the first move is the
 *   opponent's.
 * @property {number} Rating
 * @property {number} RatingDeviation
 * @property {number} Popularity
 * @property {number} NbPlays
 * @property {string} Themes
 * @property {string} GameUrl
 */

/**
 * Number of player (solving-side) moves in a solution line: the line starts
 * with the opponent's pre-move, so player moves sit at odd indices.
 *
 * @param {string[]} moves UCI moves of the line.
 * @returns {number}
 */
export function playerMoveCount(moves) {
  return Math.floor(moves.length / 2);
}

/**
 * Whether the solution line has the shape the environment relies on: even
 * length, so it ends on a player move (Lichess lines end with the winning
 * side's move).
 *
 * @param {DumpRecord} record
 * @returns {boolean}
 */
export function lineShapeOk(record) {
  const moves = record.Moves.split(' ');
  return moves.length >= 2 && moves.length % 2 === 0 && moves.every((m) => m.length >= 4);
}

/**
 * Quality-filter verdict: `{ ok: true }` or `{ ok: false, reason }`.
 *
 * @param {DumpRecord} record
 * @returns {{ ok: boolean, reason?: string }}
 */
export function passesQualityFilters(record) {
  if (record.RatingDeviation > QUALITY.maxRatingDeviation) {
    return { ok: false, reason: `RatingDeviation ${record.RatingDeviation} > ${QUALITY.maxRatingDeviation}` };
  }
  if (record.Popularity < QUALITY.minPopularity) {
    return { ok: false, reason: `Popularity ${record.Popularity} < ${QUALITY.minPopularity}` };
  }
  if (record.NbPlays < QUALITY.minNbPlays) {
    return { ok: false, reason: `NbPlays ${record.NbPlays} < ${QUALITY.minNbPlays}` };
  }
  if (!lineShapeOk(record)) {
    return { ok: false, reason: `solution line "${record.Moves}" has the wrong shape` };
  }
  if (playerMoveCount(record.Moves.split(' ')) > QUALITY.maxPlayerMoves) {
    return { ok: false, reason: `line has more than ${QUALITY.maxPlayerMoves} player moves` };
  }
  return { ok: true };
}

/**
 * The selection key: a seeded hash of the puzzle id. The same salt and id
 * always hash to the same value, which is what makes the sample
 * deterministic and the eval sample reproducible from the (secret) salt.
 *
 * @param {string} salt
 * @param {string} puzzleId
 * @returns {string} 16 hex digits.
 */
export function selectionHash(salt, puzzleId) {
  return fnv1a64(`${salt}/${puzzleId}`);
}

/**
 * Select the sample for every tier: group quality-passing candidates by
 * band, order each group by (selectionHash, PuzzleId), and take the first
 * `perTier`. Records must already be legality-checked by the caller.
 *
 * @param {PuzzleRecord[]} candidates Quality-passing, legality-checked records.
 * @param {string} salt
 * @param {number} [perTier] Defaults to PER_TIER.
 * @param {(record: PuzzleRecord) => boolean} [exclude] Extra exclusion (the
 *   eval run excludes the public sample's ids).
 * @returns {Map<string, PuzzleRecord[]>} Tier id -> selection in sample order.
 * @throws {Error} when a tier has fewer than `perTier` candidates.
 */
export function selectSamples(candidates, salt, perTier = PER_TIER, exclude = undefined) {
  /** @type {Map<string, PuzzleRecord[]>} */
  const byTier = new Map(TIERS.map((tier) => [tier.id, []]));
  for (const record of candidates) {
    if (exclude && exclude(record)) continue;
    const tier = tierForRating(record.Rating);
    byTier.get(tier.id)?.push(record);
  }
  for (const [tierId, group] of byTier) {
    group.sort((a, b) => {
      const ha = selectionHash(salt, a.PuzzleId);
      const hb = selectionHash(salt, b.PuzzleId);
      if (ha !== hb) return ha < hb ? -1 : 1;
      return a.PuzzleId < b.PuzzleId ? -1 : a.PuzzleId > b.PuzzleId ? 1 : 0;
    });
    if (group.length < perTier) {
      throw new Error(
        `tier ${tierId}: only ${group.length} quality-passing candidates, need ${perTier}; relax a filter or widen the band`
      );
    }
    byTier.set(tierId, group.slice(0, perTier));
  }
  return byTier;
}
