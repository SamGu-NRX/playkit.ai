import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEpisode } from './runner.js';
import { verifyTrajectory } from './trajectory.js';
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
    assert.match(result.reason, /not legal|hash mismatch|is not legal/);
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
