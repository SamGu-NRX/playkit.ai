import { test } from 'node:test';
import assert from 'node:assert/strict';
import cube, { clearResetMemo } from './index.js';
import { createEngineAgent, createGreedyAgent } from './baselines.js';
import { CANONICAL_MOVES, SOLVED } from './cube.js';
import { buildDistanceTable, solveOptimal } from './solver.js';
import { runConformance } from '../../core/conformance.js';
import { runEpisode } from '../../core/runner.js';
import { getGame, listGames } from '../index.js';

/** Warm the solver once so per-seed reset timing excludes the table build. */
buildDistanceTable();

test('spec declares four efficiency tiers with optimal par and the 5x budget rule', () => {
  const { spec } = cube;
  assert.equal(spec.id, 'cube');
  assert.equal(spec.benchmark, true);
  assert.equal(spec.stochastic, false);
  assert.equal(spec.tiers.length, 4);
  const expected = [
    { id: 'cube-2', rank: 1, maxActions: 15 },
    { id: 'cube-5', rank: 2, maxActions: 25 },
    { id: 'cube-7', rank: 3, maxActions: 35 },
    { id: 'cube-9', rank: 4, maxActions: 45 },
  ];
  for (const [i, tier] of spec.tiers.entries()) {
    assert.equal(tier.id, expected[i].id);
    assert.equal(tier.rank, expected[i].rank);
    assert.equal(tier.scoring, 'efficiency');
    assert.equal(tier.parKind, 'optimal');
    assert.equal(tier.maxActions, expected[i].maxActions);
    assert.equal(tier.publicSeeds, i === 0 ? 16 : 6);
    // the budget is 5 x the band maximum (bands 3, 5, 7, 9)
    assert.equal(tier.maxActions, 5 * [3, 5, 7, 9][i]);
  }
  assert.ok(spec.rulesText.includes('clockwise'));
});

test('the full conformance kit passes on every tier', async () => {
  await runConformance(cube);
});

test('reset is deterministic in (tier, seed) and in band, with par proven by the solver', () => {
  for (const tier of cube.spec.tiers) {
    for (const seed of ['0', '1', '2', '3', '4', '5']) {
      const a = cube.reset(tier, seed);
      const b = cube.reset(tier, seed);
      assert.deepEqual(a, b);
      assert.equal(a.par, solveOptimal(a.facelets).length);
      const params = /** @type {{ bandMin: number, bandMax: number }} */ (tier.params);
      assert.ok(
        a.par >= params.bandMin && a.par <= params.bandMax,
        `${tier.id}/${seed}: par ${a.par} outside band [${params.bandMin}, ${params.bandMax}]`
      );
      assert.equal(a.maxActions, tier.maxActions);
      assert.equal(a.moveCount, 0);
    }
    assert.notDeepEqual(cube.reset(tier, '0'), cube.reset(tier, '1'));
  }
});

test('reset is fast on every public seed: under 2 s per seed per tier', () => {
  for (const tier of cube.spec.tiers) {
    for (const seed of ['0', '1', '2', '3', '4', '5']) {
      clearResetMemo();
      const started = Date.now();
      const state = cube.reset(tier, seed);
      const elapsed = Date.now() - started;
      assert.ok(
        elapsed < 2_000,
        `${tier.id}/${seed}: reset took ${elapsed} ms, budget is 2 s per seed`
      );
      assert.ok(state.facelets.length === 54);
    }
  }
});

test('cube-2 pars are pinned on the first public seeds', () => {
  // Golden pins for the on-ramp tier: band 1-3, budget 15, 16 public seeds.
  const tier = cube.spec.tiers.find((t) => t.id === 'cube-2');
  assert.ok(tier, 'cube-2 tier exists');
  const expected = [3, 3, 3];
  for (let i = 0; i < expected.length; i++) {
    const state = cube.reset(tier, 'cube/cube-2/public/' + i);
    assert.equal(state.par, expected[i], `cube-2 seed ${i}`);
    assert.equal(solveOptimal(state.facelets).solution.length, expected[i], `cube-2 seed ${i} solves at par`);
  }
});

test('the observation shows the net, notation, budget, and the full legal list', () => {
  const tier = cube.spec.tiers[0];
  const state = cube.reset(tier, '0');
  const obs = cube.observe(state, 0);
  for (const face of CANONICAL_MOVES) {
    assert.ok(obs.text.includes(face), `observation must list ${face}`);
  }
  assert.ok(obs.text.includes('clockwise'));
  assert.ok(obs.text.includes('looking straight at that face'));
  assert.ok(obs.text.includes(`Turns used: 0 of ${tier.maxActions}`));
  // the net renders nine lines
  assert.equal(obs.text.split('\n').length, 9 + 6);
  assert.equal(obs.data.facelets, state.facelets);
  // the proven-optimal par is scoring metadata: it must not reach the agent
  // through the observation (the outcome reports it after the episode ends)
  assert.ok(!('par' in obs.data), 'the observation must not leak the proven-optimal par');
  assert.equal(obs.data.you, 0);
});

test('parseAction accepts canonical turns and the documented alternates, rejects everything else', () => {
  const tier = cube.spec.tiers[0];
  const state = cube.reset(tier, '0');
  for (const move of CANONICAL_MOVES) {
    const parsed = cube.parseAction(state, 0, move);
    assert.deepEqual(parsed, { ok: true, action: move }, move);
  }
  const alternates = /** @type {const} */ ([
    ['Ui', "U'"],
    ['U-', "U'"],
    ["U2'", 'U2'],
    ['U2i', 'U2'],
    ['R 2', 'R2'],
    [" R ' ", "R'"],
    ['`R`', 'R'],
    ["\"R'\"", "R'"],
  ]);
  for (const [text, action] of alternates) {
    const parsed = cube.parseAction(state, 0, text);
    assert.deepEqual(parsed, { ok: true, action }, `${JSON.stringify(text)} -> ${action}`);
  }
  const rejects = /** @type {const} */ ([
    'R U R\'',
    'RU',
    'r',
    'u2',
    'X',
    'RR',
    '',
    'turn right face',
  ]);
  for (const text of rejects) {
    const parsed = cube.parseAction(state, 0, text);
    assert.equal(parsed.ok, false, `${JSON.stringify(text)} must be rejected`);
    if (!parsed.ok) assert.ok(parsed.error.length > 0);
  }
  // seat 1 has no turn; a solved cube has no turn
  assert.equal(cube.parseAction(state, 1, 'R').ok, false);
  const solvedState = { ...state, facelets: SOLVED };
  assert.equal(cube.parseAction(solvedState, 0, 'R').ok, false);
});

test('step returns a fresh state, advances the budget, and solves to a scored outcome', () => {
  const tier = cube.spec.tiers[0];
  const state = cube.reset(tier, '0');
  const before = JSON.stringify(state);
  const par = /** @type {{ par: number, facelets: string }} */ (
    /** @type {unknown} */ (state)
  ).par;
  const plan = solveOptimal(state.facelets).solution;
  assert.equal(plan.length, par);
  let next = state;
  for (const move of plan) {
    next = cube.step(next, 0, move);
  }
  assert.equal(JSON.stringify(state), before, 'step must not mutate the input state');
  assert.notEqual(next, state);
  assert.equal(next.facelets, SOLVED);
  assert.equal(next.moveCount, par);
  const outcome = cube.outcome(next);
  assert.ok(outcome !== null);
  assert.equal(outcome.solved, true);
  assert.equal(outcome.normalized[0], 1);
  assert.equal(outcome.par, par);
  // a wasteful extra pair of turns reduces the score quadratically: play the
  // first optimal turn and its inverse (2 wasted actions), then the full line
  const first = plan[0];
  const face = first[0];
  const inverse = first.length === 1 ? face + "'" : first[1] === '2' ? first : face;
  const wasteful = cube.step(cube.step(state, 0, first), 0, inverse);
  let s2 = wasteful;
  for (const move of plan) s2 = cube.step(s2, 0, move);
  const outcome2 = cube.outcome(s2);
  assert.ok(outcome2 !== null && outcome2.solved);
  const expected = Math.min(1, (par / (plan.length + 2)) ** 2);
  assert.ok(Math.abs(outcome2.normalized[0] - expected) < 1e-12, `score ${outcome2.normalized[0]} != ${expected}`);
});

test('the engine baseline scores exactly 1.0 end to end on every public seed and tier', async () => {
  for (const tier of cube.spec.tiers) {
    for (const seed of ['0', '1', '2', '3', '4', '5']) {
      const trajectory = await runEpisode({
        game: cube,
        tierId: tier.id,
        seed,
        agent: createEngineAgent({ episodeSeed: `${tier.id}/${seed}` }),
      });
      assert.equal(trajectory.end.reason, 'terminal', `${tier.id}/${seed} must solve within budget`);
      const outcome = /** @type {NonNullable<typeof trajectory.end.outcome>} */ (trajectory.end.outcome);
      assert.equal(outcome.solved, true);
      assert.equal(outcome.par, cube.reset(tier, seed).par);
      assert.equal(outcome.normalized[0], 1);
      assert.equal(trajectory.end.agentActions, outcome.par, 'engine must play exactly par turns');
      assert.equal(trajectory.end.invalidActions, 0);
      for (const step of trajectory.steps) {
        assert.equal(step.by, 'agent');
        assert.equal(step.invalid, false);
        assert.ok(CANONICAL_MOVES.includes(step.action));
      }
    }
  }
});

test('the greedy baseline stays legal and deterministic; report per-tier scores', async () => {
  /** @type {string[]} */
  const report = [];
  for (const tier of cube.spec.tiers) {
    /** @type {number[]} */
    const scores = [];
    for (const seed of ['0', '1', '2', '3', '4', '5']) {
      const options = {
        game: cube,
        tierId: tier.id,
        seed,
        agent: createGreedyAgent({ episodeSeed: `${tier.id}/${seed}` }),
      };
      const trajectory = await runEpisode(options);
      for (const step of trajectory.steps) {
        assert.equal(step.invalid, false, `${tier.id}/${seed}: greedy emitted an invalid action`);
        assert.ok(CANONICAL_MOVES.includes(step.action));
      }
      const outcome = /** @type {NonNullable<typeof trajectory.end.outcome>} */ (trajectory.end.outcome);
      assert.ok(outcome.normalized[0] >= 0 && outcome.normalized[0] <= 1);
      scores.push(outcome.normalized[0]);
      // determinism: replaying the same episode yields the identical outcome
      const replay = await runEpisode(options);
      assert.equal(JSON.stringify(replay.end.outcome), JSON.stringify(outcome));
      assert.equal(replay.end.reason, trajectory.end.reason);
    }
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    report.push(
      `${tier.id}: mean ${mean.toFixed(3)}, min ${Math.min(...scores).toFixed(3)}, max ${Math.max(...scores).toFixed(3)}, solved ${scores.filter((s) => s > 0).length}/6`
    );
  }
  console.log(`greedy baseline per tier:\n${report.join('\n')}`);
});

test('the game is registered in the games registry so getGame("cube") resolves', () => {
  const registered = getGame('cube');
  assert.equal(registered.spec.id, 'cube');
  assert.ok(listGames().includes(registered));
});

test('rulesText states the real scoring semantics for invalid replies', () => {
  // the score is computed over valid turns only; invalid replies burn budget
  assert.ok(
    cube.spec.rulesText.includes('do not count as turns when scoring'),
    'rulesText must say invalid replies do not count as turns when scoring'
  );
  assert.ok(
    !cube.spec.rulesText.includes('Invalid replies consume turns.'),
    'the bare consume-turns phrasing misdescribes the score and must go'
  );
});

test('invalid attempts burn budget but leave the efficiency score untouched', async () => {
  const tier = cube.spec.tiers[0];
  const seed = '0';
  const solution = solveOptimal(cube.reset(tier, seed).facelets).solution;
  // interleave the invalid replies with optimal turns: the runner forfeits at
  // 3 consecutive invalid attempts (maxConsecutiveInvalid, default 3), and a
  // valid turn resets that counter, so junk before each of the first three
  // optimal moves is safe while 3 in a row is not
  const replies = /** @type {string[]} */ ([]);
  for (let k = 0; k < solution.length; k += 1) {
    if (k < 3) replies.push('this is not a legal turn');
    replies.push(solution[k]);
  }
  let next = 0;
  /** @type {import('../../core/types.js').Agent} */
  const invalidThenOptimal = {
    id: 'invalid-then-optimal',
    track: 'baseline',
    async act() {
      return { text: replies[next++] ?? '' };
    },
  };
  const trajectory = await runEpisode({ game: cube, tierId: tier.id, seed, agent: invalidThenOptimal });
  assert.equal(trajectory.end.reason, 'terminal');
  const outcome = /** @type {NonNullable<typeof trajectory.end.outcome>} */ (trajectory.end.outcome);
  assert.equal(outcome.solved, true);
  assert.equal(trajectory.end.agentActions, 3 + solution.length, 'invalid attempts count toward the action budget');
  assert.equal(trajectory.end.invalidActions, 3);
  assert.equal(outcome.normalized[0], 1, 'the score is computed over valid turns only');
});
