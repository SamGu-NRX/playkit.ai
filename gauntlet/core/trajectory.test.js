import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEpisode, timeLimitOutcome } from './runner.js';
import { verifyTrajectory, hashObservation } from './trajectory.js';
import { getGame } from '../games/index.js';
import { createRandomAgent } from '../agents/random.js';

const game = getGame('tictactoe');

/**
 * @param {string} seed
 */
async function recorded(seed) {
  return runEpisode({
    game,
    tierId: 'perfect-opponent',
    seed,
    agent: createRandomAgent({ episodeSeed: seed }),
  });
}

test('an untouched trajectory verifies', async () => {
  const trajectory = await recorded('tamper-baseline');
  assert.deepEqual(await verifyTrajectory(game, trajectory), { ok: true });
});

test('an edited action breaks verification', async () => {
  const trajectory = await recorded('tamper-action');
  const agentStep = trajectory.steps.findIndex((step) => step.by === 'agent');
  const legal = game.legalActions(
    replayState(trajectory, agentStep),
    trajectory.steps[agentStep].seat
  );
  const different = legal.find((cell) => cell !== trajectory.steps[agentStep].action);
  trajectory.steps[agentStep].action = different ?? 'zz';
  const result = await verifyTrajectory(game, trajectory);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /not legal|hash mismatch|is not legal|reply parses|would extract|would have rejected/);
  }
});

test('an invalid agent step whose reply is edited to a legal action is rejected', async () => {
  // The runner records the reply text verbatim, so a forger can edit the
  // reply of a recorded invalid attempt. Editing it to "play a1" — which the
  // runner would accept and move with — must fail verification.
  let turn = 0;
  const agent = {
    id: 'one-invalid',
    track: /** @type {'official'} */ ('official'),
    async act() {
      turn++;
      if (turn === 1) return { text: 'z9' };
      return { text: 'a1' };
    },
  };
  const trajectory = await runEpisode({
    game,
    tierId: 'perfect-opponent',
    seed: 'invalid-reply-edit-seed',
    agent,
    maxConsecutiveInvalid: 99,
  });
  const index = trajectory.steps.findIndex((step) => step.invalid);
  assert.notEqual(index, -1, 'the episode recorded an invalid attempt');
  trajectory.steps[index].reply.text = 'play a1'; // legal on an empty board
  const result = await verifyTrajectory(game, trajectory);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, new RegExp(`step ${index}`));
    assert.match(result.reason, /marked invalid/);
    assert.match(result.reason, /would have accepted/);
  }
});

test('a valid step whose reply names a different legal move than its recorded action is rejected', async () => {
  const trajectory = await recorded('reply-action-mismatch-seed');
  const index = trajectory.steps.findIndex((step) => !step.invalid);
  const step = trajectory.steps[index];
  const legal = game.legalActions(replayState(trajectory, index), step.seat);
  const other = legal.find((cell) => cell !== step.action);
  assert.ok(other, 'a different legal move exists');
  step.reply.text = /** @type {string} */ (other);
  const result = await verifyTrajectory(game, trajectory);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, new RegExp(`step ${index}`));
    assert.match(result.reason, /parses to/);
  }
});

test('an invalid opponent step is rejected outright', async () => {
  const trajectory = await recorded('invalid-opponent-step-seed');
  const index = trajectory.steps.findIndex((step) => step.by === 'opponent');
  assert.notEqual(index, -1, 'a two-seat episode has opponent steps');
  trajectory.steps[index].invalid = true;
  const result = await verifyTrajectory(game, trajectory);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, new RegExp(`step ${index}`));
    assert.match(result.reason, /opponent/);
  }
});

test('an edited observation hash breaks verification', async () => {
  const trajectory = await recorded('tamper-hash');
  trajectory.steps[0].observationHash = 'deadbeefdeadbeef';
  const result = await verifyTrajectory(game, trajectory);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /hash mismatch/);
});

test('an edited outcome breaks verification', async () => {
  const trajectory = await recorded('tamper-outcome');
  trajectory.end.outcome = /** @type {*} */ ({ ...trajectory.end.outcome, normalized: [-1, -1] });
  const result = await verifyTrajectory(game, trajectory);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /outcome/);
});

test('a wrong agent seat breaks verification before replay', async () => {
  const trajectory = await recorded('tamper-seat');
  trajectory.agent.seat = 1 - trajectory.agent.seat;
  const result = await verifyTrajectory(game, trajectory);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /seat/);
});

test('a wrong game version or unknown tier breaks verification before replay', async () => {
  const a = await recorded('tamper-meta-1');
  a.game.version = '0.0.1';
  assert.match(
    JSON.stringify(await verifyTrajectory(game, a)),
    /version/
  );
  const b = await recorded('tamper-meta-2');
  b.tier = 'ghost-tier';
  assert.match(JSON.stringify(await verifyTrajectory(game, b)), /has no tier/);
});

test('dropping the last step breaks the end-state check', async () => {
  const trajectory = await recorded('tamper-truncated-steps');
  trajectory.steps.pop();
  const result = await verifyTrajectory(game, trajectory);
  assert.equal(result.ok, false);
});

test('a foreign format string is rejected outright', async () => {
  const trajectory = await recorded('tamper-format');
  trajectory.format = /** @type {*} */ ('not-the-format');
  const result = await verifyTrajectory(game, trajectory);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /unknown format/);
});

/**
 * Replay up to (excluding) the given step index so a test can pick a legal
 * alternative action.
 *
 * @param {*} trajectory
 * @param {number} upto
 */
function replayState(trajectory, upto) {
  const tier = game.spec.tiers.find((t) => t.id === trajectory.tier);
  let state = game.reset(/** @type {import('./types.js').TierSpec} */ (tier), trajectory.seed);
  for (let i = 0; i < upto; i++) {
    const step = trajectory.steps[i];
    if (step.invalid) continue;
    state = game.step(state, step.seat, step.action);
  }
  return state;
}

test('a forged forfeit threshold above the recorded consecutive invalids is rejected', async () => {
  const trajectory = await runEpisode({
    game,
    tierId: 'perfect-opponent',
    seed: 'forged-threshold',
    agent: {
      id: 'stubborn',
      track: /** @type {'baseline'} */ ('baseline'),
      async act() {
        return { text: 'z9' };
      },
    },
    maxConsecutiveInvalid: 2,
  });
  assert.equal(trajectory.end.reason, 'forfeit-invalid');
  // The honest record carries the threshold the runner actually used...
  assert.equal(trajectory.end.forfeitThreshold, 2);
  assert.deepEqual(await verifyTrajectory(game, trajectory), { ok: true });
  // ...and a record claiming a stricter threshold than its steps support does
  // not verify: only 2 consecutive invalid attempts back this forfeit.
  trajectory.end.forfeitThreshold = 5;
  const result = await verifyTrajectory(game, trajectory);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /threshold/);
});


test('agent attempts beyond tier.maxActions are rejected on every end reason', async () => {
  // A live episode ends the moment the agent's attempts reach the tier
  // budget, so no honest trajectory can carry more agent steps. Forge one
  // that stays fully replayable: play a real budget-exhausted episode on
  // cube-2 (maxActions 15), continue the same state walk two more moves with
  // fresh observation hashes, and re-stamp the end as time-limit — its
  // self-reported fields are shape-checked only and the game is not over, so
  // every pre-existing check passes. The tier budget is what must refuse it.
  const cube = getGame('cube');
  const tierId = 'cube-2';
  const trajectory = await runEpisode({
    game: cube,
    tierId,
    seed: 'over-budget-forgery',
    agent: createRandomAgent({ episodeSeed: 'over-budget-forgery' }),
  });
  assert.equal(trajectory.end.reason, 'budget-exhausted', 'the walk must reach the budget, not solve the cube');
  const tier = cube.spec.tiers.find((t) => t.id === tierId);
  assert.ok(tier);
  const budgetAttempts = trajectory.end.agentActions;
  assert.equal(budgetAttempts, tier.maxActions);

  // Replay the recorded state forward...
  let state = cube.reset(tier, trajectory.seed);
  for (const step of trajectory.steps) {
    state = cube.step(state, step.seat, step.action);
  }
  // ...then continue two forged agent turns with fresh observations.
  for (let i = 0; i < 2; i++) {
    const seat = cube.toAct(state);
    assert.ok(seat !== null, 'the cube is not over mid-forgery');
    const observation = cube.observe(state, seat);
    const action = cube.legalActions(state, seat)[0];
    trajectory.steps.push({
      seat,
      by: 'agent',
      observationHash: hashObservation(observation),
      reply: { text: action },
      action,
      invalid: false,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      ms: 1,
    });
    state = cube.step(state, seat, action);
  }
  const priorEnd = trajectory.end;
  trajectory.end = {
    reason: 'time-limit',
    outcome: timeLimitOutcome(cube.spec.seats, trajectory.agent.seat),
    timeLimitMs: 60000,
    elapsedMs: 60001,
    agentActions: budgetAttempts + 2,
    invalidActions: priorEnd.invalidActions,
    forfeitThreshold: priorEnd.forfeitThreshold,
  };
  const result = await verifyTrajectory(cube, trajectory);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /tier\.maxActions/);
});
