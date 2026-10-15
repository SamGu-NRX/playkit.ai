/**
 * Sokoban solver: breadth-first search over (player position, box positions)
 * states for the minimum number of player moves (pushes and walks alike)
 * until every box stands on a goal.
 *
 * Pruning, all of it safe (it can only discard provably unsolvable states):
 * - **Dead squares** — squares from which a box can never reach any goal even
 *   with an otherwise empty floor, computed by a reverse push-BFS from the
 *   goals. Corner deadlocks are their special case.
 * - **Freeze deadlocks** — after a push, a box blocked along both axes by
 *   walls and/or permanently immobile boxes, standing off a goal, can never
 *   move again, so the state is unsolvable.
 *
 * A node budget bounds the search; exhausting it throws a
 * `SolverBudgetError` (loudly, by design — silent truncation would corrupt
 * par values). Pure JS (no `node:*`): the browser overlay loads this module.
 *
 * @module
 */

/** @typedef {'up' | 'down' | 'left' | 'right'} Direction */

/**
 * A static Sokoban level: the walls and goals of a rectangular board.
 * Board indices are `row * width + column`. The border is always wall.
 *
 * @typedef {object} SokobanLevel
 * @property {number} width Board width including the wall border.
 * @property {number} height Board height including the wall border.
 * @property {number[]} walls Sorted board indices of wall squares.
 * @property {number[]} goals Sorted board indices of goal squares.
 */

/**
 * A board position to solve from.
 *
 * @typedef {object} SokobanPosition
 * @property {number} player Player square index.
 * @property {number[]} boxes Sorted box square indices.
 */

/**
 * The solver's verdict on a position.
 *
 * @typedef {object} SolveResult
 * @property {boolean} solvable True when every box can reach a goal.
 * @property {number | null} par Minimum number of player moves when solvable.
 * @property {string[] | null} plan The optimal move sequence when requested
 *   and solvable, null otherwise.
 * @property {number} nodes Unique states the search visited.
 */

/**
 * Thrown when the search exceeds its node budget.
 */
export class SolverBudgetError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'SolverBudgetError';
  }
}

/**
 * @param {number} width
 * @returns {Record<Direction, number>} Move delta per direction, for indices
 *   laid out as `row * width + column`. The always-walled border makes the
 *   horizontal deltas safe (no row wraparound).
 */
export function deltasFor(width) {
  return { up: -width, down: width, left: -1, right: 1 };
}

const DIRECTION_NAMES = /** @type {Direction[]} */ (['up', 'down', 'left', 'right']);

/**
 * Parse an XSB board into a level and position. Legend: `#` wall, `@` player,
 * `+` player on goal, `$` box, `*` box on goal, `.` goal, space floor.
 * Rows may be ragged; short rows are padded with wall.
 *
 * @param {string} text
 * @returns {{ level: SokobanLevel, player: number, boxes: number[] }}
 */
export function parseXsb(text) {
  const rows = text
    .split('\n')
    .map((r) => r.replace(/\r$/, ''))
    .map((r) => (r.trim().length === 0 ? '' : r));
  while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
  while (rows.length > 0 && rows[0].length === 0) rows.shift();
  if (rows.length === 0) throw new Error('parseXsb: empty board');
  const height = rows.length;
  const width = Math.max(...rows.map((r) => r.length));
  /** @type {number[]} */
  const walls = [];
  /** @type {number[]} */
  const goals = [];
  /** @type {number[]} */
  const boxes = [];
  let player = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const c = x < rows[y].length ? rows[y][x] : '#';
      if (c === '#') walls.push(i);
      if (c === '.' || c === '+' || c === '*') goals.push(i);
      if (c === '$' || c === '*') boxes.push(i);
      if (c === '@' || c === '+') player = i;
    }
  }
  if (player < 0) throw new Error('parseXsb: board has no player');
  walls.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  return { level: { width, height, walls, goals }, player, boxes };
}

/**
 * Render a position as XSB text (same legend as parseXsb).
 *
 * @param {SokobanLevel} level
 * @param {number} player
 * @param {readonly number[]} boxes
 * @returns {string}
 */
export function renderXsb(level, player, boxes) {
  const { width, height, walls, goals } = level;
  const wallSet = new Set(walls);
  const goalSet = new Set(goals);
  const boxSet = new Set(boxes);
  /** @type {string[]} */
  const rows = [];
  for (let y = 0; y < height; y++) {
    /** @type {string[]} */
    const row = [];
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const isWall = wallSet.has(i);
      const isGoal = goalSet.has(i);
      const isBox = boxSet.has(i);
      const isPlayer = i === player;
      if (isWall) row.push('#');
      else if (isPlayer) row.push(isGoal ? '+' : '@');
      else if (isBox) row.push(isGoal ? '*' : '$');
      else if (isGoal) row.push('.');
      else row.push(' ');
    }
    rows.push(row.join(''));
  }
  return rows.join('\n');
}

/**
 * Squares from which a box can never reach any goal, computed by reverse
 * push-reachability from the goals with an otherwise empty floor. A push
 * from p to q = p + d needs the player standing on p - d, so p is a
 * predecessor of q iff p and q are floor and p - d is floor.
 *
 * @param {SokobanLevel} level
 * @returns {Uint8Array} Per board square, 1 when the square is dead.
 */
export function deadSquares(level) {
  const { width, height, walls, goals } = level;
  const size = width * height;
  const isFloor = new Uint8Array(size);
  for (let i = 0; i < size; i++) isFloor[i] = 1;
  for (const w of walls) isFloor[w] = 0;
  const live = new Uint8Array(size);
  const d = deltasFor(width);
  const deltas = [d.up, d.down, d.left, d.right];
  /** @type {number[]} */
  const queue = [];
  for (const g of goals) {
    if (!live[g]) {
      live[g] = 1;
      queue.push(g);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const q = queue[head];
    for (const delta of deltas) {
      const p = q - delta; // the box came from p, pushed toward q
      const playerSquare = p - delta;
      if (p < 0 || p >= size || playerSquare < 0 || playerSquare >= size) continue;
      if (!isFloor[p] || !isFloor[playerSquare]) continue;
      if (!live[p]) {
        live[p] = 1;
        queue.push(p);
      }
    }
  }
  const dead = new Uint8Array(size);
  for (let i = 0; i < size; i++) dead[i] = isFloor[i] && !live[i] ? 1 : 0;
  return dead;
}

/**
 * Whether the box at `box` is frozen: blocked along both axes by walls and/or
 * boxes that are themselves frozen. Boxes under examination are treated as
 * walls via a per-chain treated set, so mutual-immobility cycles terminate.
 * Conservative: a movable box is never reported frozen.
 *
 * @param {number} box Board index of the box to test.
 * @param {Set<number>} boxes Current box positions.
 * @param {Uint8Array} isFloor 1 when the square is floor.
 * @param {number} width Board width.
 * @param {Set<number>} treated Boxes treated as walls in this chain.
 * @returns {boolean}
 */
function isFrozen(box, boxes, isFloor, width, treated) {
  const d = deltasFor(width);
  const horizontal = axisBlocked(box, d.left, d.right, boxes, isFloor, width, treated);
  const vertical = axisBlocked(box, d.up, d.down, boxes, isFloor, width, treated);
  return horizontal && vertical;
}

/**
 * Whether the box at `box` can never be pushed along the axis through the two
 * opposite deltas. A wall on either side blocks the whole axis (a push along
 * it needs that square free, or needs the player standing there); a frozen
 * neighbor box on the axis blocks it too.
 *
 * @param {number} box
 * @param {number} d1 One axis delta.
 * @param {number} d2 The opposite axis delta.
 * @param {Set<number>} boxes
 * @param {Uint8Array} isFloor
 * @param {number} width
 * @param {Set<number>} treated
 * @returns {boolean}
 */
function axisBlocked(box, d1, d2, boxes, isFloor, width, treated) {
  const a = box + d1;
  const b = box + d2;
  if (!isFloor[a] || !isFloor[b]) return true;
  for (const n of [a, b]) {
    if (boxes.has(n) && !treated.has(n)) {
      const next = new Set(treated);
      next.add(n);
      if (isFrozen(n, boxes, isFloor, width, next)) return true;
    }
  }
  return false;
}

/**
 * Solve a position: the minimum number of player moves (walks and pushes
 * count equally) until every box is on a goal.
 *
 * @param {SokobanLevel} level
 * @param {SokobanPosition} position
 * @param {{ nodeBudget?: number, prune?: boolean, plan?: boolean }} [options]
 *   `nodeBudget` caps visited states (default 3,000,000; exceeding it throws
 *   SolverBudgetError). `prune` enables dead-square and freeze pruning
 *   (default true). `plan` also reconstructs the move sequence (default
 *   false — generation only needs the count).
 * @returns {SolveResult}
 * @throws {SolverBudgetError} when the node budget runs out.
 */
export function solve(level, position, options = {}) {
  const { nodeBudget = 3000000, prune = true, plan = false } = options;
  const { width, height, walls, goals } = level;
  const size = width * height;
  const isFloor = new Uint8Array(size);
  for (let i = 0; i < size; i++) isFloor[i] = 1;
  for (const w of walls) isFloor[w] = 0;
  const goalSet = new Set(goals);
  const dead = prune ? deadSquares(level) : null;

  const startBoxes = [...position.boxes].sort((a, b) => a - b);
  if (startBoxes.length === 0 || startBoxes.every((b) => goalSet.has(b))) {
    return { solvable: true, par: 0, plan: plan ? [] : null, nodes: 1 };
  }
  if (prune && dead) {
    for (const b of startBoxes) {
      if (dead[b]) return { solvable: false, par: null, plan: null, nodes: 1 };
    }
  }

  const deltaList = Object.values(deltasFor(width));
  /** @type {Map<string, { prev: string, move: string }> | null} */
  const parents = plan ? new Map() : null;
  const startKey = stateKey(position.player, startBoxes);

  /** @type {{ player: number, boxes: number[] }[]} */
  let frontier = [{ player: position.player, boxes: startBoxes }];
  /** @type {Set<string>} */
  const visited = new Set([startKey]);
  let depth = 0;
  let nodes = 1;

  while (frontier.length > 0) {
    depth++;
    /** @type {{ player: number, boxes: number[] }[]} */
    const next = [];
    for (const { player, boxes } of frontier) {
      const boxSet = new Set(boxes);
      const fromKey = stateKey(player, boxes);
      for (let di = 0; di < 4; di++) {
        const delta = deltaList[di];
        const target = player + delta;
        if (target < 0 || target >= size || !isFloor[target]) continue;
        /** @type {number[] | null} */
        let nextBoxes = null;
        if (boxSet.has(target)) {
          const into = target + delta;
          if (into < 0 || into >= size || !isFloor[into]) continue;
          if (boxSet.has(into)) continue;
          if (prune && dead && dead[into]) continue;
          nextBoxes = boxes.filter((b) => b !== target);
          nextBoxes.push(into);
          nextBoxes.sort((a, b) => a - b);
          // A box frozen on its goal needs no further moves; only an
          // off-goal frozen box is a deadlock.
          if (prune && !goalSet.has(into) && isFrozen(into, new Set(nextBoxes), isFloor, width, new Set([into]))) {
            continue;
          }
        }
        const key = stateKey(target, nextBoxes ?? boxes);
        if (visited.has(key)) continue;
        visited.add(key);
        nodes++;
        if (nodes > nodeBudget) {
          throw new SolverBudgetError(
            `sokoban solver exceeded its node budget of ${nodeBudget} states at depth ${depth}`
          );
        }
        if (parents) parents.set(key, { prev: fromKey, move: DIRECTION_NAMES[di] });
        if ((nextBoxes ?? boxes).every((b) => goalSet.has(b))) {
          return {
            solvable: true,
            par: depth,
            plan: parents ? reconstructPlan(parents, key, startKey) : null,
            nodes,
          };
        }
        next.push({ player: target, boxes: nextBoxes ?? boxes });
      }
    }
    frontier = next;
  }
  return { solvable: false, par: null, plan: null, nodes };
}

/**
 * @param {number} player
 * @param {readonly number[]} boxes Sorted.
 * @returns {string}
 */
function stateKey(player, boxes) {
  return `${player}:${boxes.join(',')}`;
}

/**
 * @param {Map<string, { prev: string, move: string }>} parents
 * @param {string} key
 * @param {string} startKey
 * @returns {string[]}
 */
function reconstructPlan(parents, key, startKey) {
  /** @type {string[]} */
  const moves = [];
  let cursor = key;
  while (cursor !== startKey) {
    const step = parents.get(cursor);
    if (!step) break;
    moves.push(step.move);
    cursor = step.prev;
  }
  return moves.reverse();
}
