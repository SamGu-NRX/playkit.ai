/**
 * Sliding-tile puzzle exact solver: IDA* over Manhattan distance plus linear
 * conflict, generalized to N x N (the original handled 4 x 4 only).
 *
 * Ported from draft PR #9 of SamGu-NRX/playkit.ai — `src/solver/fifteen-solver.js`
 * on branch `obv/burst-20261015-playkit` — and changed in three ways, each
 * verified by the BFS cross-checks in `sliding.test.js`:
 *
 * 1. Generalized to N x N boards (goal: tiles 1..N*N-1 in row-major order,
 *    blank last).
 * 2. The heuristic is updated incrementally per move instead of recomputed at
 *    every node, and successors are expanded in order of child f, so deep
 *    4 x 4 instances solve well inside the episode budget.
 * 3. Linear conflict is counted per line as 2 x (tiles that must leave the
 *    line), computed via longest increasing subsequence of the tiles' goal
 *    offsets. The original counted 2 per reversed pair, which overestimates
 *    the true removal cost when three or more tiles in one line are mutually
 *    reversed (3 reversed pairs add +6 where 2 tiles must leave, +4), so the
 *    original heuristic is not admissible there. The LIS form is admissible,
 *    so IDA* returns proven-optimal lengths; the tests pin this against BFS
 *    distances on the 3 x 3 state space.
 *
 * Direction convention (unchanged from the port, matching the arrow-key
 * handlers of public 15-puzzle sites): an action names the direction the TILE
 * slides. "up" slides the tile BELOW the blank upward (the blank moves down);
 * "down" slides the tile above the blank downward; "right" slides the tile to
 * the LEFT of the blank rightward; "left" slides the tile to the right of the
 * blank leftward.
 *
 * Pure JS, no `node:*` imports: game code loads in the browser too.
 *
 * @module
 */

/** @typedef {'up' | 'down' | 'left' | 'right'} Direction */

/**
 * Canonical direction names.
 * @type {readonly Direction[]}
 */
export const DIRECTIONS = ['up', 'down', 'left', 'right'];

/**
 * Blank-position delta for each direction, per the tile-movement convention:
 * DIRECTIONS[index] moves the blank by (dr, dc).
 * @type {readonly (readonly [number, number])[]}
 */
const BLANK_DELTA = [
  [1, 0], // up: the tile below the blank slides up; the blank moves down
  [-1, 0], // down: the tile above the blank slides down; the blank moves up
  [0, 1], // left: the tile right of the blank slides left; the blank moves right
  [0, -1], // right: the tile left of the blank slides right; the blank moves left
];

/** Index of the direction that undoes each direction. */
const OPPOSITE = [1, 0, 3, 2];

/**
 * @param {Direction} direction
 * @returns {number} Index into DIRECTIONS.
 */
export function directionIndex(direction) {
  const index = DIRECTIONS.indexOf(direction);
  if (index < 0) throw new Error(`unknown direction ${JSON.stringify(direction)}`);
  return index;
}

/**
 * The goal board: tiles 1..N*N-1 row-major, blank (0) last.
 * @param {number} size
 * @returns {number[][]}
 */
export function goalBoard(size) {
  /** @type {number[][]} */
  const board = [];
  for (let r = 0; r < size; r++) {
    /** @type {number[]} */
    const row = [];
    for (let c = 0; c < size; c++) {
      row.push(r === size - 1 && c === size - 1 ? 0 : r * size + c + 1);
    }
    board.push(row);
  }
  return board;
}

/**
 * @param {number[][]} board
 * @returns {boolean} True when every tile sits at its goal position.
 */
export function isSolved(board) {
  const n = board.length;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const expected = r === n - 1 && c === n - 1 ? 0 : r * n + c + 1;
      if (board[r][c] !== expected) return false;
    }
  }
  return true;
}

/**
 * Validate that a board is an N x N matrix holding each of 0..N*N-1 once.
 * @param {number[][]} board
 * @returns {boolean}
 */
export function isValidBoard(board) {
  if (!Array.isArray(board) || board.length === 0) return false;
  const n = board.length;
  const seen = new Set();
  for (const row of board) {
    if (!Array.isArray(row) || row.length !== n) return false;
    for (const value of row) {
      if (!Number.isInteger(value) || value < 0 || value >= n * n) return false;
      if (seen.has(value)) return false;
      seen.add(value);
    }
  }
  return seen.size === n * n;
}

/**
 * Solvability via inversion parity. Odd width: solvable iff the inversion
 * count is even. Even width: solvable iff (inversions + blank row counted
 * from the bottom) is odd — the classic unsolvable 14-15 swap fails this.
 * @param {number[][]} board
 * @returns {boolean}
 */
export function isSolvable(board) {
  const n = board.length;
  /** @type {number[]} */
  const flat = [];
  let blankRowFromBottom = 1;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (board[r][c] === 0) {
        blankRowFromBottom = n - r;
      } else {
        flat.push(board[r][c]);
      }
    }
  }
  let inversions = 0;
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      if (flat[i] > flat[j]) inversions++;
    }
  }
  return n % 2 === 1 ? inversions % 2 === 0 : (inversions + blankRowFromBottom) % 2 === 1;
}

/**
 * Directions whose tile move is legal on this board, sorted alphabetically.
 * @param {number[][]} board
 * @returns {Direction[]}
 */
export function legalMoves(board) {
  const n = board.length;
  let blankRow = -1;
  let blankCol = -1;
  outer: for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (board[r][c] === 0) {
        blankRow = r;
        blankCol = c;
        break outer;
      }
    }
  }
  /** @type {Direction[]} */
  const legal = [];
  if (blankRow < n - 1) legal.push('up'); // a tile below the blank exists
  if (blankRow > 0) legal.push('down');
  if (blankCol < n - 1) legal.push('left');
  if (blankCol > 0) legal.push('right');
  return legal.sort();
}

/**
 * Apply a move to a COPY of the board, tile-movement convention. Returns null
 * when no tile can slide in that direction.
 * @param {number[][]} board
 * @param {Direction} direction
 * @returns {number[][] | null}
 */
export function applyTileMove(board, direction) {
  const n = board.length;
  const d = directionIndex(direction);
  const [dr, dc] = BLANK_DELTA[d];
  let blankRow = -1;
  let blankCol = -1;
  outer: for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (board[r][c] === 0) {
        blankRow = r;
        blankCol = c;
        break outer;
      }
    }
  }
  const r = blankRow + dr;
  const c = blankCol + dc;
  if (r < 0 || r >= n || c < 0 || c >= n) return null;
  const next = board.map((row) => row.slice());
  next[blankRow][blankCol] = next[r][c];
  next[r][c] = 0;
  return next;
}

/**
 * Manhattan distance of every tile from its goal (blank excluded).
 * @param {number[][]} board
 * @returns {number}
 */
export function manhattanDistance(board) {
  const n = board.length;
  let h = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const value = board[r][c];
      if (value === 0) continue;
      const goalRow = Math.floor((value - 1) / n);
      const goalCol = (value - 1) % n;
      h += Math.abs(r - goalRow) + Math.abs(c - goalCol);
    }
  }
  return h;
}

/**
 * Length of the longest strictly increasing subsequence.
 * @param {readonly number[]} values
 * @returns {number}
 */
function longestIncreasingSubsequence(values) {
  const k = values.length;
  if (k === 0) return 0;
  /** @type {number[]} */
  const tails = [];
  for (const value of values) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo === tails.length) tails.push(value);
    else tails[lo] = value;
  }
  return tails.length;
}

/**
 * Linear-conflict cost of one board line: 2 x the minimum number of in-line
 * tiles that must leave the line so the rest can reach their slots in order.
 * @param {readonly number[]} goalOffsets Goal offsets of the line's tiles that
 *   belong in this line, in the line's traversal order.
 * @returns {number}
 */
function lineConflictCost(goalOffsets) {
  const inOrder = longestIncreasingSubsequence(goalOffsets);
  return 2 * (goalOffsets.length - inOrder);
}

/**
 * Full admissible heuristic: Manhattan distance plus per-row and per-column
 * linear conflict costs.
 * @param {readonly number[]} flat Row-major board, blank = 0.
 * @param {number} n
 * @returns {number}
 */
export function heuristicFlat(flat, n) {
  let h = 0;
  for (let r = 0; r < n; r++) {
    /** @type {number[]} */
    const rowOffsets = [];
    for (let c = 0; c < n; c++) {
      const value = flat[r * n + c];
      if (value === 0) continue;
      const goalRow = Math.floor((value - 1) / n);
      const goalCol = (value - 1) % n;
      h += Math.abs(r - goalRow) + Math.abs(c - goalCol);
      if (goalRow === r) rowOffsets.push(goalCol);
    }
    h += lineConflictCost(rowOffsets);
  }
  for (let c = 0; c < n; c++) {
    /** @type {number[]} */
    const colOffsets = [];
    for (let r = 0; r < n; r++) {
      const value = flat[r * n + c];
      if (value === 0) continue;
      const goalRow = Math.floor((value - 1) / n);
      const goalCol = (value - 1) % n;
      if (goalCol === c) colOffsets.push(goalRow);
    }
    h += lineConflictCost(colOffsets);
  }
  return h;
}

/**
 * Admissible lower bound on the optimal length: Manhattan distance plus
 * LIS-based linear conflicts, computed non-incrementally. Cheap enough to use
 * as a rejection filter during instance generation.
 * @param {number[][]} board
 * @returns {number}
 */
export function heuristicLowerBound(board) {
  const n = board.length;
  /** @type {number[]} */
  const flat = [];
  for (const row of board) for (const value of row) flat.push(value);
  const offsets = new Int32Array(n);
  const tails = new Int32Array(n);

  /**
   * @param {number} row
   * @returns {number}
   */
  function rowConflict(row) {
    let k = 0;
    for (let c = 0; c < n; c++) {
      const v = flat[row * n + c];
      if (v !== 0) {
        const goalRow = ((v - 1) / n) | 0;
        if (goalRow === row) offsets[k++] = (v - 1) % n;
      }
    }
    let lis = 0;
    for (let i = 0; i < k; i++) {
      const v = offsets[i];
      let lo = 0;
      let hi = lis;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tails[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      tails[lo] = v;
      if (lo === lis) lis++;
    }
    return 2 * (k - lis);
  }

  /**
   * @param {number} col
   * @returns {number}
   */
  function colConflict(col) {
    let k = 0;
    for (let r = 0; r < n; r++) {
      const v = flat[r * n + col];
      if (v !== 0) {
        const goalCol = (v - 1) % n;
        if (goalCol === col) offsets[k++] = ((v - 1) / n) | 0;
      }
    }
    let lis = 0;
    for (let i = 0; i < k; i++) {
      const v = offsets[i];
      let lo = 0;
      let hi = lis;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tails[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      tails[lo] = v;
      if (lo === lis) lis++;
    }
    return 2 * (k - lis);
  }

  let h = manhattanDistance(board);
  for (let r = 0; r < n; r++) h += rowConflict(r);
  for (let c = 0; c < n; c++) h += colConflict(c);
  return h;
}

/**
 * Solve a board with IDA*. The heuristic is admissible, so a "solved" result
 * is a proven-optimal move sequence.
 *
 * @param {number[][]} board Nested N x N board, blank = 0.
 * @param {{ maxNodes?: number }} [options]
 * @returns {{ status: 'solved', moves: Direction[], nodes: number, length: number }
 *          | { status: 'unsolvable' | 'invalid', moves: null, nodes: number }
 *          | { status: 'budget', moves: null, nodes: number }}
 */
export function solve(board, options = {}) {
  const maxNodes = options.maxNodes ?? 10_000_000;
  if (!isValidBoard(board)) {
    return { status: 'invalid', moves: null, nodes: 0 };
  }
  const n = board.length;
  /** @type {number[]} */
  const flat = [];
  for (const row of board) for (const value of row) flat.push(value);
  if (isSolvable(board)) {
    const nodes = idaStar(flat, n, maxNodes);
    if (nodes.moves !== null) {
      return { status: 'solved', moves: nodes.moves, nodes: nodes.count, length: nodes.moves.length };
    }
    return { status: /** @type {'budget'} */ (nodes.status ?? 'budget'), moves: null, nodes: nodes.count };
  }
  return { status: 'unsolvable', moves: null, nodes: 0 };
}

/**
 * @param {number[]} flat Board is mutated during the search and restored.
 * @param {number} n
 * @param {number} maxNodes
 * @returns {{ moves: Direction[] | null, count: number, status?: 'budget' }}
 */
function idaStar(flat, n, maxNodes) {
  const lcRows = new Int32Array(n);
  const lcCols = new Int32Array(n);
  const offsets = new Int32Array(n);
  const tails = new Int32Array(n);
  const childDir = new Int32Array(4);
  const childF = new Int32Array(4);

  /**
   * Linear-conflict cost of one row: 2 x tiles that must leave the row so the
   * rest reach their slots in order. Allocation-free.
   * @param {number} row
   * @returns {number}
   */
  function rowConflict(row) {
    let k = 0;
    for (let c = 0; c < n; c++) {
      const v = flat[row * n + c];
      if (v !== 0) {
        const goalRow = ((v - 1) / n) | 0;
        if (goalRow === row) offsets[k++] = (v - 1) % n;
      }
    }
    let lis = 0;
    for (let i = 0; i < k; i++) {
      const v = offsets[i];
      let lo = 0;
      let hi = lis;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tails[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      tails[lo] = v;
      if (lo === lis) lis++;
    }
    return 2 * (k - lis);
  }

  /**
   * Linear-conflict cost of one column, same shape as rowConflict.
   * @param {number} col
   * @returns {number}
   */
  function colConflict(col) {
    let k = 0;
    for (let r = 0; r < n; r++) {
      const v = flat[r * n + col];
      if (v !== 0) {
        const goalCol = (v - 1) % n;
        if (goalCol === col) offsets[k++] = ((v - 1) / n) | 0;
      }
    }
    let lis = 0;
    for (let i = 0; i < k; i++) {
      const v = offsets[i];
      let lo = 0;
      let hi = lis;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tails[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      tails[lo] = v;
      if (lo === lis) lis++;
    }
    return 2 * (k - lis);
  }

  for (let r = 0; r < n; r++) lcRows[r] = rowConflict(r);
  for (let c = 0; c < n; c++) lcCols[c] = colConflict(c);

  let h = manhattanFlat(flat, n);
  for (let r = 0; r < n; r++) h += lcRows[r];
  for (let c = 0; c < n; c++) h += lcCols[c];
  let blank = flat.indexOf(0);

  /**
   * Apply one move in place: the blank moves by BLANK_DELTA[direction], the
   * tile it swaps with moves the opposite way. Returns false when the move
   * leaves the board. Updates h and the per-line conflict caches
   * incrementally; allocates nothing, so it is safe to call several times per
   * search node.
   * @param {number} direction
   * @returns {boolean}
   */
  function apply(direction) {
    const dr = BLANK_DELTA[direction][0];
    const dc = BLANK_DELTA[direction][1];
    const br = (blank / n) | 0;
    const bc = blank % n;
    const r = br + dr;
    const c = bc + dc;
    if (r < 0 || r >= n || c < 0 || c >= n) return false;
    const from = r * n + c;

    // Conflict cost changes only on lines the tile leaves or enters: both
    // rows when the move is vertical, both columns when horizontal.
    const rowA = dr !== 0 ? r : -1;
    const colA = dc !== 0 ? c : -1;

    const tile = flat[from];
    flat[blank] = tile;
    flat[from] = 0;
    blank = from;

    const goalRow = ((tile - 1) / n) | 0;
    const goalCol = (tile - 1) % n;
    h +=
      Math.abs(br - goalRow) + Math.abs(bc - goalCol) -
      (Math.abs(r - goalRow) + Math.abs(c - goalCol));

    if (rowA >= 0) {
      const cost = rowConflict(rowA);
      h += cost - lcRows[rowA];
      lcRows[rowA] = cost;
    }
    {
      const cost = rowConflict(br);
      h += cost - lcRows[br];
      lcRows[br] = cost;
    }
    if (colA >= 0) {
      const cost = colConflict(colA);
      h += cost - lcCols[colA];
      lcCols[colA] = cost;
    }
    {
      const cost = colConflict(bc);
      h += cost - lcCols[bc];
      lcCols[bc] = cost;
    }
    return true;
  }

  /** @type {Direction[]} */
  const path = [];
  let nodes = 0;
  let budgetExhausted = false;

  /**
   * @param {number} g
   * @param {number} threshold
   * @param {number} lastDirection
   * @returns {number} The next threshold, or -1 when the goal was reached.
   */
  function search(g, threshold, lastDirection) {
    if (h === 0) return -1;
    const f = g + h;
    if (f > threshold) return f;
    if (++nodes > maxNodes) {
      budgetExhausted = true;
      return 0x7fffffff;
    }
    let childCount = 0;
    for (let d = 0; d < 4; d++) {
      if (lastDirection !== -1 && d === OPPOSITE[lastDirection]) continue;
      if (!apply(d)) continue;
      childDir[childCount] = d;
      childF[childCount] = g + 1 + h;
      childCount++;
      apply(OPPOSITE[d]);
    }
    // Insertion sort by child f (childCount <= 3): expanding the most
    // promising child first keeps the IDA* tree narrow.
    for (let i = 1; i < childCount; i++) {
      const d = childDir[i];
      const fv = childF[i];
      let j = i - 1;
      while (j >= 0 && childF[j] > fv) {
        childDir[j + 1] = childDir[j];
        childF[j + 1] = childF[j];
        j--;
      }
      childDir[j + 1] = d;
      childF[j + 1] = fv;
    }
    let min = 0x7fffffff;
    // Snapshot the sorted children into per-call locals: the shared scratch
    // arrays are rewritten by every recursive call, so reading them after the
    // first child's subtree returns would see that subtree's children. All
    // FOUR slots are snapshotted: at the search root the undo-prune is
    // disabled, so an interior blank yields four children — dropping the
    // fourth silently skipped the optimal first move whenever it sorted last,
    // inflating both the threshold ladder (node explosions, 'budget' results)
    // and the returned par (suboptimal, breaking the parKind "optimal"
    // contract), and made the reference agent's per-turn re-solves cycle.
    const first = childDir[0];
    const second = childDir[1];
    const third = childDir[2];
    const fourth = childDir[3];
    for (let i = 0; i < childCount; i++) {
      const direction = i === 0 ? first : i === 1 ? second : i === 2 ? third : fourth;
      apply(direction);
      path.push(DIRECTIONS[direction]);
      const result = search(g + 1, threshold, direction);
      if (result === -1) return -1;
      if (result < min) min = result;
      path.pop();
      apply(OPPOSITE[direction]);
      if (budgetExhausted) return 0x7fffffff;
    }
    return min;
  }

  let threshold = h;
  while (threshold <= 120) {
    const result = search(0, threshold, -1);
    if (result === -1) {
      return { moves: /** @type {Direction[]} */ (path.slice()), count: nodes };
    }
    if (budgetExhausted) {
      return { moves: null, count: nodes, status: 'budget' };
    }
    threshold = result;
  }
  return { moves: null, count: nodes, status: 'budget' };
}

/**
 * @param {readonly number[]} flat
 * @param {number} n
 * @returns {number}
 */
function manhattanFlat(flat, n) {
  let h = 0;
  for (let i = 0; i < flat.length; i++) {
    const v = flat[i];
    if (v === 0) continue;
    const goalRow = Math.floor((v - 1) / n);
    const goalCol = (v - 1) % n;
    h += Math.abs(Math.floor(i / n) - goalRow) + Math.abs((i % n) - goalCol);
  }
  return h;
}
