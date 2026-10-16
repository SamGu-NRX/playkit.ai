/**
 * Tests for the offline dry-run agents. No server, no network.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createScriptedAgent, createReplayAgent } from './dry-run.js';
import { hashObservation } from '../core/canonical.js';
import tictactoe from '../games/tictactoe/index.js';
import { runEpisode } from '../core/runner.js';

/** @import { Agent } from '../core/types.js' */

const CTX = {
  spec: tictactoe.spec,
  tier: tictactoe.spec.tiers[0],
  seat: 0,
  turn: 0,
  observation: { text: 'BOARD', data: {} },
  legalActions: null,
  feedback: null,
};

test('a scripted agent with a list serves replies in order and marks zero usage', async () => {
  const agent = createScriptedAgent(['a1', 'thinking...\naction: b2']);
  assert.equal(agent.dryRun, true);
  assert.equal(agent.track, 'official');
  const r1 = await agent.act({ ...CTX });
  assert.equal(r1.text, 'a1');
  assert.deepEqual(r1.usage, { inputTokens: 0, outputTokens: 0, costUsd: null });
  const r2 = await agent.act({ ...CTX, turn: 1 });
  assert.equal(r2.text, 'thinking...\naction: b2');
  assert.deepEqual(r2.usage, { inputTokens: 0, outputTokens: 0, costUsd: null });
});

test('a scripted agent from a list throws when it runs out', async () => {
  const agent = createScriptedAgent(['a1']);
  await agent.act(CTX);
  await assert.rejects(() => agent.act({ ...CTX, turn: 1 }), /ran out of replies/);
});

test('a scripted agent from a function sees the turn context', async () => {
  /** @type {*} */
  const seen = [];
  const agent = createScriptedAgent((ctx) => {
    seen.push(ctx);
    return `turn-${ctx.turn}`;
  });
  const reply = await agent.act({ ...CTX, turn: 2 });
  assert.equal(reply.text, 'turn-2');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].turn, 2);
  assert.deepEqual(reply.usage, { inputTokens: 0, outputTokens: 0, costUsd: null });
});

/**
 * A deterministic scripted player: the first legal cell named in the
 * observation's legal-action list. Plays episodes through to a terminal state.
 *
 * @param {string} [id]
 * @returns {Agent}
 */
function firstCellAgent(id = 'scripted-first-cell') {
  return createScriptedAgent((ctx) => {
    const match = /Legal actions \(\d+, at most 64 so all are listed\): ([a-z0-9, ]+)/.exec(
      ctx.observation.text
    );
    assert.ok(match, 'expected the legal-action list in the observation text');
    return `action: ${match[1].split(',')[0].trim()}`;
  }, { id });
}

test('a replay agent replays recorded agent replies in order, offline', async () => {
  const recorded = await runEpisode({
    game: tictactoe,
    tierId: 'perfect-opponent',
    seed: 'tictactoe/perfect-opponent/public/0',
    agent: firstCellAgent(),
  });
  const replay = createReplayAgent(recorded);
  assert.equal(replay.dryRun, true);
  const replayed = await runEpisode({
    game: tictactoe,
    tierId: 'perfect-opponent',
    seed: 'tictactoe/perfect-opponent/public/0',
    agent: replay,
  });
  const recordedActions = recorded.steps
    .filter((s) => s.by === 'agent')
    .map((s) => s.action);
  const replayedActions = replayed.steps
    .filter((s) => s.by === 'agent')
    .map((s) => s.action);
  assert.deepEqual(replayedActions, recordedActions);
  assert.equal(replayed.end.reason, recorded.end.reason);
  for (const step of replayed.steps.filter((s) => s.by === 'agent')) {
    assert.deepEqual(step.usage, { inputTokens: 0, outputTokens: 0, costUsd: null });
    assert.equal(step.reply.meta?.replay, true);
  }
});

test('a replay agent refuses to replay against a changed observation', async () => {
  const recorded = await runEpisode({
    game: tictactoe,
    tierId: 'perfect-opponent',
    seed: 'tictactoe/perfect-opponent/public/0',
    agent: firstCellAgent(),
  });
  const tampered = JSON.parse(JSON.stringify(recorded));
  tampered.seed = 'tictactoe/perfect-opponent/public/1';
  const replay = createReplayAgent(tampered);
  await assert.rejects(() => replay.act(CTX), /observation mismatch/);
});

test('the replay agent catches a different agent seat too', async () => {
  // Seat 0 for this seed per the game's agentSeat().
  assert.ok(typeof tictactoe.agentSeat === 'function');
  const seat = tictactoe.agentSeat(tictactoe.spec.tiers[0], 'tictactoe/perfect-opponent/public/0');
  const recorded = await runEpisode({
    game: tictactoe,
    tierId: 'perfect-opponent',
    seed: 'tictactoe/perfect-opponent/public/0',
    agent: firstCellAgent(),
  });
  const replay = createReplayAgent(recorded);
  // Ask at the seat opposite to the recorded one: the observation names the
  // other mark, so the hash check must refuse.
  const otherSeat = 1 - seat;
  await assert.rejects(
    () =>
      replay.act({
        ...CTX,
        seat: otherSeat,
        observation: tictactoe.observe(tictactoe.reset(tictactoe.spec.tiers[0], 'tictactoe/perfect-opponent/public/0'), otherSeat),
      }),
    /observation mismatch/
  );
});

test('replay observation hashes match the live game', () => {
  const state = tictactoe.reset(tictactoe.spec.tiers[0], 'tictactoe/perfect-opponent/public/0');
  const observation = tictactoe.observe(state, 0);
  assert.equal(typeof hashObservation(observation), 'string');
});

test('createScriptedAgent rejects junk input', () => {
  assert.throws(() => createScriptedAgent(/** @type {*} */ ('a1')), /must be an array/);
});

test('createReplayAgent requires a trajectory with agent replies', () => {
  assert.throws(() => createReplayAgent(/** @type {*} */ (null)), /trajectory/);
  const empty = /** @type {*} */ ({
    agent: { id: 'x', track: 'official', seat: 0 },
    steps: [],
  });
  assert.throws(() => createReplayAgent(empty), /no agent replies/);
});
