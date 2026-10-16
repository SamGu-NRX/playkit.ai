/**
 * Sliding-puzzle instance generation. Every random choice comes from the core
 * RNG seeded by the episode seed — no Math.random, no clocks — so a (tier,
 * seed) pair always produces the same instance and the same par.
 *
 * Two generators:
 *
 * - `generateUniformSolvable`: a uniformly random solvable permutation (used
 *   for the 3 x 3 tier, whose whole state space BFS can verify).
 * - `generateBanded`: a seeded random walk from the goal (no immediate
 *   undos), rejecting candidates whose proven-optimal length falls outside
 *   the tier's band (used for the 4 x 4 tiers). Walking from the goal keeps
 *   every candidate solvable by construction and biases the distance
 *   distribution toward the band, so resets typically need one or two IDA*
 *   solves instead of hundreds of uniform rejections.
 *
 * Alternatives considered and rejected:
 * - Uniform random 4 x 4 permutations with band rejection: uniform instances
 *   average ~53 optimal moves, so the 40-49 band rejects most candidates at
 *   the deep end of IDA*, the most expensive place to solve — resets would be
 *   seconds to minutes.
 * - Precomputed instance tables keyed by seed: turns "procedural, cannot be
 *   memorized" (gauntlet/docs/DESIGN.md section 7) into a static, memorizable
 *   artifact and grows the repo for every tier band.
 *
 * @module
 */

import {
  applyTileMove,
  DIRECTIONS,
  goalBoard,
  heuristicLowerBound,
  isSolved,
  isSolvable,
  solve,
} from './solver.js';
import { streamFromSeed } from '../../core/rng.js';

/** @import { RngStream } from '../../core/rng.js' */
/** @import { Direction } from './solver.js' */

/** Index of the direction that undoes each direction. */
const OPPOSITE = [1, 0, 3, 2];

/**
 * @typedef {object} SlidingInstance
 * @property {number[][]} board Nested board, blank = 0.
 * @property {number} par Proven-optimal move count.
 * @property {number} attempts Rejection attempts used.
 */

/**
 * A uniformly random solvable, non-solved permutation.
 * @param {number} size
 * @param {string} seed
 * @returns {SlidingInstance}
 */
export function generateUniformSolvable(size, seed) {
  const stream = streamFromSeed(`${seed}/uniform`);
  const tiles = [];
  for (let v = 1; v < size * size; v++) tiles.push(v);
  tiles.push(0);
  let attempts = 0;
  for (;;) {
    attempts++;
    const flat = stream.shuffle(tiles);
    /** @type {number[][]} */
    const board = [];
    for (let r = 0; r < size; r++) board.push(flat.slice(r * size, (r + 1) * size));
    if (!isSolvable(board) || isSolved(board)) continue;
    const result = solve(board);
    if (result.status !== 'solved') continue; // cannot happen after the parity check
    return { board, par: result.length, attempts };
  }
}

/**
 * One no-undo random walk from the goal board.
 * @param {number} size
 * @param {number} length
 * @param {RngStream} stream
 * @returns {number[][]}
 */
export function randomWalkFromGoal(size, length, stream) {
  let board = goalBoard(size);
  let last = -1;
  for (let step = 0; step < length; step++) {
    /** @type {number[]} */
    const candidates = [];
    for (let d = 0; d < DIRECTIONS.length; d++) {
      if (last !== -1 && d === OPPOSITE[last]) continue;
      if (applyTileMove(board, DIRECTIONS[d]) !== null) candidates.push(d);
    }
    const pick = stream.nextInt(0, candidates.length - 1);
    const direction = candidates[pick];
    const next = /** @type {number[][]} */ (applyTileMove(board, DIRECTIONS[direction]));
    board = next;
    last = direction;
  }
  return board;
}

/**
 * A seeded random-walk instance whose proven-optimal length lies in
 * [min, max]. Rejection is deterministic in (seed, params): the RNG stream is
 * threaded through every attempt, so the accepted instance and its par are
 * pure functions of the seed.
 *
 * @param {number} size Board width (4 for the 15-puzzle tiers).
 * @param {{ min: number, max: number, walkLength: number, maxAttempts?: number }} band
 * @param {string} seed
 * @returns {SlidingInstance}
 * @throws {Error} when no candidate lands in the band within maxAttempts.
 */
export function generateBanded(size, band, seed) {
  const maxAttempts = band.maxAttempts ?? 400;
  const stream = streamFromSeed(`${seed}/banded`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const board = randomWalkFromGoal(size, band.walkLength, stream);
    // The heuristic is a lower bound on the optimal length, so candidates that
    // cannot reach the band are rejected without running the solver.
    if (heuristicLowerBound(board) > band.max) continue;
    const result = solve(board);
    if (result.status !== 'solved') continue;
    if (result.length < band.min || result.length > band.max) continue;
    return { board, par: result.length, attempts: attempt };
  }
  throw new Error(
    `generateBanded: no instance with optimal length in [${band.min}, ${band.max}] after ${maxAttempts} attempts (seed ${seed})`
  );
}
