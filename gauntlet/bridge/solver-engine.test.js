import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toSolverEngine } from './solver-engine.js';
import { game } from '../games/2048/index.js';

/**
 * A fake agent that replies with a canned text, recording the TurnContext.
 *
 * @param {string} text
 * @returns {{ agent: import('../core/types.js').Agent, seen: import('../core/types.js').TurnContext[] }}
 */
function cannedAgent(text) {
  /** @type {import('../core/types.js').TurnContext[]} */
  const seen = [];
  return {
    agent: {
      id: 'canned',
      track: 'baseline',
      async act(ctx) {
        seen.push(ctx);
        return { text };
      },
    },
    seen,
  };
}

const FULL_BOARD = [
  [2, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
];

test('toSolverEngine maps the agent direction to driver numbers, chosen first', async () => {
  const { agent } = cannedAgent('swipe left\nleft');
  const eng = toSolverEngine(agent);
  const order = await eng.getMoveOrder(FULL_BOARD);
  // LEFT is 3 in src/adapters/adapter.js; the remaining directions follow.
  assert.equal(order[0], 3);
  assert.deepEqual([...order].slice(1).sort(), [0, 1, 2]);
  assert.equal(eng.lastChosen, 'left');
});

test('toSolverEngine exposes the driver-facing methods', async () => {
  const { agent } = cannedAgent('up');
  const eng = toSolverEngine(agent);
  await eng.initialize();
  await eng.ensureReady();
  await eng.setStrategy();
  const status = eng.getStatus();
  assert.equal(status.type, 'gauntlet-agent');
  assert.equal(status.ready, true);
  assert.equal(status.agentId, 'canned');
  assert.equal(typeof eng.getMoveOrder, 'function');
});

test('toSolverEngine builds a real TurnContext from the observed board', async () => {
  const { agent, seen } = cannedAgent('down');
  const eng = toSolverEngine(agent);
  await eng.getMoveOrder(FULL_BOARD);
  assert.equal(seen.length, 1);
  const ctx = seen[0];
  assert.equal(ctx.spec.id, '2048');
  assert.equal(ctx.seat, 0);
  assert.deepEqual(ctx.observation.data.board, FULL_BOARD);
  assert.ok(ctx.observation.text.includes('2'));
  assert.ok(ctx.observation.text.includes('Score: 0'));
  // down and right change this board; up and left do not. Sorted lexicographically.
  assert.deepEqual(ctx.legalActions, ['down', 'right']);
});

test('toSolverEngine rejects a reply that parseAction rejects', async () => {
  const { agent } = cannedAgent('diagonal');
  const eng = toSolverEngine(agent);
  const order = await eng.getMoveOrder(FULL_BOARD);
  assert.deepEqual(order, []);
  assert.equal(eng.lastChosen, null);
  assert.match(String(eng.lastError), /rejected/);
});

test('toSolverEngine handles a multi-line reply by taking the last non-empty line', async () => {
  const { agent } = cannedAgent('I think the best move is:\n`right`');
  const eng = toSolverEngine(agent);
  const order = await eng.getMoveOrder(FULL_BOARD);
  assert.equal(order[0], 1); // RIGHT
  assert.equal(eng.lastChosen, 'right');
});

test('toSolverEngine ignores an invalid board', async () => {
  const { agent, seen } = cannedAgent('left');
  const eng = toSolverEngine(agent);
  assert.deepEqual(await eng.getMoveOrder(/** @type {*} */ ([[], [], []])), []);
  assert.equal(seen.length, 0);
});

test('toSolverEngine rejects non-finite and negative board tiles', async () => {
  const { agent, seen } = cannedAgent('left');
  const eng = toSolverEngine(agent);
  const withNaN = [
    [2, Number.NaN, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const withNegative = [
    [2, -2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  assert.deepEqual(await eng.getMoveOrder(/** @type {*} */ (withNaN)), []);
  assert.deepEqual(await eng.getMoveOrder(/** @type {*} */ (withNegative)), []);
  assert.equal(seen.length, 0);
});

test('toSolverEngine threads the spec and tier through the TurnContext', async () => {
  const { agent, seen } = cannedAgent('left');
  const tier = game.spec.tiers[2];
  const eng = toSolverEngine(agent, { tier });
  await eng.getMoveOrder(FULL_BOARD);
  assert.equal(seen[0].tier.id, tier.id);
});

test('toSolverEngine accepts the runner reply form "Action: right" and plays right', async () => {
  // Greptile P2 #4285440527: runEpisode() reads the action through
  // core/runner.js extractAction(), which strips a leading "action:" prefix;
  // the bridge used to take the raw last line, so a supported reply like
  // "Action: right" was rejected and the driver fell back to a direction the
  // agent did not choose.
  const { agent } = cannedAgent('I will merge toward the right wall.\nAction: right');
  const eng = toSolverEngine(agent);
  const order = await eng.getMoveOrder(FULL_BOARD);
  assert.equal(order[0], 1, 'RIGHT is 1 in src/adapters/adapter.js; the agent chose it');
  assert.equal(eng.lastChosen, 'right');
  assert.equal(eng.lastError, null);
});

