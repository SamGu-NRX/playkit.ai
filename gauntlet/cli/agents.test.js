import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAgentSpec } from './agents.js';
import { getGame } from '../games/index.js';

// One run is one entry: a resolved baseline agent must carry the spec text as
// its id, never a game packet's tier-resolved id. Chess names its engine per
// tier (engine-paper, engine-wood, ...), so a multi-tier chess run would mix
// agent identities in one bundle and bundle verify's agent-identity rule —
// and the leaderboard's single-entry scoring — would refuse it.

test('baseline:chess:engine resolves every tier under the spec id', async () => {
  const spec = await parseAgentSpec('baseline:chess:engine');
  const game = getGame('chess');
  for (const tier of game.spec.tiers) {
    const agent = await spec.createForEpisode({
      game,
      tier,
      seed: 'chess/public/0',
      agentSeat: 0,
    });
    assert.equal(agent.id, 'baseline:chess:engine', `tier ${tier.id} kept its tier-flavored id`);
  }
});

test('other baseline kinds also resolve under the spec id', async () => {
  for (const text of ['baseline:chess:greedy', 'baseline:minesweeper:greedy', 'baseline:2048:engine']) {
    const spec = await parseAgentSpec(text);
    const gameId = text.split(':')[1];
    const game = getGame(gameId);
    const agent = await spec.createForEpisode({
      game,
      tier: game.spec.tiers[0],
      seed: 'seed',
      agentSeat: 0,
    });
    assert.equal(agent.id, text, `${text} kept a non-spec id`);
  }
});
