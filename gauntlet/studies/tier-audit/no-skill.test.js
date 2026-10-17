import test from 'node:test';
import assert from 'node:assert/strict';

import { extractExampleToken, createCopyExampleAgent, createFirstLegalAgent } from './no-skill.mjs';
import { seedsForTier, tierSuite, profileScores } from './audit-lib.mjs';
import { GAMES } from '../../games/index.js';

/**
 * A minimal turn context for the agent tests: only legalActions and turn
 * drive the no-skill agents' decisions.
 *
 * @param {string[]} legalActions
 * @param {number} turn
 * @returns {*}
 */
function ctx(legalActions, turn) {
  return { legalActions, turn, spec: null, tier: null, seat: 0, observation: '', feedback: null };
}

test('extractExampleToken reads the documented example from rules text', () => {
  const connect4 = /** @type {*} */ (GAMES['connect4']).spec.rulesText;
  const extracted = extractExampleToken(connect4);
  assert.ok(extracted, 'connect4 documents an example action');
  assert.equal(extracted.token, '4');
  assert.equal(extracted.source, 'rules');
});

test('extractExampleToken returns null without an example', () => {
  assert.equal(extractExampleToken('Drop into a column.'), null);
  assert.equal(extractExampleToken(undefined), null);
});

test('copy-example plays the documented token when it is a legal action', async () => {
  const agent = createCopyExampleAgent({ token: '4', source: 'rules' });
  const reply = await agent.act(ctx(['1', '2', '3', '4'], 0));
  assert.equal(reply.text, '4');
  assert.equal(reply.meta.copyExample.played, true);
});

test('copy-example falls back to the first legal action when the token is not canonical', async () => {
  const agent = createCopyExampleAgent({ token: 'guess ABCB', source: 'rules' });
  const reply = await agent.act(ctx(['guess AAA', 'guess AAB'], 0));
  assert.equal(reply.text, 'guess AAA');
  assert.equal(reply.meta.copyExample.played, false);
  assert.equal(reply.meta.copyExample.source, 'rules-not-canonical');
});

test('copy-example with no documented example falls back every turn', async () => {
  const agent = createCopyExampleAgent({ token: null, source: 'none' });
  const first = await agent.act(ctx(['x', 'y'], 0));
  const second = await agent.act(ctx(['y', 'z'], 1));
  assert.equal(first.text, 'x');
  assert.equal(second.text, 'y');
  assert.equal(first.meta.copyExample.source, 'none');
});

test('first-legal always plays the first legal action', async () => {
  const agent = createFirstLegalAgent();
  assert.equal((await agent.act(ctx(['b', 'a'], 0))).text, 'b');
  assert.equal((await agent.act(ctx(['a', 'b'], 1))).text, 'a');
});

test('both agents declare the baseline track', () => {
  assert.equal(createFirstLegalAgent().track, 'baseline');
  assert.equal(createCopyExampleAgent({ token: null, source: 'none' }).track, 'baseline');
});

test('seedsForTier caps chess-puzzles and otherwise uses the full public list', () => {
  const chessPuzzles = /** @type {*} */ (GAMES['chess-puzzles']).spec.tiers[0];
  assert.equal(seedsForTier('chess-puzzles', chessPuzzles).length, 12);
  const tic = /** @type {*} */ (GAMES['tictactoe']).spec.tiers.find((/** @type {{ id: string }} */ t) => t.id === 'random-opponent');
  assert.equal(seedsForTier('tictactoe', tic).length, 16);
  const seeds = seedsForTier('tictactoe', tic);
  assert.ok(seeds.every((s) => s.startsWith('tictactoe/random-opponent/public/')));
});

test('tierSuite builds a single-tier public suite through the scoring layer', () => {
  const { suite, game, tier } = tierSuite('tictactoe', 'random-opponent');
  assert.equal(game.spec.id, 'tictactoe');
  assert.equal(tier.id, 'random-opponent');
  assert.equal(suite.id, 'playkit-gauntlet-tier-audit-tictactoe-random-opponent');
  assert.equal(suite.split, 'public');
  assert.equal(suite.games.length, 1);
  assert.equal(suite.games[0].tiers.length, 1);
});

test('profileScores: outcome tiers rescale under squared and chance-adjusted', () => {
  const tier = { scoring: 'outcome' };
  assert.deepEqual(profileScores(0.5, tier, null), {
    'rhae-v1': 0.5,
    'squared-outcome': 0.25,
    'chance-adjusted': null,
  });
  const adjusted = profileScores(0.5, tier, 0.25);
  assert.equal(adjusted['chance-adjusted'], Math.max(0, (0.5 - 0.25) / (1 - 0.25)));
});

test('profileScores: efficiency tiers are profile-invariant', () => {
  const tier = { scoring: 'efficiency' };
  assert.deepEqual(profileScores(0.8, tier, 0.1), {
    'rhae-v1': 0.8,
    'squared-outcome': 0.8,
    'chance-adjusted': 0.8,
  });
});
