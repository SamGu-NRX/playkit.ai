/**
 * Tests for the skill dial's pinned definition: the p=0 endpoint reproduces
 * the expert exactly, the p=1 endpoint reproduces the bundled random agent
 * exactly, the id scheme is `dial-<expert id>-p<p*100>`, and the choice
 * stream is deterministic per (episodeSeed, p, turn). Runs in seconds —
 * endpoint equivalence on a real episode uses tic-tac-toe, the fastest game.
 *
 * @module
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createRandomAgent } from '../../../agents/random.js';
import tictactoe from '../../../games/tictactoe/index.js';
import { runEpisode } from '../../../core/runner.js';
import { CALIBRATION_GAMES, makeBaselineAgent } from '../../../calibration/games.js';
import { createSkillDialAgent, skillDial, skillDialId } from './dial.js';

/** @import { Agent, TurnContext } from '../../../core/types.js' */

/**
 * A scripted expert that returns a fixed reply per turn.
 *
 * @param {string} id
 * @returns {Agent}
 */
function scriptedExpert(id) {
  return {
    id,
    track: /** @type {'baseline'} */ ('baseline'),
    /** @param {TurnContext} ctx */
    async act(ctx) {
      return {
        text: `expert-${id}-turn-${ctx.turn}`,
        usage: { inputTokens: 1, outputTokens: 2 },
        meta: { expert: true },
      };
    },
  };
}

/**
 * A turn context with just the fields the dial and the random agent read.
 *
 * @param {number} turn
 * @param {string[]} [legal]
 * @returns {TurnContext}
 */
function fakeCtx(turn, legal = ['a1', 'b2', 'c3']) {
  return /** @type {TurnContext} */ (
    /** @type {*} */ ({ seat: 0, turn, observation: { text: '' }, legalActions: legal, feedback: null })
  );
}

test('skillDialId follows the pinned `dial-<expert id>-p<p*100>` scheme', () => {
  assert.equal(skillDialId('engine', 0), 'dial-engine-p0');
  assert.equal(skillDialId('engine', 0.1), 'dial-engine-p10');
  assert.equal(skillDialId('engine', 0.25), 'dial-engine-p25');
  assert.equal(skillDialId('engine', 0.5), 'dial-engine-p50');
  assert.equal(skillDialId('engine', 0.75), 'dial-engine-p75');
  assert.equal(skillDialId('engine', 1), 'dial-engine-p100');
});

test('p=0 plays the expert on every turn, reply forwarded verbatim', async () => {
  const expert = scriptedExpert('tester');
  const dial = createSkillDialAgent({ expert, p: 0, episodeSeed: 'seed-a' });
  assert.equal(dial.id, 'dial-tester-p0');
  assert.equal(dial.track, 'baseline');
  for (let turn = 0; turn < 10; turn++) {
    const reply = await dial.act(fakeCtx(turn));
    assert.equal(reply.text, `expert-tester-turn-${turn}`);
    assert.deepEqual(reply.usage, { inputTokens: 1, outputTokens: 2, costUsd: null });
    assert.deepEqual(reply.meta, { expert: true });
  }
});

test('p=1 reproduces the bundled random agent exactly on every turn', async () => {
  const expert = scriptedExpert('tester');
  const episodeSeed = 'tictactoe/perfect-opponent/public/0';
  const dial = createSkillDialAgent({ expert, p: 1, episodeSeed });
  assert.equal(dial.id, 'dial-tester-p100');
  const random = createRandomAgent({ episodeSeed, id: 'random' });
  for (let turn = 0; turn < 200; turn++) {
    const legal = ['a1', 'a2', 'b1', 'b2', 'b3', 'c2', 'c3'].slice(turn % 4, (turn % 4) + 3);
    const dialReply = await dial.act(fakeCtx(turn, legal));
    const randomReply = await random.act(fakeCtx(turn, legal));
    assert.equal(dialReply.text, randomReply.text, `turn ${turn} diverged`);
  }
});

test('the choice stream is deterministic per (episodeSeed, p, turn) and keyed off the episode seed', async () => {
  const expert = scriptedExpert('tester');
  /** @type {string[]} */
  const first = [];
  /** @type {string[]} */
  const second = [];
  for (let turn = 0; turn < 50; turn++) {
    first.push((await createSkillDialAgent({ expert, p: 0.5, episodeSeed: 'seed-a' }).act(fakeCtx(turn))).text);
    second.push((await createSkillDialAgent({ expert, p: 0.5, episodeSeed: 'seed-a' }).act(fakeCtx(turn))).text);
  }
  assert.deepEqual(first, second, 'two instances on the same seed must agree move for move');
  /** @type {string[]} */
  const other = [];
  for (let turn = 0; turn < 50; turn++) {
    other.push((await createSkillDialAgent({ expert, p: 0.5, episodeSeed: 'seed-b' }).act(fakeCtx(turn))).text);
  }
  assert.notDeepEqual(first, other, 'a different episode seed must produce different dial draws');
});

test('at p=0.5 roughly half the turns are random moves over a fixed 400-turn block', async () => {
  const expert = scriptedExpert('tester');
  const dial = createSkillDialAgent({ expert, p: 0.5, episodeSeed: 'block-seed' });
  let randomTurns = 0;
  for (let turn = 0; turn < 400; turn++) {
    const reply = await dial.act(fakeCtx(turn));
    if (!reply.text.startsWith('expert-')) randomTurns++;
  }
  // Deterministic block: assert the observed count is consistent with p=0.5
  // within a wide binomial band (mu=200, sd=10) — a mislabeled p (say 0.25 or
  // 0.75) falls far outside it.
  assert.ok(randomTurns > 150 && randomTurns < 250, `random turns ${randomTurns} outside the p=0.5 band`);
});

test('validation: p outside [0,1], a non-agent expert, and a missing episodeSeed all throw', () => {
  const expert = scriptedExpert('tester');
  assert.throws(() => createSkillDialAgent({ expert, p: -0.1, episodeSeed: 's' }));
  assert.throws(() => createSkillDialAgent({ expert, p: 1.5, episodeSeed: 's' }));
  assert.throws(() => createSkillDialAgent({ expert, p: Number.NaN, episodeSeed: 's' }));
  assert.throws(
    () => createSkillDialAgent({ expert: /** @type {*} */ ({ id: 'x' }), p: 0.5, episodeSeed: 's' })
  );
  assert.throws(
    () => createSkillDialAgent({ expert, p: 0.5, episodeSeed: /** @type {*} */ ('') })
  );
  assert.throws(() => skillDial(expert, 0.5, /** @type {*} */ ({})));
});

test('on a real episode: dial(engine, p=0) replays the expert and dial(engine, p=1) replays random', async () => {
  const entry = CALIBRATION_GAMES.find((g) => g.id === 'tictactoe');
  assert.ok(entry, 'tictactoe must have a calibration entry');
  const tier = tictactoe.spec.tiers[0];
  const seed = 'tictactoe/perfect-opponent/public/0';
  const seat = typeof tictactoe.agentSeat === 'function' ? tictactoe.agentSeat(tier, seed) : 0;
  const engine = makeBaselineAgent(entry, 'engine', { episodeSeed: seed, tier, seat });
  const engineTrajectory = await runEpisode({ game: tictactoe, tierId: tier.id, seed, agent: engine });
  const dial0Trajectory = await runEpisode({
    game: tictactoe,
    tierId: tier.id,
    seed,
    agent: createSkillDialAgent({ expert: engine, p: 0, episodeSeed: seed }),
  });
  assert.deepEqual(
    dial0Trajectory.end.outcome,
    engineTrajectory.end.outcome,
    'p=0 must reproduce the expert episode'
  );
  assert.deepEqual(
    dial0Trajectory.steps.map((s) => s.action),
    engineTrajectory.steps.map((s) => s.action)
  );

  const randomTrajectory = await runEpisode({
    game: tictactoe,
    tierId: tier.id,
    seed,
    agent: createRandomAgent({ episodeSeed: seed, id: 'random' }),
  });
  const dial1Trajectory = await runEpisode({
    game: tictactoe,
    tierId: tier.id,
    seed,
    agent: createSkillDialAgent({ expert: engine, p: 1, episodeSeed: seed }),
  });
  assert.deepEqual(
    dial1Trajectory.end.outcome,
    randomTrajectory.end.outcome,
    'p=1 must reproduce the random episode'
  );
  assert.deepEqual(
    dial1Trajectory.steps.map((s) => s.action),
    randomTrajectory.steps.map((s) => s.action)
  );
  // The trajectories also verify under the replay checker (runner-produced),
  // and the dial's recorded agent id follows the pinned scheme.
  assert.equal(dial1Trajectory.agent.id, 'dial-engine-p100');
  assert.equal(dial1Trajectory.agent.track, 'baseline');
});
