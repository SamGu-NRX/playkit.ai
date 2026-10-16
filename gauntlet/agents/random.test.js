import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRandomAgent } from './random.js';
import { getGame } from '../games/index.js';

const game = getGame('tictactoe');

test('the random agent is deterministic for a given episode seed and turn', async () => {
  const build = () => createRandomAgent({ episodeSeed: 'episode-1' });
  const draw = async () => {
    const tier = game.spec.tiers[0];
    const state = game.reset(tier, 'seed-x');
    const ctx = {
      spec: game.spec,
      tier,
      seat: 0,
      turn: 0,
      observation: game.observe(state, 0),
      legalActions: game.legalActions(state, 0),
      feedback: null,
    };
    return (await build().act(ctx)).text;
  };
  assert.equal(await draw(), await draw());
});

test('different turns draw from different streams, staying legal', async () => {
  const agent = createRandomAgent({ episodeSeed: 'episode-2' });
  const tier = game.spec.tiers[0];
  let state = game.reset(tier, 'seed-y');
  const seen = new Set();
  for (let turn = 0; turn < 9; turn++) {
    const seat = game.toAct(state);
    if (seat === null) break;
    const reply = await agent.act({
      spec: game.spec,
      tier,
      seat,
      turn,
      observation: game.observe(state, seat),
      legalActions: game.legalActions(state, seat),
      feedback: null,
    });
    const legal = game.legalActions(state, seat);
    assert.ok(legal.includes(reply.text), `turn ${turn}: "${reply.text}" not legal`);
    seen.add(reply.text);
    state = game.step(state, seat, reply.text);
  }
  // Random play may end in a win before the board fills; assert a finished
  // game and plausible ply counts.
  assert.equal(game.toAct(state), null, 'the game must reach a terminal state');
  assert.ok(seen.size >= 5 && seen.size <= 9, `implausible ply count ${seen.size}`);
});

test('the random agent rejects an empty legal list instead of guessing', async () => {
  const agent = createRandomAgent({ episodeSeed: 'episode-3' });
  await assert.rejects(
    agent.act({
      spec: game.spec,
      tier: game.spec.tiers[0],
      seat: 0,
      turn: 0,
      observation: { text: '', data: null },
      legalActions: [],
      feedback: null,
    }),
    /no legal actions/
  );
});

test('a missing episodeSeed is a construction error', () => {
  assert.throws(() => createRandomAgent(/** @type {*} */ ({})), /episodeSeed is required/);
});
