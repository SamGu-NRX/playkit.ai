/**
 * Sokoban level generation by reverse play (pulls).
 *
 * The published level collections carry unclear licenses and can be
 * memorized; generated levels can't. From the seeded RNG the generator:
 *
 * 1. builds a rectangular room (border walls, a few seeded interior walls),
 * 2. places the boxes on the goals (a solved position) and a player anywhere,
 * 3. applies seeded random *pull* moves — the player steps away from a box,
 *    dragging it along — to scramble the solved position.
 *
 * Reversing a pull sequence is always a legal push sequence, so every
 * generated level is solvable by construction; the solver is still run as the
 * proof of record, and a level is kept only when the solver proves it solvable
 * and its optimal move count falls inside the tier's par band.
 *
 * Every random choice comes from the core RNG seeded by the episode seed, and
 * attempts share one RNG stream in a fixed order, so a seed always produces
 * the same level. No `node:*`, no clocks.
 *
 * @module
 */

import { nextInt, streamFromSeed } from '../../core/rng.js';
import { deltasFor, solve, SolverBudgetError } from './solver.js';

/** @import { RngStream } from '../../core/rng.js' */
/** @import { SokobanLevel } from './solver.js' */

/**
 * Per-tier generation parameters.
 *
 * @typedef {object} GenerationParams
 * @property {number} width Interior width (playable squares across).
 * @property {number} height Interior height.
 * @property {number} boxes Number of boxes (and goals).
 * @property {number} parMin Minimum accepted optimal move count (inclusive).
 * @property {number} parMax Maximum accepted optimal move count (inclusive).
 * @property {number} pullsMin Minimum number of reverse-play steps per scramble
 *   (pull-preferred, with walking when no pull is available).
 * @property {number} pullsMax Maximum number of reverse-play steps per scramble.
 * @property {number} wallsMax Maximum number of interior wall squares.
 */

/**
 * A generated level, ready to play.
 *
 * @typedef {object} GeneratedLevel
 * @property {SokobanLevel} level Walls and goals.
 * @property {number} player Player square index.
 * @property {number[]} boxes Sorted box square indices.
 * @property {number} par Proven optimal move count for the position.
 * @property {number} attempts Number of scrambling attempts tried (1-based,
 *   the accepted attempt).
 */

/**
 * Generate a level deterministically from the seed.
 *
 * @param {GenerationParams} params Tier generation parameters.
 * @param {string} seed The episode seed string.
 * @param {{ maxAttempts?: number, nodeBudget?: number }} [options]
 * @returns {GeneratedLevel}
 * @throws {Error} when no attempt lands inside the par band within
 *   `maxAttempts` (loud by design: a tier whose band is unreachable must not
 *   ship silently).
 */
export function generateLevel(params, seed, options = {}) {
  // 600k states bounds each attempt's cost (an exhausted attempt is rejected
  // and retried) while leaving ample headroom above the measured par bands;
  // the solver default of 3M stays for direct callers.
  const { maxAttempts = 64, nodeBudget = 600000 } = options;
  const stream = streamFromSeed(`sokoban/generator/${seed}`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const accepted = tryAttempt(params, stream, nodeBudget);
    if (accepted) return { ...accepted, attempts: attempt };
  }
  throw new Error(
    `sokoban generator: no level inside par band [${params.parMin}, ${params.parMax}] ` +
      `after ${maxAttempts} attempts for seed ${JSON.stringify(seed)}`
  );
}

/**
 * One scrambling attempt over a shared RNG stream.
 *
 * @param {GenerationParams} params
 * @param {RngStream} stream
 * @param {number} nodeBudget
 * @returns {Omit<GeneratedLevel, 'attempts'> | null} null when the attempt
 *   missed the band or exhausted the solver budget.
 */
function tryAttempt(params, stream, nodeBudget) {
  const { width, height, boxes: boxCount } = params;
  const w = width + 2; // + the wall border
  const h = height + 2;
  const size = w * h;
  const interior = [];
  for (let y = 1; y <= height; y++) {
    for (let x = 1; x <= width; x++) interior.push(y * w + x);
  }

  // Seeded interior walls, never on the border.
  const wallCount = nextInt(stream.getState(), 0, params.wallsMax).value;
  const wallDraw = stream.shuffle(interior);
  const walls = wallDraw.slice(0, wallCount).sort((a, b) => a - b);

  // Boxes start on the goals; the player starts anywhere else.
  const free = interior.filter((i) => !walls.includes(i));
  if (free.length < boxCount + 1) return null;
  const shuffledFree = stream.shuffle(free);
  const goals = shuffledFree.slice(0, boxCount).sort((a, b) => a - b);
  const player = shuffledFree[boxCount];
  let boxes = [...goals];

  // Scramble with reverse play: each step the player either pulls (steps from
  // p to p + d, dragging the box at p - d onto p) or, when no pull is
  // available, walks to a free adjacent square. Walking is what lets the
  // player roam to boxes and drag them far from their goals; without it most
  // scrambles never move a box and the "scrambled" position is still solved.
  const d = deltasFor(w);
  const deltas = [d.up, d.down, d.left, d.right];
  const stepCount = nextInt(stream.getState(), params.pullsMin, params.pullsMax).value;
  let p = player;
  for (let i = 0; i < stepCount; i++) {
    const order = stream.shuffle(deltas); // one deterministic direction order per step
    const boxSet = new Set(boxes);
    const canPull = (/** @type {number} */ step) => {
      const destination = p + step;
      const dragging = p - step;
      const onBorder =
        destination < w ||
        destination >= size - w ||
        destination % w === 0 ||
        destination % w === w - 1;
      return (
        !onBorder &&
        !walls.includes(destination) &&
        !boxSet.has(destination) &&
        boxSet.has(dragging)
      );
    };
    const canWalk = (/** @type {number} */ step) => {
      const destination = p + step;
      const onBorder =
        destination < w ||
        destination >= size - w ||
        destination % w === 0 ||
        destination % w === w - 1;
      return !onBorder && !walls.includes(destination) && !boxSet.has(destination);
    };
    const pullStep = order.find(canPull);
    if (pullStep !== undefined) {
      // Pull: the box behind lands on the player's old square.
      boxes = boxes.filter((b) => b !== p - pullStep);
      boxes.push(p);
      boxes.sort((a, b) => a - b);
      p = p + pullStep;
      continue;
    }
    const walkStep = order.find(canWalk);
    if (walkStep !== undefined) p = p + walkStep; // else: boxed in on all sides; the step is consumed
  }

  // The solver is the proof of record; the band check decides acceptance.
  // Budget exhaustion rejects the attempt (never truncates a par silently).
  const level = { width: w, height: h, walls, goals };
  let result;
  try {
    result = solve(level, { player: p, boxes }, { nodeBudget });
  } catch (err) {
    if (err instanceof SolverBudgetError) return null;
    throw err;
  }
  if (!result.solvable || result.par === null) return null;
  if (result.par < params.parMin || result.par > params.parMax) return null;
  return { level, player: p, boxes, par: result.par };
}
