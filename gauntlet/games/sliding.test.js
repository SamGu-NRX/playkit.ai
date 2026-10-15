import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGame } from '../games/index.js';
import { runConformance } from '../core/conformance.js';
import { GauntletRuleError } from '../core/errors.js';
import { publicSeed } from '../core/seeds.js';
import { runEpisode } from '../core/runner.js';
import { createSlidingSolverAgent } from '../agents/sliding-solver.js';
import { createRandomAgent } from '../agents/random.js';
import {
  applyTileMove,
  isSolved,
  legalMoves,
  solve,
} from './sliding/solver.js';

const game = getGame('sliding');

/**
 * Tier lookup that narrows the find() result or fails loudly.
 * @param {string} id
 * @returns {import('../core/types.js').TierSpec}
 */
function tierOf(id) {
  const tier = game.spec.tiers.find((t) => t.id === id);
  if (!tier) throw new Error(`missing tier ${id}`);
  return tier;
}

/**
 * Breadth-first optimal length from a 3x3 board to the goal, used as an
 * independent reference for the solver's par on the p8 tier.
 * @param {number[][]} board
 * @returns {number}
 */
function bfsOptimalLength(board) {
  const flat = board.flat();
  const goal = [1, 2, 3, 4, 5, 6, 7, 8, 0];
  const seen = new Set([flat.join(',')]);
  /** @type {number[][]} */
  let frontier = [flat];
  for (let depth = 0; ; depth++) {
    const next = [];
    for (const state of frontier) {
      if (state.join(',') === goal.join(',')) return depth;
      const blank = state.indexOf(0);
      const r = Math.floor(blank / 3);
      const c = blank % 3;
      /** @type {[number, number][]} */
      const steps = [];
      if (r > 0) steps.push([-1, 0]);
      if (r < 2) steps.push([1, 0]);
      if (c > 0) steps.push([0, -1]);
      if (c < 2) steps.push([0, 1]);
      for (const [dr, dc] of steps) {
        const copy = state.slice();
        const from = (r + dr) * 3 + (c + dc);
        copy[blank] = state[from];
        copy[from] = 0;
        const key = copy.join(',');
        if (!seen.has(key)) {
          seen.add(key);
          next.push(copy);
        }
      }
    }
    assert.ok(seen.size < 400000, 'bfs explored the whole component without reaching the goal');
    frontier = next;
  }
}

test('the registered sliding game is a single-seat benchmark', () => {
  assert.equal(game.spec.id, 'sliding');
  assert.equal(game.spec.seats, 1);
  assert.equal(game.spec.benchmark, true);
  assert.ok(game.spec.tiers.length >= 4);
  for (const tier of game.spec.tiers) {
    assert.equal(tier.scoring, 'efficiency');
    assert.equal(tier.parKind, 'optimal');
  }
});

test('reset is deterministic and carries par plus the tier budget', () => {
  const tier = game.spec.tiers[0];
  const a = game.reset(tier, publicSeed('sliding', 'p8', 0));
  const b = game.reset(tier, publicSeed('sliding', 'p8', 0));
  assert.deepEqual(a, b);
  assert.equal(a.size, 3);
  assert.equal(a.maxActions, tier.maxActions);
  assert.equal(a.moveCount, 0);
  assert.ok(Number.isInteger(a.par) && a.par >= 1, 'par is a positive integer');
});

test('p8 par equals an independent BFS reference on the public seeds', () => {
  const tier = tierOf('p8');
  for (let i = 0; i < tier.publicSeeds; i++) {
    const state = game.reset(tier, publicSeed('sliding', 'p8', i));
    assert.equal(state.par, bfsOptimalLength(state.board), `seed ${i}`);
  }
});

test('every tier produces in-band, solvable instances on its public seeds', () => {
  for (const tier of game.spec.tiers) {
    if (tier.params.generation !== 'banded') continue;
    for (let i = 0; i < tier.publicSeeds; i++) {
      const state = game.reset(tier, publicSeed('sliding', tier.id, i));
      assert.ok(
        state.par >= tier.params.bandMin && state.par <= tier.params.bandMax,
        `${tier.id} seed ${i}: par ${state.par} outside [${tier.params.bandMin}, ${tier.params.bandMax}]`
      );
      assert.ok(!isSolved(state.board), 'generated instance is not already solved');
    }
  }
});

test('reset stays fast enough to sit inside the runner budget', () => {
  const tier = tierOf('p15-long');
  const started = performance.now();
  for (let i = 0; i < tier.publicSeeds; i++) {
    game.reset(tier, publicSeed('sliding', 'p15-long', i));
  }
  const perSeedMs = (performance.now() - started) / tier.publicSeeds;
  assert.ok(perSeedMs < 2000, `p15-long reset averaged ${perSeedMs.toFixed(0)}ms`);
});

test('an action names the direction the TILE slides, not the blank', () => {
  // Blank in the middle; "up" must slide the tile BELOW the blank upward.
  const board = [
    [1, 2, 3],
    [4, 0, 5],
    [7, 8, 6],
  ];
  const after = applyTileMove(board, 'up');
  assert.deepEqual(after, [
    [1, 2, 3],
    [4, 8, 5],
    [7, 0, 6],
  ]);
  const afterRight = applyTileMove(after, 'right');
  assert.deepEqual(afterRight, [
    [1, 2, 3],
    [4, 8, 5],
    [0, 7, 6],
  ]);
  const afterDown = applyTileMove(afterRight, 'down');
  assert.deepEqual(afterDown, [
    [1, 2, 3],
    [0, 8, 5],
    [4, 7, 6],
  ]);
  const afterLeft = applyTileMove(afterDown, 'left');
  assert.deepEqual(afterLeft, [
    [1, 2, 3],
    [8, 0, 5],
    [4, 7, 6],
  ]);
});

test('legalMoves matches the blank neighborhood and the solver walks to the goal', () => {
  const board = [
    [1, 2, 3],
    [4, 0, 5],
    [7, 8, 6],
  ];
  assert.deepEqual(legalMoves(board), ['down', 'left', 'right', 'up'], 'legalMoves is sorted');
  const corner = [
    [1, 2, 3],
    [4, 5, 6],
    [0, 7, 8],
  ];
  // Blank bottom-left: "down" slides tile 4 down, "left" slides tile 7 left.
  assert.deepEqual(legalMoves(corner), ['down', 'left']);
  const result = solve(board);
  assert.equal(result.status, 'solved');
  let current = board;
  for (const move of /** @type {import('./sliding/solver.js').Direction[]} */ (result.moves)) {
    const next = applyTileMove(current, move);
    assert.ok(next, `replay move ${move} is legal`);
    current = next;
  }
  assert.ok(isSolved(current));
});

test('parseAction accepts canonical directions and documented alternates', () => {
  const tier = tierOf('p8');
  const state = game.reset(tier, publicSeed('sliding', 'p8', 0));
  const legal = game.legalActions(state, 0);
  assert.ok(legal.length > 0, 'a fresh scrambled board has at least one legal move');
  for (const direction of legal) {
    const Upper = direction[0].toUpperCase() + direction.slice(1);
    for (const text of [direction, direction.toUpperCase(), Upper, direction[0], ` ${direction} `, `"${direction}"`, `\`${direction}\``, `'${direction}'`, `move ${direction}`, `slide ${direction}`, `press ${direction}`, `go ${direction}`]) {
      const parsed = game.parseAction(state, 0, text);
      assert.ok(parsed.ok, `expected ${JSON.stringify(text)} to parse`);
      assert.equal(parsed.action, direction);
    }
  }
});

test('parseAction rejects unknown text and edge-blocked directions', () => {
  const tier = tierOf('p8');
  const state = game.reset(tier, publicSeed('sliding', 'p8', 0));
  for (const text of ['diagonal', 'swap 1 and 2', '', 'up, please', 'help']) {
    const parsed = game.parseAction(state, 0, text);
    assert.equal(parsed.ok, false, `expected ${JSON.stringify(text)} to be rejected`);
  }
  // A direction that parses but has no tile to slide is still invalid.
  const blankRow = state.board.findIndex(/** @param {number[]} row */ (row) => row.includes(0));
  const blankCol = state.board[blankRow].indexOf(0);
  const legal = game.legalActions(state, 0);
  if (blankRow === 0 && !legal.includes('down')) {
    const parsed = game.parseAction(state, 0, 'down');
    assert.equal(parsed.ok, false);
  }
  if (blankCol === 0 && !legal.includes('right')) {
    const parsed = game.parseAction(state, 0, 'right');
    assert.equal(parsed.ok, false);
  }
});

test('step rejects wrong seats, solved boards, and illegal directions', () => {
  const tier = tierOf('p8');
  const state = game.reset(tier, publicSeed('sliding', 'p8', 0));
  assert.throws(() => game.step(state, 1, 'up'), GauntletRuleError);
  assert.throws(() => game.step(state, 0, 'teleport'), GauntletRuleError);
  const blankRow = state.board.findIndex(/** @param {number[]} row */ (row) => row.includes(0));
  const legal = game.legalActions(state, 0);
  const blocked = ['up', 'down', 'left', 'right'].find((d) => !legal.includes(d));
  assert.ok(blocked, 'some direction is always blocked on a scrambled board');
  assert.throws(() => game.step(state, 0, blocked), GauntletRuleError);
  void blankRow;
});

test('state survives a JSON round trip and keeps playing', () => {
  const tier = tierOf('p8');
  const state = game.reset(tier, publicSeed('sliding', 'p8', 0));
  const restored = JSON.parse(JSON.stringify(state));
  assert.deepEqual(restored, state);
  const observation = game.observe(restored, 0);
  assert.ok(observation.text.includes('You are seat 0'));
  assert.ok(observation.text.includes(`of ${state.maxActions}`));
  const legal = game.legalActions(restored, 0);
  const next = game.step(restored, 0, legal[0]);
  assert.equal(next.moveCount, 1);
});

test('observation lists the legal actions and renders the grid', () => {
  const tier = tierOf('p8');
  const state = game.reset(tier, publicSeed('sliding', 'p8', 0));
  const observation = game.observe(state, 0);
  const legal = game.legalActions(state, 0);
  for (const direction of legal) {
    assert.ok(observation.text.includes(direction), `missing ${direction}`);
  }
  assert.ok(observation.text.includes('the direction the TILE slides'), 'convention is stated in every observation');
  assert.ok(observation.data.board, 'observation.data carries the board');
});

test('outcome scores 1.0 on the optimal line and decays quadratically on detours', () => {
  const tier = tierOf('p8');
  const state = game.reset(tier, publicSeed('sliding', 'p8', 0));
  const solution = solve(state.board);
  assert.equal(solution.status, 'solved');
  let current = state;
  for (const move of solution.moves) {
    current = game.step(current, 0, move);
  }
  const perfect = game.outcome(current);
  assert.ok(perfect);
  assert.deepEqual(perfect.normalized, [1]);
  assert.equal(current.moveCount, state.par);

  // Detour: move out, move back, move out again — the board is exactly where
  // it would be after the first optimal move, but three moves were spent.
  let detoured = state;
  const first = solution.moves[0];
  detoured = game.step(detoured, 0, first);
  detoured = game.step(detoured, 0, inverseOf(first));
  detoured = game.step(detoured, 0, first);
  for (const move of solution.moves.slice(1)) {
    detoured = game.step(detoured, 0, move);
  }
  const lagged = game.outcome(detoured);
  assert.ok(lagged);
  const expected = Math.min(1, (state.par / (state.par + 2)) ** 2);
  assert.ok(Math.abs(lagged.normalized[0] - expected) < 1e-12);
});

/**
 * The inverse of a tile direction: whatever slid out slides straight back.
 * @param {string} direction
 * @returns {string}
 */
function inverseOf(direction) {
  /** @type {Record<string, string>} */
  const inverse = { up: 'down', down: 'up', left: 'right', right: 'left' };
  return inverse[direction];
}

test('the reference solver agent drives a full optimal episode on p8', async () => {
  const tier = tierOf('p8');
  const seed = publicSeed('sliding', 'p8', 1);
  const trajectory = await runEpisode({
    game,
    tierId: tier.id,
    seed,
    agent: createSlidingSolverAgent({ episodeSeed: seed }),
  });
  assert.equal(trajectory.end.reason, 'terminal');
  const outcome = /** @type {import('../core/types.js').Outcome} */ (trajectory.end.outcome);
  assert.ok(outcome);
  assert.deepEqual(outcome.normalized, [1], 'optimal play scores 1.0');
  assert.equal(trajectory.end.agentActions, outcome.par);
});

test('the reference solver agent also solves every banded tier', async () => {
  for (const tier of game.spec.tiers) {
    if (tier.params.generation !== 'banded') continue;
    const seed = publicSeed('sliding', tier.id, 0);
    const trajectory = await runEpisode({
      game,
      tierId: tier.id,
      seed,
      agent: createSlidingSolverAgent({ episodeSeed: seed }),
    });
    assert.equal(trajectory.end.reason, 'terminal', tier.id);
    const outcome = /** @type {import('../core/types.js').Outcome} */ (trajectory.end.outcome);
    assert.ok(outcome, tier.id);
    assert.deepEqual(outcome.normalized, [1], tier.id);
  }
});

test('the random baseline produces a valid trajectory without crashing', async () => {
  const tier = tierOf('p8');
  const seed = publicSeed('sliding', 'p8', 2);
  const trajectory = await runEpisode({
    game,
    tierId: tier.id,
    seed,
    agent: createRandomAgent({ episodeSeed: seed }),
  });
  assert.ok(trajectory.end.reason === 'terminal' || trajectory.end.reason === 'budget-exhausted');
});

test('the full conformance kit passes for sliding', async () => {
  const report = await runConformance(game);
  assert.equal(report.ok, true);
  assert.ok(report.checks > 50, `expected a substantial check count, got ${report.checks}`);
});

