import { test } from 'node:test';
import assert from 'node:assert/strict';
import game from './index.js';
import { DIRECTIONS } from './rules.js';
import { rngFromSeed } from '../../core/rng.js';
import { runConformance } from '../../core/conformance.js';
import { GauntletRuleError } from '../../core/errors.js';

/** @import { Game2048State } from './index.js' */
/** @import { Board } from './rules.js' */

const tier = game.spec.tiers[0];

/**
 * Hand-built state for targeted step/outcome checks.
 *
 * @param {Board} board
 * @param {{ score?: number, target?: number, status?: Game2048State['status'], seed?: string }} [options]
 * @returns {Game2048State}
 */
function makeState(board, { score = 0, target = 256, status = 'playing', seed = 'test' } = {}) {
  return { board, score, rng: rngFromSeed(seed), status, target };
}

test('spec: one seat, perfect information, stochastic, benchmark game', () => {
  assert.equal(game.spec.id, '2048');
  assert.equal(game.spec.seats, 1);
  assert.equal(game.spec.information, 'perfect');
  assert.equal(game.spec.stochastic, true);
  assert.deepEqual(game.spec.tags, ['long-horizon', 'probabilistic']);
  assert.equal(game.spec.benchmark, true);
  assert.deepEqual(game.spec.requires, []);
  assert.equal(
    game.spec.tiers.map((t) => t.id).join(','),
    't256,t512,t1024,t2048'
  );
  assert.deepEqual(
    game.spec.tiers.map((t) => t.rank),
    [1, 2, 3, 4]
  );
  assert.deepEqual(
    game.spec.tiers.map((t) => t.maxActions),
    [300, 600, 1200, 2400]
  );
  assert.deepEqual(
    game.spec.tiers.map((t) => t.scoring),
    ['outcome', 'outcome', 'outcome', 'outcome']
  );
});

test('reset is deterministic, seeds two starting tiles, and differs across seeds', () => {
  const a = game.reset(tier, 'seed-a');
  const b = game.reset(tier, 'seed-a');
  const c = game.reset(tier, 'seed-c');
  assert.deepEqual(a, b);
  assert.equal(a.score, 0);
  assert.equal(a.status, 'playing');
  assert.equal(a.target, 256);
  let tiles = 0;
  for (const row of a.board) {
    for (const v of row) {
      if (v !== 0) {
        tiles++;
        assert.ok(v === 2 || v === 4, `starting tile value ${v} must be 2 or 4`);
      }
    }
  }
  assert.equal(tiles, 2, 'the start board has exactly two spawned tiles');
  assert.notDeepEqual(a.board, c.board, 'different seeds give different start boards');
});

test('legalActions are the sorted directions that change the board', () => {
  const state = game.reset(tier, 'seed');
  assert.deepEqual(game.legalActions(state, 0), ['down', 'left', 'right', 'up']);
  const locked = makeState([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ]);
  assert.deepEqual(game.legalActions(locked, 0), []);
  assert.deepEqual(game.legalActions(state, 1), [], 'seat 1 does not exist');
});

test('parseAction accepts canonical directions and the documented alternates', () => {
  const state = game.reset(tier, 's');
  for (const [text, expected] of [
    ['up', 'up'],
    ['  left  ', 'left'],
    ['DOWN', 'down'],
    ['`right`', 'right'],
    ['"up"', 'up'],
    ["'down'", 'down'],
    ['move up', 'up'],
    ['go left', 'left'],
    ['slide right', 'right'],
    ['swipe down', 'down'],
    ['Move Left', 'left'],
  ]) {
    assert.deepEqual(game.parseAction(state, 0, text), { ok: true, action: expected }, `input ${JSON.stringify(text)}`);
  }
  for (const bad of ['u', 'upward', 'diagonal', '', 'w', 'up up']) {
    const parsed = game.parseAction(state, 0, bad);
    assert.equal(parsed.ok, false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('step slides, scores the merge, and spawns exactly one tile', () => {
  const state = makeState([
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const next = game.step(state, 0, 'left');
  assert.deepEqual(next.board[0], [4, 0, 0, 0]);
  assert.equal(next.score, 4);
  let tiles = 0;
  for (const row of next.board) {
    for (const v of row) if (v !== 0) tiles++;
  }
  assert.equal(tiles, 2, 'one merged tile plus one spawned tile');
  assert.equal(next.status, 'playing');
  assert.equal(game.toAct(next), 0);
});

test('step is pure and a no-op direction is illegal and never spawns', () => {
  const locked = makeState([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ]);
  assert.equal(game.toAct(locked), 0, 'a locked board is still playing until a step is attempted');
  const before = JSON.parse(JSON.stringify(locked));
  assert.throws(() => game.step(locked, 0, 'left'), GauntletRuleError);
  assert.throws(() => game.step(locked, 0, 'right'), GauntletRuleError);
  assert.throws(() => game.step(locked, 0, 'up'), GauntletRuleError);
  assert.throws(() => game.step(locked, 0, 'down'), GauntletRuleError);
  assert.deepEqual(locked, before, 'failed steps do not change state');
  assert.equal(game.legalActions(locked, 0).length, 0);
});

test('a non-legal action throws GauntletRuleError from step', () => {
  const state = game.reset(tier, 's');
  assert.throws(() => game.step(state, 0, '__not_a_gauntlet_action__'), GauntletRuleError);
  assert.throws(() => game.step(state, 0, 'left-left'), GauntletRuleError);
});

test('reaching the target tile wins and ends the episode', () => {
  const state = makeState([
    [128, 128, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const next = game.step(state, 0, 'left');
  assert.equal(next.status, 'won');
  assert.equal(game.toAct(next), null);
  const outcome = game.outcome(next);
  assert.ok(outcome);
  assert.deepEqual(outcome.normalized, [1]);
  assert.deepEqual(outcome.raw, [next.score]);
});

test('a locked board scores 0.5 * p^2 with p = (log2(max) - 2) / (log2(target) - 2)', () => {
  // max tile 32, target 256: p = (5 - 2) / (8 - 2) = 0.5, score 0.125.
  const dead = makeState(
    [
      [32, 2, 32, 2],
      [2, 32, 2, 32],
      [32, 2, 32, 2],
      [2, 32, 2, 32],
    ],
    { status: 'dead' }
  );
  assert.equal(game.toAct(dead), null);
  const outcome = game.outcome(dead);
  assert.ok(outcome);
  assert.ok(Math.abs(outcome.normalized[0] - 0.125) < 1e-12);
  assert.match(outcome.reason, /max tile of 32/);
});

test('truncate scores the current position by the same curve', () => {
  // max tile 64, target 256: p = (6 - 2) / (8 - 2) = 2/3, score 0.5 * 4/9.
  const state = makeState([
    [64, 32, 16, 8],
    [4, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const outcome = game.truncate(state);
  assert.ok(Math.abs(outcome.normalized[0] - 0.5 * (4 / 9)) < 1e-12);
  assert.ok(outcome.normalized[0] > 0 && outcome.normalized[0] < 1);
  // A tiny board clamps at zero progress.
  const tiny = makeState([
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  assert.equal(game.truncate(tiny).normalized[0], 0);
});

test('outcome is null exactly while toAct is not null', () => {
  const state = game.reset(tier, 's');
  assert.equal(game.toAct(state), 0);
  assert.equal(game.outcome(state), null);
  const won = makeState([[256, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], { status: 'won' });
  assert.equal(game.toAct(won), null);
  assert.notEqual(game.outcome(won), null);
});

test('observations render the board, score, and legal actions', () => {
  const state = makeState([
    [2, 4, 0, 0],
    [0, 8, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 16],
  ]);
  const observation = game.observe(state, 0);
  assert.ok(observation.text.includes('256'), 'observation names the tier target');
  assert.ok(observation.text.includes('Score: 0'));
  assert.ok(observation.text.includes('16'));
  for (const action of game.legalActions(state, 0)) {
    assert.ok(observation.text.includes(action), `observation lists ${action}`);
  }
  assert.deepEqual(observation.data.board, state.board);
  assert.equal(observation.data.target, 256);
});

test('state survives a JSON round trip and continues identically', () => {
  const state = game.reset(tier, 'round-trip');
  const direct = game.step(state, 0, 'left');
  const revived = /** @type {Game2048State} */ (JSON.parse(JSON.stringify(state)));
  const restored = game.step(revived, 0, 'left');
  assert.deepEqual(restored, direct);
});

test('runConformance passes every tier', async () => {
  const report = await runConformance(game);
  assert.equal(report.ok, true);
});
