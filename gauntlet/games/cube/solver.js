/**
 * Exact optimal solver for the Gauntlet cube: proven-optimal turn counts for
 * scrambles up to 10 moves in the half-turn metric, by meet-in-the-middle.
 *
 * - A lazily built, process-cached breadth-first table of every state within
 *   5 turns of solved (621,649 states: 1, 18, 243, 3240, 43239, 574908 at
 *   distances 0..5 — the tail of OEIS A080601), each with its exact distance.
 * - A breadth-first search of at most 5 turns out from the scramble. The
 *   first search layer that reaches any tabulated state proves the optimal
 *   length: for a state first met at forward distance d with table distance
 *   t, d + t is a valid solution length, and every optimal path for a
 *   scramble of length L <= 10 passes through a state with both d <= 5 and
 *   t <= 5, so the minimum over the first intersecting layer is exactly L
 *   (later layers can only tie, never beat, since d + t is bounded below by
 *   the true distance by the triangle inequality over that state).
 *
 * The search prunes same-face consecutive turns: any optimal solution can be
 * rewritten so no two consecutive turns share a face (equal-face turns merge
 * or cancel), so pruned breadth-first search still meets every state at its
 * true distance.
 *
 * The returned solution is one optimal line: the forward path from the
 * scramble to the meeting state, then a table-guided descent to solved.
 *
 * `bfsOptimalLength` is a deliberately naive plain breadth-first reference
 * (no table, no pruning, no early exit) used by the tests to cross-check the
 * meet-in-the-middle lengths.
 *
 * Pure JS, no `node:*` imports: game code loads in the browser too.
 *
 * @module
 */

import { MOVES, SOLVED, applyMove } from './cube.js';

/** Table radius. Meet-in-the-middle covers scrambles up to 2 * TABLE_DEPTH turns. */
const TABLE_DEPTH = 5;

/**
 * Breadth-first map of every state within `maxDepth` turns of solved to its
 * exact distance. Prunes same-face consecutive turns (sound: see module doc).
 *
 * @param {number} maxDepth
 * @returns {Map<string, number>} state facelet string -> distance from solved.
 */
export function statesWithinMoves(maxDepth) {
  /** @type {Map<string, number>} */
  const dist = new Map([[SOLVED, 0]]);
  /** @type {string[]} */
  let frontier = [SOLVED];
  /** @type {string[]} */
  let lastFaces = [''];
  for (let depth = 1; depth <= maxDepth; depth++) {
    /** @type {string[]} */
    const next = [];
    /** @type {string[]} */
    const nextFaces = [];
    for (let i = 0; i < frontier.length; i++) {
      const state = frontier[i];
      const lastFace = lastFaces[i];
      for (const move of MOVES) {
        if (move[0] === lastFace) continue;
        const next_ = applyMove(state, move);
        if (dist.has(next_)) continue;
        dist.set(next_, depth);
        next.push(next_);
        nextFaces.push(move[0]);
      }
    }
    frontier = next;
    lastFaces = nextFaces;
  }
  return dist;
}

/** @type {Map<string, number> | null} */
let tableCache = null;

/**
 * The distance table out to 5 turns, built once per process and cached.
 * ~621,649 entries; builds in a few seconds.
 *
 * @returns {Map<string, number>}
 */
export function buildDistanceTable() {
  if (tableCache === null) {
    tableCache = statesWithinMoves(TABLE_DEPTH);
  }
  return tableCache;
}

/**
 * @param {string} state
 * @returns {boolean}
 */
function isFaceletString(state) {
  return typeof state === 'string' && state.length === 54 && /^[WYROGB]+$/.test(state);
}

/** Result of an optimal solve. @typedef {{ length: number, solution: string[] }} OptimalSolve */

/**
 * Bounded memo of solved scrambles (scramble string -> result), so repeated
 * episodes over the same public seeds do not re-search.
 *
 * @type {Map<string, OptimalSolve>}
 */
const solveMemo = new Map();
const SOLVE_MEMO_MAX = 512;

/**
 * @param {string} state
 * @param {OptimalSolve} result
 */
function memoizeSolve(state, result) {
  if (solveMemo.size >= SOLVE_MEMO_MAX) solveMemo.clear();
  solveMemo.set(state, result);
}

/**
 * Walk a tabulated state down to solved, one turn at a time, each step
 * decreasing the table distance by exactly one.
 *
 * @param {string} state
 * @param {number} depth
 * @param {Map<string, number>} table
 * @returns {string[]} The turns, in order.
 */
function descendToSolved(state, depth, table) {
  /** @type {string[]} */
  const turns = [];
  let cur = state;
  let d = depth;
  while (d > 0) {
    let stepped = false;
    for (const move of MOVES) {
      const next = applyMove(cur, move);
      if (table.get(next) === d - 1) {
        turns.push(move);
        cur = next;
        d--;
        stepped = true;
        break;
      }
    }
    if (!stepped) {
      throw new Error('solver internal error: table descent stuck (corrupt table?)');
    }
  }
  return turns;
}

/**
 * Exact optimal length for a scramble, and one optimal solution. Guaranteed
 * optimal for scrambles within 10 turns of solved (2 x TABLE_DEPTH); throws
 * beyond that.
 *
 * @param {string} scramble 54-character facelet string of the scrambled cube.
 * @returns {OptimalSolve}
 */
export function solveOptimal(scramble) {
  if (!isFaceletString(scramble)) {
    throw new Error(`solveOptimal: not a 54-facelet state: ${JSON.stringify(scramble)}`);
  }
  if (isSolvedString(scramble)) {
    return { length: 0, solution: [] };
  }
  const memo = solveMemo.get(scramble);
  if (memo !== undefined) return memo;

  const table = buildDistanceTable();

  const tableDepth = table.get(scramble);
  if (tableDepth !== undefined) {
    const result = { length: tableDepth, solution: descendToSolved(scramble, tableDepth, table) };
    if (applySequenceFrom(scramble, result.solution) !== SOLVED) {
      throw new Error('solver internal error: table solution does not reach solved');
    }
    memoizeSolve(scramble, result);
    return result;
  }

  // Forward breadth-first search from the scramble, up to TABLE_DEPTH turns.
  // Visited states live in one array; parents are indices, so the meeting
  // state's forward path reconstructs without a second search.
  /** @type {string[]} */
  const states = [scramble];
  /** @type {Map<string, number>} */
  const indexOfState = new Map([[scramble, 0]]);
  /** @type {number[]} */
  const parent = [-1];
  /** @type {number[]} */
  const viaMove = [-1];
  let layerStart = 0;
  let layerEnd = 1;
  let bestLength = Infinity;
  let bestIndex = -1;
  for (let depth = 1; depth <= TABLE_DEPTH; depth++) {
    for (let i = layerStart; i < layerEnd; i++) {
      const cur = states[i];
      const lastFace = viaMove[i] >= 0 ? MOVES[viaMove[i]][0] : '';
      for (let m = 0; m < MOVES.length; m++) {
        const move = MOVES[m];
        if (move[0] === lastFace) continue;
        const next = applyMove(cur, move);
        if (indexOfState.has(next)) continue;
        indexOfState.set(next, states.length);
        states.push(next);
        parent.push(i);
        viaMove.push(m);
        const tableDistance = table.get(next);
        if (tableDistance !== undefined && depth + tableDistance < bestLength) {
          bestLength = depth + tableDistance;
          bestIndex = states.length - 1;
        }
      }
    }
    layerStart = layerEnd;
    layerEnd = states.length;
    // Every later discovery is at forward distance >= depth + 1, so its total
    // is >= depth + 1; nothing deeper can beat (or even improve on) a total
    // found in this layer. Stop at the first intersecting layer.
    if (bestIndex >= 0) break;
  }
  if (bestIndex < 0) {
    throw new Error(
      `solveOptimal: scramble is beyond the proven range of ${TABLE_DEPTH * 2} turns`
    );
  }

  /** @type {string[]} */
  const forward = [];
  for (let i = bestIndex; parent[i] >= 0; i = parent[i]) {
    forward.push(MOVES[viaMove[i]]);
  }
  forward.reverse();

  const meeting = states[bestIndex];
  const meetingTableDepth = /** @type {number} */ (table.get(meeting));
  const back = descendToSolved(meeting, meetingTableDepth, table);
  const solution = forward.concat(back);
  const result = { length: bestLength, solution };
  if (solution.length !== bestLength || applySequenceFrom(scramble, solution) !== SOLVED) {
    throw new Error('solver internal error: meet-in-the-middle solution failed self-check');
  }
  memoizeSolve(scramble, result);
  return result;
}

/**
 * @param {string} state
 * @returns {boolean}
 */
function isSolvedString(state) {
  return state === SOLVED;
}

/**
 * @param {string} state
 * @param {readonly string[]} turns
 * @returns {string}
 */
function applySequenceFrom(state, turns) {
  let s = state;
  for (const turn of turns) s = applyMove(s, turn);
  return s;
}

/**
 * Independent reference: plain breadth-first search from the scramble to
 * solved — no table, no pruning, no early exit. Exponential; for tests only,
 * with maxDepth kept small (the full space has 4.3e19 states).
 *
 * @param {string} scramble
 * @param {number} [maxDepth] Gives up (returns null) beyond this depth.
 * @returns {number | null} The optimal turn count, or null if not found within maxDepth.
 */
export function bfsOptimalLength(scramble, maxDepth = 8) {
  if (scramble === SOLVED) return 0;
  const seen = new Set([scramble]);
  /** @type {string[]} */
  let frontier = [scramble];
  for (let depth = 1; depth <= maxDepth; depth++) {
    /** @type {string[]} */
    const next = [];
    for (const state of frontier) {
      for (const move of MOVES) {
        const n = applyMove(state, move);
        if (n === SOLVED) return depth;
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return null;
}
