/**
 * Single-line Nonogram deduction primitives.
 *
 * Cell codes used across the game: 0 = unknown, 1 = filled, 2 = crossed
 * (marked definitively empty). A line is solved by enumerating, with a
 * dynamic program, which cells can be filled in at least one placement of
 * the runs and which can be blank in at least one placement; a cell that can
 * only take one state is forced.
 *
 * Pure JS, no `node:*` — the browser overlay loads this module.
 *
 * @module
 */

/**
 * @typedef {object} LineDeduction
 * @property {boolean} ok False when the cells contradict the clue.
 * @property {Uint8Array} forced The line with every forced cell applied
 *   (unknown cells that can take both states are left as they were).
 */

/**
 * Deduce the forced cells of one line. The input array is never mutated.
 *
 * @param {number[]} clue Run lengths; [] or [0] means an empty line.
 * @param {Uint8Array} cells Current cells (0 unknown, 1 filled, 2 crossed).
 * @returns {LineDeduction}
 */
export function deduceLine(clue, cells) {
  const len = cells.length;
  const runs = clue.length === 1 && clue[0] === 0 ? [] : clue;
  const k = runs.length;

  // Prefix counts for O(1) range checks.
  /** @type {Int32Array} */
  const fillPre = new Int32Array(len + 1);
  /** @type {Int32Array} */
  const crossPre = new Int32Array(len + 1);
  for (let i = 0; i < len; i++) {
    fillPre[i + 1] = fillPre[i] + (cells[i] === 1 ? 1 : 0);
    crossPre[i + 1] = crossPre[i] + (cells[i] === 2 ? 1 : 0);
  }
  /** @param {number} lo @param {number} hi @returns {number} */
  const filledIn = (lo, hi) => fillPre[hi] - fillPre[lo];
  /** @param {number} lo @param {number} hi @returns {number} */
  const crossedIn = (lo, hi) => crossPre[hi] - crossPre[lo];

  // canPlace[i][j]: runs j..k-1 fit in cells[i..len-1]. Computed backwards.
  const stride = k + 1;
  /** @type {Uint8Array} */
  const canPlace = new Uint8Array((len + 2) * stride);
  for (let i = len; i >= 0; i--) {
    canPlace[i * stride + k] = filledIn(i, len) === 0 ? 1 : 0;
  }
  for (let j = k - 1; j >= 0; j--) {
    const run = runs[j];
    for (let i = len - 1; i >= 0; i--) {
      let ok = 0;
      // Leave cell i blank.
      if (cells[i] !== 1 && canPlace[(i + 1) * stride + j]) ok = 1;
      // Or start run j at cell i.
      const end = i + run;
      if (
        ok === 0 &&
        end <= len &&
        crossedIn(i, end) === 0 &&
        (end === len || cells[end] !== 1) &&
        canPlace[Math.min(end + 1, len) * stride + j + 1]
      ) {
        ok = 1;
      }
      canPlace[i * stride + j] = ok;
    }
  }
  if (!canPlace[0 * stride + 0]) {
    return { ok: false, forced: Uint8Array.from(cells) };
  }

  // Forward reachability and forced-state marking.
  const forced = Uint8Array.from(cells);
  /** @type {Uint8Array} */
  const canBeFilled = new Uint8Array(len);
  /** @type {Uint8Array} */
  const canBeBlank = new Uint8Array(len);
  // reachable[i][j]: a placement of runs 0..j-1 occupies cells[0..i-1].
  /** @type {Uint8Array} */
  const reachable = new Uint8Array((len + 2) * stride);
  reachable[0] = 1;
  for (let i = 0; i <= len; i++) {
    for (let j = 0; j <= k; j++) {
      if (!reachable[i * stride + j]) continue;
      // Blank transition: cell i is blank, runs j..k-1 continue at i+1.
      if (
        i < len &&
        cells[i] !== 1 &&
        canPlace[(i + 1) * stride + j]
      ) {
        canBeBlank[i] = 1;
        reachable[(i + 1) * stride + j] = 1;
      }
      // Run transition: run j fills cells[i..i+run-1].
      if (j < k) {
        const run = runs[j];
        const end = i + run;
        if (
          end <= len &&
          crossedIn(i, end) === 0 &&
          (end === len || cells[end] !== 1) &&
          canPlace[Math.min(end + 1, len) * stride + j + 1]
        ) {
          for (let c = i; c < end; c++) canBeFilled[c] = 1;
          reachable[Math.min(end + 1, len) * stride + j + 1] = 1;
          // An empty gap cell after the run also counts as blank when the
          // run is not at the line's end (the separating cell).
          if (end < len) {
            canBeBlank[end] = 1;
          }
        }
      }
    }
  }

  for (let i = 0; i < len; i++) {
    if (canBeFilled[i] && !canBeBlank[i]) forced[i] = 1;
    else if (!canBeFilled[i] && canBeBlank[i]) forced[i] = 2;
    else if (!canBeFilled[i] && !canBeBlank[i]) {
      return { ok: false, forced };
    }
  }
  return { ok: true, forced };
}

/**
 * Every placement of a line's runs, as '#'/'.' strings ('#' filled,
 * '.' blank). Enumerations are memoized per (length, clue) because
 * `legalActions` needs the same list every ply.
 *
 * @type {Map<string, string[]>}
 */
const PLACEMENTS_CACHE = new Map();

/**
 * @param {number} length Line length.
 * @param {number[]} clue Run lengths ([] or [0] for an empty line).
 * @returns {string[]} All clue-consistent patterns, in enumeration order
 *   (callers sort).
 */
export function linePatterns(length, clue) {
  const runs = clue.length === 1 && clue[0] === 0 ? [] : clue;
  const key = `${length}|${runs.join(',')}`;
  const cached = PLACEMENTS_CACHE.get(key);
  if (cached) return cached;
  /** @type {string[]} */
  const out = [];
  const chars = new Array(length).fill('.');
  /**
   * @param {number} pos Cell index to place from.
   * @param {number} j Run index.
   */
  const walk = (pos, j) => {
    if (j === runs.length) {
      for (let i = pos; i < length; i++) chars[i] = '.';
      out.push(chars.join(''));
      return;
    }
    // Slack: total extra blanks distributable in the remaining suffix.
    let remaining = runs[j];
    for (let m = j + 1; m < runs.length; m++) remaining += 1 + runs[m];
    for (let start = pos; start + remaining <= length; start++) {
      for (let i = pos; i < start; i++) chars[i] = '.';
      const end = start + runs[j];
      for (let i = start; i < end; i++) chars[i] = '#';
      if (j === runs.length - 1) {
        for (let i = end; i < length; i++) chars[i] = '.';
        out.push(chars.join(''));
      } else {
        chars[end] = '.'; // separator between this run and the next
        walk(end + 1, j + 1);
      }
    }
  };
  walk(0, 0);
  PLACEMENTS_CACHE.set(key, out);
  return out;
}

/**
 * Count the placements of a clue on a line of the given length, without
 * building them. Used in tests and by the generation probe.
 *
 * @param {number} length
 * @param {number[]} clue
 * @returns {number}
 */
export function linePatternCount(length, clue) {
  return linePatterns(length, clue).length;
}
