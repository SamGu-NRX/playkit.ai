import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greedy, engine } from './baselines.js';
import game from './index.js';
import { slide } from './rules.js';
import { runEpisode, findTier } from '../../core/runner.js';
import { publicSeed } from '../../core/seeds.js';

/**
 * Run one episode with an agent and return its score.
 *
 * @param {string} tierId
 * @param {string} seed
 * @param {import('../../core/types.js').Agent} agent
 * @returns {Promise<{ score: number, reason: string, moves: number }>}
 */
async function play(tierId, seed, agent) {
  const trajectory = await runEpisode({ game, tierId, seed, agent });
  const outcome = /** @type {import('../../core/types.js').Outcome} */ (
    trajectory.end.outcome
  );
  return {
    score: outcome.normalized[0],
    reason: trajectory.end.reason,
    moves: trajectory.end.agentActions,
  };
}

test('greedy plays the largest immediate gain, ties broken in fixed order', () => {
  const agent = greedy();
  // 'up' and 'down' both gain 4; 'up' comes first in the tie order.
  const ctx = /** @type {import('../../core/types.js').TurnContext} */ ({
    spec: game.spec,
    tier: game.spec.tiers[0],
    seat: 0,
    turn: 0,
    observation: {
      text: '',
      data: {
        board: [
          [2, 0, 0, 0],
          [2, 0, 0, 0],
          [0, 0, 0, 0],
          [0, 0, 0, 0],
        ],
        score: 0,
        target: 256,
      },
    },
    legalActions: ['down', 'left', 'right', 'up'],
    feedback: null,
  });
  return agent.act(ctx).then((reply) => {
    assert.equal(reply.text, 'up');
  });
});

test('greedy never plays a no-op and falls back to a legal move with zero gain', () => {
  const agent = greedy();
  const board = [
    [2, 4, 2, 0],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ];
  // No adjacent equal tiles anywhere, so every legal move gains nothing.
  const legal = /** @type {import('./rules.js').Direction[]} */ (
    ['up', 'right', 'down', 'left'].filter((dir) => slide(board, /** @type {import('./rules.js').Direction} */ (dir)).moved)
  );
  assert.ok(legal.length > 0, 'the test board has at least one legal move');
  const ctx = /** @type {import('../../core/types.js').TurnContext} */ ({
    spec: game.spec,
    tier: game.spec.tiers[0],
    seat: 0,
    turn: 0,
    observation: { text: '', data: { board, score: 0, target: 256 } },
    legalActions: legal.slice().sort(),
    feedback: null,
  });
  return agent.act(ctx).then((reply) => {
    assert.ok(
      legal.includes(/** @type {import('./rules.js').Direction} */ (reply.text)),
      `greedy played "${reply.text}", which is legal`
    );
  });
});

test('engine returns a legal direction on a real episode position', async () => {
  const agent = engine();
  const seed = publicSeed('2048', 't256', 0);
  const tier = findTier(game, 't256');
  const state = game.reset(tier, seed);
  const observation = game.observe(state, 0);
  const ctx = /** @type {import('../../core/types.js').TurnContext} */ ({
    spec: game.spec,
    tier,
    seat: 0,
    turn: 0,
    observation,
    legalActions: game.legalActions(state, 0),
    feedback: null,
  });
  const reply = await agent.act(ctx);
  assert.ok(game.legalActions(state, 0).includes(reply.text));
});

// The required correctness check: the engine baseline beats greedy on t1024
// over 20 seeds. This is the slow test in the suite (a few minutes): 20
// engine episodes of up to 1200 expectimax moves each.
test('the engine baseline beats greedy on t1024 over 20 seeds', { timeout: 20 * 60 * 1000 }, async () => {
  const tierId = 't1024';
  /** @type {number[]} */
  const greedyScores = [];
  /** @type {number[]} */
  const engineScores = [];
  for (let i = 0; i < 20; i++) {
    const seed = publicSeed('2048', tierId, i);
    greedyScores.push((await play(tierId, seed, greedy())).score);
    engineScores.push((await play(tierId, seed, engine())).score);
  }
  const mean = /** @param {number[]} xs */ (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const greedyMean = mean(greedyScores);
  const engineMean = mean(engineScores);
  assert.ok(
    engineMean > greedyMean,
    `engine mean ${engineMean.toFixed(4)} must beat greedy mean ${greedyMean.toFixed(4)}`
  );
});
