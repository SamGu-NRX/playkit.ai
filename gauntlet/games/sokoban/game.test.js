import { test } from 'node:test';
import assert from 'node:assert/strict';
import sokoban, { TIER_GENERATION } from './index.js';
import { greedyAgent, engineAgent } from './baselines.js';
import { runConformance } from '../../core/conformance.js';
import { GauntletRuleError } from '../../core/errors.js';
import { getGame } from '../index.js';
import { solve } from './solver.js';

const game = getGame('sokoban');

test('the registered game exposes four ranked benchmark tiers', () => {
  assert.equal(game.spec.id, 'sokoban');
  assert.equal(game.spec.seats, 1);
  assert.equal(game.spec.benchmark, true);
  assert.deepEqual(
    game.spec.tiers.map((t) => t.id),
    ['one-box', 'two-box', 'three-box', 'four-box']
  );
  assert.deepEqual(
    game.spec.tiers.map((t) => t.rank),
    [1, 2, 3, 4]
  );
  for (const tier of game.spec.tiers) {
    assert.equal(tier.scoring, 'efficiency');
    assert.equal(tier.parKind, 'optimal');
    assert.equal(tier.maxActions, 5 * TIER_GENERATION[tier.id].parMax);
  }
});

test('reset is deterministic in (tier, seed) and JSON-safe', () => {
  const tier = game.spec.tiers[0];
  const a = game.reset(tier, 'sokoban/one-box/public/0');
  const b = game.reset(tier, 'sokoban/one-box/public/0');
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a, 'the state is plain JSON');
  assert.deepEqual(a, b);
  const other = game.reset(tier, 'sokoban/one-box/public/1');
  assert.notDeepEqual(a.boxes, other.boxes);
});

test('the state does not leak par-irrelevant internals and carries the proven par', () => {
  const tier = game.spec.tiers[0];
  const state = game.reset(tier, 'sokoban/one-box/public/0');
  const proven = solve(
    { width: state.width, height: state.height, walls: state.walls, goals: state.goals },
    { player: state.player, boxes: state.boxes }
  );
  assert.equal(state.par, proven.par);
  assert.equal(state.moves, 0);
  assert.deepEqual(state.history, []);
});

test('one-box pars are pinned on the first public seeds', () => {
  // Golden pins for the on-ramp tier: one box in a 5x5 room, par 4-15,
  // budget 75, 16 public seeds.
  const tier = game.spec.tiers.find((t) => t.id === 'one-box');
  assert.ok(tier, 'one-box tier exists');
  const expected = [5, 6, 4];
  for (let i = 0; i < expected.length; i++) {
    const state = game.reset(tier, 'sokoban/one-box/public/' + i);
    assert.equal(state.par, expected[i], `one-box seed ${i}`);
    const proven = solve(
      { width: state.width, height: state.height, walls: state.walls, goals: state.goals },
      { player: state.player, boxes: state.boxes }
    );
    assert.equal(proven.par, expected[i], `one-box seed ${i} is solver-proven`);
  }
});

test('observe renders the board and lists legal actions; data carries the state', () => {
  const tier = game.spec.tiers[0];
  const state = game.reset(tier, 'sokoban/one-box/public/0');
  const observation = game.observe(state, 0);
  assert.match(observation.text, /You are seat 0/);
  assert.match(observation.text, /Legal actions/);
  for (const name of ['up', 'down', 'left', 'right', 'undo']) {
    if (game.legalActions(state, 0).includes(name)) {
      assert.ok(observation.text.includes(name), `missing ${name}`);
    }
  }
  assert.equal(observation.data.par, state.par);
});

test('walks push boxes; undo reverts and counts as an action', () => {
  const tier = game.spec.tiers[0];
  const state = game.reset(tier, 'sokoban/one-box/public/0');
  // Find a legal push by scanning: apply each legal action and check box movement.
  const legal = game.legalActions(state, 0);
  const push = legal.find((a) => {
    if (a === 'undo') return false;
    const next = game.step(state, 0, a);
    return JSON.stringify(next.boxes) !== JSON.stringify(state.boxes);
  });
  assert.ok(push, 'some legal action on the first move pushes a box');
  const after = game.step(state, 0, push);
  assert.equal(after.moves, 1);
  assert.equal(after.history.length, 1);
  const undone = game.step(after, 0, 'undo');
  assert.equal(undone.moves, 2, 'undo counts toward the action budget');
  assert.equal(undone.history.length, 0);
  assert.equal(undone.player, state.player);
  assert.deepEqual(undone.boxes, state.boxes);
});

test('pushes into walls and boxes are illegal; undo is illegal on move zero', () => {
  const tier = game.spec.tiers[0];
  const state = game.reset(tier, 'sokoban/one-box/public/0');
  assert.equal(game.parseAction(state, 0, 'undo').ok, false, 'nothing to undo yet');
  assert.throws(() => game.step(state, 0, 'undo'), GauntletRuleError);
});

test('parseAction accepts documented alternates and rejects garbage', () => {
  const tier = game.spec.tiers[0];
  const state = game.reset(tier, 'sokoban/one-box/public/0');
  for (const [text, expected] of [
    ['up', 'up'],
    ['  DOWN  ', 'down'],
    ['`left`', 'left'],
    ['"right"', 'right'],
    ["'up'", 'up'],
    ['move up', 'up'],
    ['push left', 'left'],
    ['walk down', 'down'],
    ['Go Right', 'right'],
    ['step up', 'up'],
  ]) {
    if (game.legalActions(state, 0).includes(expected)) {
      const parsed = game.parseAction(state, 0, text);
      assert.deepEqual(parsed, { ok: true, action: expected }, `input ${JSON.stringify(text)}`);
    }
  }
  for (const bad of ['z9', 'diagonal', '', 'up down', 'upward']) {
    const parsed = game.parseAction(state, 0, bad);
    assert.equal(parsed.ok, false, `input ${JSON.stringify(bad)}`);
    assert.equal(typeof parsed.error, 'string');
  }
});

test('step throws GauntletRuleError for anything outside legalActions, and is pure', () => {
  const tier = game.spec.tiers[0];
  const state = game.reset(tier, 'sokoban/one-box/public/0');
  const before = JSON.parse(JSON.stringify(state));
  const legal = new Set(game.legalActions(state, 0));
  for (const action of ['up', 'down', 'left', 'right', 'undo']) {
    if (!legal.has(action)) {
      assert.throws(
    () => game.step(state, 0, action),
    (err) => err instanceof GauntletRuleError
  );
    }
  }
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(state))), JSON.stringify(before));
});

test('outcome is null mid-game, and a solved episode scores efficiency 1 at par', () => {
  const tier = game.spec.tiers[0];
  const state = game.reset(tier, 'sokoban/one-box/public/0');
  assert.equal(game.outcome(state), null);
  // Play the engine plan from the start: the episode must end at exactly par.
  const plan = solve(
    { width: state.width, height: state.height, walls: state.walls, goals: state.goals },
    { player: state.player, boxes: state.boxes },
    { plan: true }
  ).plan;
  assert.ok(plan);
  let current = state;
  for (const action of plan) {
    current = game.step(current, 0, action);
  }
  const outcome = game.outcome(current);
  assert.ok(outcome);
  assert.equal(outcome.solved, true);
  assert.equal(current.moves, plan.length);
  assert.equal(outcome.normalized[0], 1, `par play scores 1 (moves ${current.moves}, par ${current.par})`);
  assert.equal(outcome.par, plan.length);
});

test('toAct is null exactly when outcome is non-null (solved or deadlocked)', () => {
  const tier = game.spec.tiers[0];
  const state = game.reset(tier, 'sokoban/one-box/public/0');
  assert.equal(game.toAct(state), 0);
  assert.equal(game.outcome(state), null);
  // After solving, both agree the game is over.
  const result = solve(
    { width: state.width, height: state.height, walls: state.walls, goals: state.goals },
    { player: state.player, boxes: state.boxes },
    { plan: true }
  );
  assert.ok(result.solvable && result.plan, 'the level must be solvable');
  const plan = result.plan;
  let current = state;
  for (const action of plan) current = game.step(current, 0, action);
  assert.equal(game.toAct(current), null);
  assert.ok(game.outcome(current));
});

test('the engine baseline plays to par on every tier seed', async () => {
  const engine = engineAgent();
  for (const tier of game.spec.tiers) {
    for (const seed of [`${tier.id}/public/0`, `${tier.id}/public/5`].map(
      (s) => `sokoban/${s}`
    )) {
      let state = game.reset(tier, seed);
      let turn = 0;
      for (let i = 0; i < tier.maxActions; i++) {
        if (game.toAct(state) === null) break;
        const reply = await engine.act({
          spec: game.spec,
          tier,
          seat: 0,
          turn,
          observation: game.observe(state, 0),
          legalActions: game.legalActions(state, 0),
          feedback: null,
        });
        const parsed = game.parseAction(state, 0, reply.text);
        assert.equal(parsed.ok, true, `engine reply ${JSON.stringify(reply.text)} parses`);
        assert.equal(game.legalActions(state, 0).includes(parsed.action), true, `engine action ${JSON.stringify(parsed.action)} is legal`);
        state = game.step(state, 0, parsed.action);
        turn++;
      }
      const outcome = game.outcome(state);
      assert.ok(outcome, `${tier.id} ${seed}: the engine finishes the episode`);
      assert.equal(outcome.solved, true, `${tier.id} ${seed}: the engine solves it`);
      assert.equal(state.moves, state.par, `${tier.id} ${seed}: the engine scores par`);
    }
  }
});

test('the greedy baseline is legal, deterministic, and far from optimal on average', async () => {
  const tier = game.spec.tiers[0];
  const seed = 'sokoban/one-box/public/0';
  const play = async () => {
    const greedy = greedyAgent();
    let state = game.reset(tier, seed);
    for (let i = 0; i < tier.maxActions; i++) {
      if (game.toAct(state) === null) break;
      const reply = await greedy.act({
        spec: game.spec,
        tier,
        seat: 0,
        turn: i,
        observation: game.observe(state, 0),
        legalActions: game.legalActions(state, 0),
        feedback: null,
      });
      const parsed = game.parseAction(state, 0, reply.text);
      if (!parsed.ok) break;
      state = game.step(state, 0, parsed.action);
    }
    return state;
  };
  const a = await play();
  const b = await play();
  assert.deepEqual(a, b, 'the greedy baseline is deterministic');
  const outcome = game.outcome(a);
  if (outcome === null) {
    assert.equal(a.moves, tier.maxActions, 'an unfinished episode ran the budget out');
    return;
  }
  if (outcome.solved) {
    assert.ok(
      a.moves > a.par,
      'a no-lookahead pusher is not optimal on average'
    );
  }
});

test('conformance: the game passes the Gauntlet conformance kit', async () => {
  const report = await runConformance(game, { seedsPerTier: 2 });
  assert.equal(report.ok, true, JSON.stringify(report.failures ?? report, null, 2));
});
