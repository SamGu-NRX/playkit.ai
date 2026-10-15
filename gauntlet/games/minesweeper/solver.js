/**
 * Minesweeper deduction solver: the single source of truth for what counts as
 * "clearable by logic alone". Three escalating layers:
 *
 *   1. single-cell rules — a revealed number with all its mines flagged (so
 *      its other hidden neighbours are safe), or with all its hidden
 *      neighbours mined (so the number is satisfied);
 *   2. subset deduction — when one frontier constraint's cells are a subset
 *      of another's, the difference cells are all safe (equal counts) or all
 *      mines (the count difference exhausts them);
 *   3. exact enumeration — when 1 and 2 stall, enumerate every configuration
 *      of each connected frontier component that satisfies its constraints
 *      and turn it into per-cell mine probabilities, weighted by the number
 *      of ways the remaining mines can sit outside the component.
 *
 * The no-guess generator uses only layers 1 and 2 (`logicalPass`), so a board
 * it accepts is provably clearable without any probabilistic guess. The
 * engine baseline additionally uses layer 3 (`mineProbabilities`) when
 * deduction stalls. Everything here is pure and `node:*`-free.
 *
 * Views are integer arrays, one entry per cell (row-major, index = row *
 * cols + column):
 *
 *   - `HIDDEN` (-1)  an unrevealed, unflagged cell
 *   - `FLAG`   (-2)  a flagged cell
 *   - `0..8`         a revealed cell showing its adjacent mine count
 *
 * @module
 */

/** An unrevealed, unflagged cell. */
export const HIDDEN = -1;
/** A flagged (still unrevealed) cell. */
export const FLAG = -2;

/**
 * Memoized neighbour lists per geometry. Pure lookups; the cache is bounded
 * by the handful of geometries a process actually sees.
 *
 * @type {Map<string, number[][]>}
 */
const NEIGHBOR_CACHE = new Map();

/**
 * Adjacency lists for a grid. With `wrap` the grid is a torus: row -1 is row
 * rows - 1 and column -1 is column cols - 1, so every cell has exactly 8
 * neighbours. Without wrap, edge and corner cells have 5 and 3.
 *
 * @param {number} rows
 * @param {number} cols
 * @param {boolean} wrap
 * @returns {number[][]} For each cell index, the indices of its neighbours.
 */
export function neighborLists(rows, cols, wrap) {
  const key = `${rows}x${cols}x${wrap ? 'torus' : 'plane'}`;
  const cached = NEIGHBOR_CACHE.get(key);
  if (cached) return cached;
  /** @type {number[][]} */
  const lists = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      /** @type {number[]} */
      const list = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          let nr = r + dr;
          let nc = c + dc;
          if (wrap) {
            nr = ((nr % rows) + rows) % rows;
            nc = ((nc % cols) + cols) % cols;
          } else if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) {
            continue;
          }
          list.push(nr * cols + nc);
        }
      }
      lists.push(list);
    }
  }
  NEIGHBOR_CACHE.set(key, lists);
  return lists;
}

/**
 * @typedef {object} Constraint
 * @property {number[]} cells Indices of hidden cells the constraint covers.
 * @property {number} count How many of them are mines.
 */

/**
 * @typedef {object} Deduction
 * @property {number[]} safe Cells proven mine-free (currently hidden).
 * @property {number[]} mines Cells proven to hold mines (currently hidden).
 */

/**
 * Collect the frontier constraints from a view: one per revealed numbered
 * cell with hidden neighbours, counting its unflagged hidden neighbours.
 *
 * @param {number[]} view
 * @param {number[][]} neighbors
 * @param {Set<number>} [excludeSafe] Cells already proven safe this pass.
 * @param {Set<number>} [excludeMines] Cells already proven mined this pass.
 * @returns {{ constraints: Constraint[], hidden: number[], flagCount: number }}
 */
function buildConstraints(view, neighbors, excludeSafe, excludeMines) {
  /** @type {Constraint[]} */
  const constraints = [];
  /** @type {number[]} */
  const hidden = [];
  let flagCount = 0;
  for (let i = 0; i < view.length; i++) {
    const v = view[i];
    if (v === HIDDEN) {
      if (!excludeSafe?.has(i) && !excludeMines?.has(i)) hidden.push(i);
      continue;
    }
    if (v === FLAG) {
      flagCount++;
      continue;
    }
    let count = v;
    /** @type {number[]} */
    const cells = [];
    for (const j of neighbors[i]) {
      const vj = view[j];
      if (vj === FLAG || excludeMines?.has(j)) {
        count--;
      } else if (vj === HIDDEN && !excludeSafe?.has(j)) {
        cells.push(j);
      }
    }
    if (cells.length > 0) constraints.push({ cells, count });
  }
  return { constraints, hidden, flagCount };
}

/**
 * Layers 1 and 2: deduce everything provable by single-cell and subset
 * rules, to a fixpoint. Never guesses; returns empty lists exactly when
 * deduction stalls. This is the function the no-guess generator trusts: a
 * board it can clear from the opening using only this pass needs no guesses.
 *
 * @param {number[]} view Current visible view (numbers, HIDDEN, FLAG).
 * @param {number[][]} neighbors Neighbor lists from `neighborLists`.
 * @param {number} minesTotal Total mines on the board (public information).
 * @returns {Deduction}
 */
export function logicalPass(view, neighbors, minesTotal) {
  const total = view.length;
  /** @type {Set<number>} */
  const safe = new Set();
  /** @type {Set<number>} */
  const mines = new Set();

  for (;;) {
    const { constraints, hidden, flagCount } = buildConstraints(
      view,
      neighbors,
      safe,
      mines
    );
    /** @type {boolean} */
    let changed = false;

    // Global mine-count rules: if the remaining mines exactly fill (or are
    // absent from) the undecided hidden cells, every one of them is decided.
    const minesRemaining = minesTotal - flagCount;
    if (hidden.length > 0) {
      if (minesRemaining === 0) {
        for (const c of hidden) safe.add(c);
        changed = true;
      } else if (minesRemaining === hidden.length) {
        for (const c of hidden) mines.add(c);
        changed = true;
      }
    }

    // Layer 1: trivial constraints.
    for (const con of constraints) {
      if (con.count === 0) {
        for (const c of con.cells) if (!safe.has(c)) { safe.add(c); changed = true; }
      } else if (con.count === con.cells.length) {
        for (const c of con.cells) if (!mines.has(c)) { mines.add(c); changed = true; }
      }
    }

    // Layer 2: subset deduction between frontier constraints.
    for (let a = 0; a < constraints.length; a++) {
      const A = constraints[a];
      if (A.cells.length === 0) continue;
      const setA = new Set(A.cells);
      for (let b = 0; b < constraints.length; b++) {
        if (a === b) continue;
        const B = constraints[b];
        if (B.cells.length <= A.cells.length) continue;
        if (!A.cells.every((c) => setBhas(B, c))) continue;
        const rest = B.cells.filter((c) => !setA.has(c));
        if (rest.length === 0) continue;
        const diff = B.count - A.count;
        if (diff === 0) {
          for (const c of rest) if (!safe.has(c)) { safe.add(c); changed = true; }
        } else if (diff === rest.length) {
          for (const c of rest) if (!mines.has(c)) { mines.add(c); changed = true; }
        }
      }
    }

    if (!changed) break;
  }

  return { safe: [...safe], mines: [...mines] };
}

/**
 * @param {Constraint} con
 * @param {number} cell
 * @returns {boolean}
 */
function setBhas(con, cell) {
  return con.cells.includes(cell);
}

/**
 * Layer 1 only (single-cell rules, plus the global mine-count rule): the
 * greedy baseline's deduction layer. Everything it returns is also returned
 * by `logicalPass`; it exists so the greedy baseline is strictly weaker than
 * the engine by construction.
 *
 * @param {number[]} view
 * @param {number[][]} neighbors
 * @param {number} minesTotal
 * @returns {Deduction}
 */
export function singleCellPass(view, neighbors, minesTotal) {
  const { constraints, hidden, flagCount } = buildConstraints(view, neighbors);
  /** @type {Set<number>} */
  const safe = new Set();
  /** @type {Set<number>} */
  const mines = new Set();
  const minesRemaining = minesTotal - flagCount;
  if (hidden.length > 0) {
    if (minesRemaining === 0) for (const c of hidden) safe.add(c);
    else if (minesRemaining === hidden.length) for (const c of hidden) mines.add(c);
  }
  for (const con of constraints) {
    if (con.count === 0) for (const c of con.cells) safe.add(c);
    else if (con.count === con.cells.length) for (const c of con.cells) mines.add(c);
  }
  return { safe: [...safe], mines: [...mines] };
}

/**
 * log(n!) for 0..n, shared by the enumeration weights.
 *
 * @param {number} n
 * @returns {number[]}
 */
function logFactorials(n) {
  const lf = new Array(n + 1);
  lf[0] = 0;
  for (let i = 1; i <= n; i++) lf[i] = lf[i - 1] + Math.log(i);
  return lf;
}

/**
 * @typedef {object} ProbabilityResult
 * @property {Map<number, number> | null} probabilities P(mine) per hidden
 *   cell (null map when the view is inconsistent, e.g. more flags than
 *   mines). Never missing a hidden cell.
 * @property {boolean} exact True when every frontier component enumerated
 *   within the configuration budget; false means some cells carry the
 *   uniform leftover estimate instead of exact probabilities.
 */

/**
 * Layer 3: exact per-component enumeration of frontier configurations for
 * mine probabilities, for when `logicalPass` stalls. Each connected
 * component of constraints is enumerated exhaustively (within `maxConfigs`
 * configurations, pruned by constraint propagation). A configuration with m
 * mines weighs C(outsideCount, minesRemaining - m) — the number of ways the
 * component's unused mines can sit outside all enumerated components — so
 * per-component probabilities are exact, and exact up to the standard
 * independence approximation between components when there are several.
 * Cells in no constraint share the leftover expected mines uniformly.
 *
 * Weights are aggregated as integer mine-counts per configuration-mine-total
 * and normalized in log space, so no intermediate overflows even when the
 * combinatorial weights are astronomically large.
 *
 * @param {number[]} view
 * @param {number[][]} neighbors
 * @param {number} minesTotal
 * @param {number} [maxConfigs] Default 200000; a component that exceeds the
 *   budget falls back to the uniform leftover estimate instead of exact
 *   probabilities.
 * @returns {ProbabilityResult}
 */
export function mineProbabilities(view, neighbors, minesTotal, maxConfigs = 200000) {
  const { constraints, hidden, flagCount } = buildConstraints(view, neighbors);
  const minesRemaining = minesTotal - flagCount;
  /** @type {Map<number, number>} */
  const probabilities = new Map();
  if (minesRemaining < 0 || minesRemaining > hidden.length) {
    return { probabilities: null, exact: false };
  }
  if (constraints.length === 0) {
    const p = hidden.length > 0 ? minesRemaining / hidden.length : 0;
    for (const c of hidden) probabilities.set(c, p);
    return { probabilities, exact: false };
  }

  // Group constraints into components connected through shared cells.
  /** @type {Map<number, number[]>} */
  const cellCons = new Map();
  constraints.forEach((con, ci) => {
    for (const c of con.cells) {
      const list = cellCons.get(c);
      if (list) list.push(ci);
      else cellCons.set(c, [ci]);
    }
  });
  const seenConstraint = constraints.map(() => false);
  /** @type {Set<number>} */
  const inComponent = new Set();
  /** @type {number[][]} */
  const components = [];
  for (let start = 0; start < constraints.length; start++) {
    if (seenConstraint[start]) continue;
    /** @type {number[]} */
    const group = [start];
    seenConstraint[start] = true;
    for (let qi = 0; qi < group.length; qi++) {
      for (const c of constraints[group[qi]].cells) {
        for (const cj of /** @type {number[]} */ (cellCons.get(c))) {
          if (!seenConstraint[cj]) {
            seenConstraint[cj] = true;
            group.push(cj);
          }
        }
      }
    }
    for (const ci of group) {
      for (const c of constraints[ci].cells) inComponent.add(c);
    }
    components.push(group);
  }

  const outside = hidden.filter((c) => !inComponent.has(c));
  const outsideCount = outside.length;
  const lf = logFactorials(outsideCount + minesRemaining + 1);

  /**
   * log C(n, k), or -Infinity when k is out of range.
   * @param {number} n
   * @param {number} k
   * @returns {number}
   */
  const logC = (n, k) =>
    k < 0 || k > n ? -Infinity : lf[n] - lf[k] - lf[n - k];

  let exact = true;
  let expectedComponentMines = 0;

  for (const group of components) {
    // Local indexing for the component.
    /** @type {number[]} */
    const cells = [];
    for (const ci of group) {
      for (const c of constraints[ci].cells) if (!cells.includes(c)) cells.push(c);
    }
    const localIndex = new Map(cells.map((c, i) => [c, i]));
    const n = cells.length;
    const localConstraints = group.map((ci) => ({
      count: constraints[ci].count,
      cells: constraints[ci].cells.map((c) => /** @type {number} */ (localIndex.get(c))),
    }));

    // Order cells by how many constraints cover them (most constrained
    // first) so pruning bites early.
    const order = cells
      .map((_, i) => i)
      .sort(
        (a, b) =>
          localConstraints.filter((con) => con.cells.includes(b)).length -
          localConstraints.filter((con) => con.cells.includes(a)).length
      );
    const consOf = order.map((cellLocal) =>
      localConstraints
        .map((con, ci) => (con.cells.includes(cellLocal) ? ci : -1))
        .filter((ci) => ci >= 0)
    );

    // Enumerate with constraint propagation, aggregating integer mine-counts
    // per configuration-mine-total m (weights depend only on m).
    /** @type {Map<number, Int32Array>} */
    const mineCountsByM = new Map();
    /** @type {Map<number, number>} */
    const configsByM = new Map();
    const conMines = localConstraints.map(() => 0);
    const conRemaining = localConstraints.map((con) => con.cells.length);
    /** @type {Int8Array} */
    const assigned = new Int8Array(n);
    let configs = 0;
    let overflowed = false;

    /**
     * @param {number} oi Index into `order`.
     * @param {number} m Mines placed so far.
     * @returns {void}
     */
    const dfs = (oi, m) => {
      if (overflowed) return;
      if (oi === n) {
        if (minesRemaining - m < 0 || minesRemaining - m > outsideCount) return;
        configs++;
        if (configs > maxConfigs) {
          overflowed = true;
          return;
        }
        let tally = mineCountsByM.get(m);
        if (!tally) {
          tally = new Int32Array(n);
          mineCountsByM.set(m, tally);
          configsByM.set(m, 0);
        }
        configsByM.set(m, /** @type {number} */ (configsByM.get(m)) + 1);
        for (let i = 0; i < n; i++) if (assigned[i] === 1) tally[i]++;
        return;
      }
      if (m > minesRemaining) return; // more mines than can fit globally
      const cellLocal = order[oi];
      for (const choice of [0, 1]) {
        let ok = true;
        for (const ci of consOf[oi]) {
          conMines[ci] += choice;
          conRemaining[ci]--;
          if (
            conMines[ci] > localConstraints[ci].count ||
            localConstraints[ci].count - conMines[ci] > conRemaining[ci]
          ) {
            ok = false;
          }
        }
        if (ok) {
          assigned[cellLocal] = choice;
          dfs(oi + 1, m + choice);
          assigned[cellLocal] = -1;
        }
        for (const ci of consOf[oi]) {
          conMines[ci] -= choice;
          conRemaining[ci]++;
        }
      }
    };

    dfs(0, 0);

    if (overflowed || mineCountsByM.size === 0) {
      // Enumeration failed: fall back to the uniform leftover estimate for
      // this component's cells.
      exact = false;
      const p = hidden.length > 0 ? minesRemaining / hidden.length : 0;
      for (const c of cells) probabilities.set(c, p);
      continue;
    }

    // Normalize in log space: weight(m) = C(outside, remaining - m).
    let maxLog = -Infinity;
    for (const m of mineCountsByM.keys()) {
      const lw = logC(outsideCount, minesRemaining - m);
      if (lw > maxLog) maxLog = lw;
    }
    /** Unnormalized combinatorial weight per mine-total. */
    const factorByM = new Map();
    let totalWeight = 0;
    let weightedMineTotal = 0;
    for (const [m, count] of configsByM) {
      const factor = Math.exp(logC(outsideCount, minesRemaining - m) - maxLog);
      factorByM.set(m, factor);
      totalWeight += factor * count;
      weightedMineTotal += factor * count * m;
    }
    const tallyTotal = new Float64Array(n);
    for (const [m, tally] of mineCountsByM) {
      const factor = /** @type {number} */ (factorByM.get(m));
      for (let i = 0; i < n; i++) tallyTotal[i] += factor * tally[i];
    }
    expectedComponentMines += totalWeight > 0 ? weightedMineTotal / totalWeight : 0;
    for (let i = 0; i < n; i++) {
      probabilities.set(cells[i], totalWeight > 0 ? tallyTotal[i] / totalWeight : 0);
    }
  }

  // Cells outside every constraint share the expected leftover mines.
  if (outsideCount > 0) {
    const leftover = Math.min(
      Math.max(minesRemaining - expectedComponentMines, 0),
      outsideCount
    );
    const p = leftover / outsideCount;
    for (const c of outside) probabilities.set(c, p);
  }

  return { probabilities, exact };
}
