/**
 * Sudoku engine for the PlayKit Gauntlet: candidate bookkeeping, the
 * technique ladder that grades puzzles, solution counting (the uniqueness
 * oracle), and the seeded generator. Pure JS, no `node:*`; every random
 * choice flows from core/rng.js streams seeded by the episode seed.
 *
 * The technique ladder (a tier is a technique ceiling, not a clue count):
 * - level 0: naked singles + hidden singles
 * - level 1: + naked/hidden pairs, pointing and claiming (locked candidates)
 * - level 2: + X-wing and XY-wing
 * A puzzle's grade is the lowest level whose techniques solve it; 3 means
 * the ladder cannot solve it at all (unique, but harder than level 2).
 *
 * @module
 */

import { streamFromSeed } from '../../core/rng.js';

/** @import { RngStream } from '../../core/rng.js' */

/**
 * Grid dimensions shared by the game, the solver and the generator.
 *
 * @typedef {object} Dims
 * @property {number} size 4 (mini) or 9 (classic).
 * @property {number} boxRows Box height.
 * @property {number} boxCols Box width.
 */

/** @param {Dims} dims @returns {number} Bitmask with every digit allowed. */
export function fullMask(dims) {
  return (1 << dims.size) - 1;
}

/** @param {number} mask @returns {number} */
export function popcount(mask) {
  let m = mask;
  let n = 0;
  while (m) {
    m &= m - 1;
    n++;
  }
  return n;
}

/**
 * @param {number} mask A single-bit mask.
 * @returns {number} The digit (1-based) that bit stands for.
 */
export function digitOfBit(mask) {
  return 32 - Math.clz32(mask);
}

/**
 * @param {number} mask
 * @param {Dims} dims
 * @returns {number[]} Digits (1-based) whose bits are set, ascending.
 */
export function bitsToDigits(mask, dims) {
  /** @type {number[]} */
  const out = [];
  for (let d = 1; d <= dims.size; d++) {
    if (mask & (1 << (d - 1))) out.push(d);
  }
  return out;
}

/** @type {Map<string, ReturnType<typeof buildUnits>>} */
const UNITS_CACHE = new Map();

/**
 * Row, column and box units as cell-index lists.
 *
 * @param {Dims} dims
 * @returns {{ rows: number[][], cols: number[][], boxes: number[][], all: number[][] }}
 */
export function buildUnits(dims) {
  const key = `${dims.size}/${dims.boxRows}/${dims.boxCols}`;
  const cached = UNITS_CACHE.get(key);
  if (cached) return cached;
  const { size, boxRows, boxCols } = dims;
  /** @param {number} r @param {number} c @returns {number} */
  const boxId = (r, c) =>
    Math.floor(r / boxRows) * (size / boxCols) + Math.floor(c / boxCols);
  /** @type {number[][]} */
  const rows = [];
  const cols = Array.from({ length: size }, () => /** @type {number[]} */ ([]));
  const boxes = Array.from(
    { length: (size / boxRows) * (size / boxCols) },
    () => /** @type {number[]} */ ([])
  );
  for (let r = 0; r < size; r++) {
    /** @type {number[]} */
    const row = [];
    for (let c = 0; c < size; c++) {
      row.push(r * size + c);
      cols[c].push(r * size + c);
      boxes[boxId(r, c)].push(r * size + c);
    }
    rows.push(row);
  }
  const result = { rows, cols, boxes, all: [...rows, ...cols, ...boxes] };
  UNITS_CACHE.set(key, result);
  return result;
}

/** @type {Map<string, number[][]>} */
const PEERS_CACHE = new Map();

/**
 * Peer lists: cells sharing at least one unit with each cell.
 *
 * @param {Dims} dims
 * @returns {number[][]}
 */
export function buildPeers(dims) {
  const key = `${dims.size}/${dims.boxRows}/${dims.boxCols}`;
  const cached = PEERS_CACHE.get(key);
  if (cached) return cached;
  const units = buildUnits(dims);
  const n = dims.size * dims.size;
  /** @type {Set<number>[]} */
  const sets = Array.from({ length: n }, () => new Set());
  for (const unit of units.all) {
    for (const i of unit) {
      for (const j of unit) {
        if (i !== j) sets[i].add(j);
      }
    }
  }
  const peers = sets.map((s) => [...s].sort((a, b) => a - b));
  PEERS_CACHE.set(key, peers);
  return peers;
}

/**
 * Candidates straight from grid constraints (a filled cell gets 0). Does not
 * include proof exclusions — `techniqueSolve` layers those on top.
 *
 * @param {number[]} cells Grid, 0 for empty, digit otherwise.
 * @param {Dims} dims
 * @returns {number[]}
 */
export function computeCandidates(cells, dims) {
  const { size } = dims;
  const units = buildUnits(dims);
  const n = size * size;
  /** @type {number[]} */
  const rowUsed = new Array(size).fill(0);
  /** @type {number[]} */
  const colUsed = new Array(size).fill(0);
  /** @type {number[]} */
  const boxUsed = new Array(units.boxes.length).fill(0);
  /** @param {number} r @param {number} c @returns {number} */
  const boxId = (r, c) =>
    Math.floor(r / dims.boxRows) * (size / dims.boxCols) +
    Math.floor(c / dims.boxCols);
  for (let i = 0; i < n; i++) {
    const v = cells[i];
    if (!v) continue;
    const r = Math.floor(i / size);
    const c = i % size;
    const bit = 1 << (v - 1);
    rowUsed[r] |= bit;
    colUsed[c] |= bit;
    boxUsed[boxId(r, c)] |= bit;
  }
  /** @type {number[]} */
  const cand = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (cells[i]) continue;
    const r = Math.floor(i / size);
    const c = i % size;
    cand[i] =
      fullMask(dims) & ~(rowUsed[r] | colUsed[c] | boxUsed[boxId(r, c)]);
  }
  return cand;
}

/**
 * Result of a technique-solver pass.
 *
 * @typedef {object} SolveResult
 * @property {boolean} solved Every cell filled.
 * @property {boolean} contradiction An empty cell has no candidate, or a
 *   unit can host no copy of some digit. On a grid that still extends the
 *   puzzle's unique solution this is unreachable, so a contradiction is
 *   honest evidence of a wrong entry somewhere.
 * @property {number[]} cells The grid after the pass (input if no progress).
 * @property {number[]} placed Indices the solver filled, in order.
 */

/**
 * Run the technique ladder up to `maxLevel` to a fixpoint. Pure.
 *
 * @param {number[]} work Starting grid (0 = empty).
 * @param {Dims} dims
 * @param {number} maxLevel 0, 1 or 2.
 * @returns {SolveResult}
 */
export function techniqueSolve(work, dims, maxLevel) {
  const { size } = dims;
  const n = size * size;
  const units = buildUnits(dims);
  const peers = buildPeers(dims);
  const cells = work.slice();
  /** @type {number[]} */
  const placed = [];
  // Digits proven impossible beyond grid constraints, per cell.
  /** @type {number[]} */
  const excluded = new Array(n).fill(0);

  for (;;) {
    let progress = false;

    // Naked singles, one placement at a time: batching them could double-
    // place a digit into one unit, because two cells of the same row can
    // both read {d} before either placement lands.
    for (;;) {
      const cand = computeCandidates(cells, dims);
      let hit = -1;
      let hitDigit = 0;
      for (let i = 0; i < n; i++) {
        if (cells[i]) continue;
        const m = cand[i] & ~excluded[i];
        if (m === 0) {
          return { solved: false, contradiction: true, cells, placed };
        }
        if (popcount(m) === 1) {
          hit = i;
          hitDigit = digitOfBit(m);
          break;
        }
      }
      if (hit === -1) break;
      cells[hit] = hitDigit;
      placed.push(hit);
      progress = true;
    }
    if (progress) continue;

    // Hidden singles (and the contradiction a homeless digit implies), over
    // a fresh candidate grid. Batch-safe: an overcounted stale candidate can
    // only hide a single, never fabricate one.
    {
      const cand = computeCandidates(cells, dims);
      for (let i = 0; i < n; i++) {
        if (!cells[i]) cand[i] &= ~excluded[i];
      }
      for (const unit of units.all) {
        for (let d = 1; d <= size; d++) {
          const bit = 1 << (d - 1);
          if (unit.some((i) => cells[i] === d)) continue;
          let count = 0;
          let at = -1;
          for (const i of unit) {
            if (!cells[i] && cand[i] & bit) {
              count++;
              at = i;
              if (count > 1) break;
            }
          }
          if (count === 0) {
            return { solved: false, contradiction: true, cells, placed };
          }
          if (count === 1) {
            cells[at] = d;
            placed.push(at);
            progress = true;
          }
        }
      }
    }
    if (progress) continue;
    if (maxLevel < 1) break;

    // Elimination techniques over a fixed candidate grid.
    const cand = computeCandidates(cells, dims);
    for (let i = 0; i < n; i++) {
      if (!cells[i]) cand[i] &= ~excluded[i];
    }
    /**
     * Record one proof-exclusion; sets `progress` when it removes a live
     * candidate.
     *
     * @param {number} i
     * @param {number} bit
     * @returns {void}
     */
    const eliminate = (i, bit) => {
      if (!cells[i] && cand[i] & bit && !(excluded[i] & bit)) {
        excluded[i] |= bit;
        progress = true;
      }
    };

    // Naked pairs: two cells of a unit sharing the same two candidates —
    // those digits are impossible elsewhere in the unit.
    for (const unit of units.all) {
      for (let a = 0; a < unit.length; a++) {
        const i = unit[a];
        if (cells[i] || popcount(cand[i]) !== 2) continue;
        for (let b = a + 1; b < unit.length; b++) {
          const j = unit[b];
          if (cells[j] || cand[j] !== cand[i]) continue;
          for (const k of unit) {
            if (k === i || k === j) continue;
            for (const bit of bitsToDigits(cand[i], dims)) {
              eliminate(k, 1 << (bit - 1));
            }
          }
        }
      }
    }
    if (progress) continue;

    // Hidden pairs: two digits confined to the same two cells of a unit —
    // those cells hold nothing else.
    for (const unit of units.all) {
      /** @type {number[][]} */
      const pos = [];
      for (let d = 1; d <= size; d++) {
        const bit = 1 << (d - 1);
        pos[d] = unit.filter((i) => !cells[i] && cand[i] & bit);
      }
      for (let d1 = 1; d1 <= size; d1++) {
        for (let d2 = d1 + 1; d2 <= size; d2++) {
          const p1 = pos[d1];
          const p2 = pos[d2];
          if (p1.length !== 2 || p2.length !== 2) continue;
          if (p1[0] !== p2[0] || p1[1] !== p2[1]) continue;
          const pairMask = (1 << (d1 - 1)) | (1 << (d2 - 1));
          for (const i of p1) {
            for (const bit of bitsToDigits(cand[i] & ~pairMask, dims)) {
              eliminate(i, 1 << (bit - 1));
            }
          }
        }
      }
    }
    if (progress) continue;

    // Pointing (box -> line): a digit confined to one row/column of a box is
    // impossible in the rest of that line. Claiming (line -> box): a digit
    // confined to one box of a row/column is impossible in the rest of the
    // box.
    for (let b = 0; b < units.boxes.length; b++) {
      const box = units.boxes[b];
      for (let d = 1; d <= size; d++) {
        const bit = 1 << (d - 1);
        const positions = box.filter((i) => !cells[i] && cand[i] & bit);
        if (positions.length < 2) continue;
        const rowSet = new Set(positions.map((i) => Math.floor(i / size)));
        const colSet = new Set(positions.map((i) => i % size));
        if (rowSet.size === 1) {
          const r = Math.floor(positions[0] / size);
          for (let c = 0; c < size; c++) {
            const i = r * size + c;
            if (!box.includes(i)) eliminate(i, bit);
          }
        }
        if (colSet.size === 1) {
          const c = positions[0] % size;
          for (let r = 0; r < size; r++) {
            const i = r * size + c;
            if (!box.includes(i)) eliminate(i, bit);
          }
        }
      }
    }
    for (const line of [...units.rows, ...units.cols]) {
      for (let d = 1; d <= size; d++) {
        const bit = 1 << (d - 1);
        const positions = line.filter((i) => !cells[i] && cand[i] & bit);
        if (positions.length < 2) continue;
        const boxSet = new Set(
          positions.map(
            (i) =>
              Math.floor(Math.floor(i / size) / dims.boxRows) *
                (size / dims.boxCols) +
              Math.floor((i % size) / dims.boxCols)
          )
        );
        if (boxSet.size !== 1) continue;
        const b = /** @type {number} */ (boxSet.values().next().value);
        for (const i of units.boxes[b]) {
          if (!line.includes(i)) eliminate(i, bit);
        }
      }
    }
    if (progress) continue;
    if (maxLevel < 2) break;

    // X-wing: a digit with exactly two positions in each of two rows, the
    // same two columns — impossible in those columns elsewhere (and the
    // transposed statement for columns).
    for (let d = 1; d <= size; d++) {
      const bit = 1 << (d - 1);
      /** @type {number[][]} */
      const inRow = [];
      /** @type {number[][]} */
      const inCol = [];
      for (let r = 0; r < size; r++) {
        inRow[r] = [];
        for (let c = 0; c < size; c++) {
          const i = r * size + c;
          if (!cells[i] && cand[i] & bit) inRow[r].push(c);
        }
      }
      for (let c = 0; c < size; c++) {
        inCol[c] = [];
        for (let r = 0; r < size; r++) {
          const i = r * size + c;
          if (!cells[i] && cand[i] & bit) inCol[c].push(r);
        }
      }
      for (let r1 = 0; r1 < size; r1++) {
        for (let r2 = r1 + 1; r2 < size; r2++) {
          if (
            inRow[r1].length === 2 &&
            inRow[r2].length === 2 &&
            inRow[r1][0] === inRow[r2][0] &&
            inRow[r1][1] === inRow[r2][1]
          ) {
            for (const c of inRow[r1]) {
              for (let r = 0; r < size; r++) {
                if (r !== r1 && r !== r2) eliminate(r * size + c, bit);
              }
            }
          }
        }
      }
      for (let c1 = 0; c1 < size; c1++) {
        for (let c2 = c1 + 1; c2 < size; c2++) {
          if (
            inCol[c1].length === 2 &&
            inCol[c2].length === 2 &&
            inCol[c1][0] === inCol[c2][0] &&
            inCol[c1][1] === inCol[c2][1]
          ) {
            for (const r of inCol[c1]) {
              for (let c = 0; c < size; c++) {
                if (c !== c1 && c !== c2) eliminate(r * size + c, bit);
              }
            }
          }
        }
      }
    }
    if (progress) continue;

    // XY-wing: pivot p with two candidates, two peers q1/q2 of p with two
    // candidates each, sharing exactly one digit z not in p — z is
    // impossible in any cell that sees both q1 and q2.
    for (let p = 0; p < n; p++) {
      if (cells[p] || popcount(cand[p]) !== 2) continue;
      const ps = peers[p];
      for (let a = 0; a < ps.length; a++) {
        const q1 = ps[a];
        if (cells[q1] || popcount(cand[q1]) !== 2 || cand[q1] === cand[p]) {
          continue;
        }
        for (let b = a + 1; b < ps.length; b++) {
          const q2 = ps[b];
          if (cells[q2] || popcount(cand[q2]) !== 2 || cand[q2] === cand[p]) {
            continue;
          }
          const z = cand[q1] & cand[q2];
          if (popcount(z) !== 1 || z & cand[p]) continue;
          if (popcount(cand[q1] & cand[p]) !== 1) continue;
          if (popcount(cand[q2] & cand[p]) !== 1) continue;
          const q1Peers = new Set(peers[q1]);
          for (const w of peers[q2]) {
            if (w !== p && q1Peers.has(w)) eliminate(w, z);
          }
        }
      }
    }

    if (!progress) break;
  }

  return {
    solved: cells.every((v) => v !== 0),
    contradiction: false,
    cells,
    placed,
  };
}

/**
 * Grade a puzzle: the lowest ladder level whose techniques solve it
 * (0 = singles, 1 = pairs/locked candidates, 2 = X-wing/XY-wing, 3 = beyond
 * the ladder).
 *
 * @param {number[]} givens
 * @param {Dims} dims
 * @returns {number}
 */
export function gradePuzzle(givens, dims) {
  if (techniqueSolve(givens, dims, 0).solved) return 0;
  if (techniqueSolve(givens, dims, 1).solved) return 1;
  if (techniqueSolve(givens, dims, 2).solved) return 2;
  return 3;
}

/**
 * Count solutions up to `limit` (backtracking over MRV cells with singles
 * propagation). Pure. This is the uniqueness oracle.
 *
 * @param {number[]} cells
 * @param {Dims} dims
 * @param {number} [limit]
 * @returns {number}
 */
export function countSolutions(cells, dims, limit = 2) {
  if (limit <= 0) return 0;
  const pass = techniqueSolve(cells, dims, 0);
  if (pass.contradiction) return 0;
  if (pass.solved) return 1;
  const grid = pass.cells;
  const cand = computeCandidates(grid, dims);
  const n = dims.size * dims.size;
  let best = -1;
  let bestCount = dims.size + 1;
  for (let i = 0; i < n; i++) {
    if (grid[i]) continue;
    const c = popcount(cand[i]);
    if (c === 0) return 0;
    if (c < bestCount) {
      bestCount = c;
      best = i;
      if (c === 1) break;
    }
  }
  if (best === -1) return 1;
  let total = 0;
  for (const d of bitsToDigits(cand[best], dims)) {
    const next = grid.slice();
    next[best] = d;
    total += countSolutions(next, dims, limit - total);
    if (total >= limit) return total;
  }
  return total;
}

/**
 * Draw a complete valid grid: backtracking over MRV cells with a seeded
 * shuffled digit order. Deterministic in (dims, stream).
 *
 * @param {Dims} dims
 * @param {RngStream} stream Mutable stream (streamFromSeed).
 * @returns {number[]}
 */
export function generateSolution(dims, stream) {
  const n = dims.size * dims.size;
  /** @type {number[]} */
  const cells = new Array(n).fill(0);
  /**
   * @returns {boolean}
   */
  const fill = () => {
    const cand = computeCandidates(cells, dims);
    let best = -1;
    let bestCount = dims.size + 1;
    for (let i = 0; i < n; i++) {
      if (cells[i]) continue;
      const c = popcount(cand[i]);
      if (c === 0) return false;
      if (c < bestCount) {
        bestCount = c;
        best = i;
        if (c === 1) break;
      }
    }
    if (best === -1) return true;
    const order = stream.shuffle(bitsToDigits(cand[best], dims));
    for (const d of order) {
      cells[best] = d;
      if (fill()) return true;
      cells[best] = 0;
    }
    return false;
  };
  const ok = fill();
  if (!ok) throw new Error('generateSolution: no solution found (bug)');
  return cells;
}

/**
 * Dig clues out of a full grid while the solution stays unique, stopping at
 * `targetClues` (or when no further removal survives the uniqueness check).
 * Every accepted removal is checked with the solution counter, so the
 * returned puzzle carries exactly one solution by construction.
 *
 * @param {Dims} dims
 * @param {number} targetClues
 * @param {RngStream} stream Mutable stream.
 * @returns {{ puzzle: number[], solution: number[], clues: number }}
 */
export function generatePuzzle(dims, targetClues, stream) {
  const solution = generateSolution(dims, stream);
  const n = dims.size * dims.size;
  const puzzle = solution.slice();
  let clues = n;
  const order = stream.shuffle(Array.from({ length: n }, (_, i) => i));
  for (const p of order) {
    if (clues <= targetClues) break;
    const saved = puzzle[p];
    puzzle[p] = 0;
    if (countSolutions(puzzle, dims, 2) !== 1) {
      puzzle[p] = saved;
    } else {
      clues--;
    }
  }
  return { puzzle, solution, clues };
}

/** Digging target ladders per tier key. A tier's difficulty is decided by
 * the technique grade; each target only steers the rejection-sampling hit
 * rate. Ladders try easier-then-harder clue counts within one attempt
 * because grade-1 puzzles get rare at deep digging and grade-2+ puzzles get
 * rare at shallow digging. */
const TIER_TARGET_CLUES = /** @type {const} */ ({
  mini: [8],
  easy: [40],
  medium: [32, 38],
  hard: [26, 22],
});

/**
 * Boundary dig for the medium tier: remove clues (uniqueness-preserving) in
 * seeded order just until the puzzle stops being solvable by singles alone,
 * and accept it only when that first crossing lands exactly on grade 1
 * (pairs or locked candidates required, X-wing and beyond not). Puzzles
 * whose next removal jumps straight to grade 2 have that removal restored
 * and the walk continues; a full grid that never crosses to grade 1 rejects
 * the attempt. Deterministic in (dims, stream). The returned puzzle carries
 * exactly one solution by construction — every accepted removal passed the
 * solution counter.
 *
 * @param {Dims} dims
 * @param {RngStream} stream Mutable stream.
 * @returns {{ puzzle: number[], solution: number[], clues: number, grade: number } | null}
 *   Null when this attempt produced no grade-1 puzzle.
 */
export function generateBoundaryGrade1(dims, stream) {
  const solution = generateSolution(dims, stream);
  const n = dims.size * dims.size;
  const puzzle = solution.slice();
  let clues = n;
  const order = stream.shuffle(Array.from({ length: n }, (_, i) => i));
  for (const p of order) {
    const saved = puzzle[p];
    puzzle[p] = 0;
    if (countSolutions(puzzle, dims, 2) !== 1) {
      puzzle[p] = saved;
      continue;
    }
    if (techniqueSolve(puzzle, dims, 0).solved) {
      clues--; // still grade 0: keep digging
      continue;
    }
    const grade = gradePuzzle(puzzle, dims);
    if (grade === 1) {
      return { puzzle, solution, clues: clues - 1, grade };
    }
    puzzle[p] = saved; // grade 2+: too far, try other cells
  }
  return null;
}

/**
 * @param {string} tierKey
 * @param {number} grade
 * @returns {boolean}
 */
function acceptsGrade(tierKey, grade) {
  if (tierKey === 'mini' || tierKey === 'easy') return grade === 0;
  if (tierKey === 'medium') return grade === 1;
  return grade >= 2; // hard: needs X-wing/XY-wing or something beyond
}

/**
 * Rejection-sample a puzzle whose technique grade matches the tier, fully
 * deterministic in (dims, tierKey, seed). Throws after 500 attempts.
 *
 * @param {Dims} dims
 * @param {'mini' | 'easy' | 'medium' | 'hard'} tierKey
 * @param {string} seed
 * @returns {{ givens: number[], solution: number[], grade: number, clues: number, attempts: number }}
 */
export function generateForTier(dims, tierKey, seed) {
  const targets = TIER_TARGET_CLUES[tierKey];
  for (let attempt = 0; attempt < 500; attempt++) {
    const stream = streamFromSeed(`${seed}/gen/${attempt}`);
    if (tierKey === 'medium') {
      // Grade-1 puzzles are a narrow band under rejection sampling at any
      // fixed clue count; the boundary walk finds one almost every attempt.
      const hit = generateBoundaryGrade1(dims, stream);
      if (hit) {
        return { givens: hit.puzzle, solution: hit.solution, grade: hit.grade, clues: hit.clues, attempts: attempt + 1 };
      }
      continue;
    }
    for (const targetClues of targets) {
      const { puzzle, solution, clues } = generatePuzzle(dims, targetClues, stream);
      const grade = gradePuzzle(puzzle, dims);
      if (acceptsGrade(tierKey, grade)) {
        return { givens: puzzle, solution, grade, clues, attempts: attempt + 1 };
      }
    }
  }
  throw new Error(
    `generateForTier: no ${tierKey} puzzle accepted for seed ${seed} in 500 attempts`
  );
}
