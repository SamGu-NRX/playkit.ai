import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillDial } from './skill-dial.js';
import { createRandomAgent } from './random.js';
import { nextFloat, rngFromSeed } from '../core/rng.js';
import { runEpisode } from '../core/runner.js';
import { getGame } from '../games/index.js';
import { CALIBRATION_GAMES } from '../calibration/games.js';

/** @import { Agent, AgentReply, Game, TierSpec, TurnContext } from '../core/types.js' */

const NOW = () => 1_700_000_000_000;

/** A spy expert: records its calls, always plays the first legal action. */
function spyExpert(id = 'test-expert') {
  /** @type {number[]} */
  const turns = [];
  return {
    agent: /** @type {Agent} */ ({
      id,
      track: 'baseline',
      async act(ctx) {
        turns.push(ctx.turn);
        return /** @type {AgentReply} */ ({
          text: /** @type {string[]} */ (ctx.legalActions)[0],
          usage: { inputTokens: 1, outputTokens: 2, costUsd: null },
          meta: { note: 'verbatim' },
        });
      },
    }),
    turns,
  };
}

/**
 * Build a first-turn context for a game, mirroring agents/random.test.js.
 *
 * @param {Game<*>} game
 * @param {TierSpec} tier
 * @param {string} seed
 */
function firstTurn(game, tier, seed) {
  const state = game.reset(tier, seed);
  const seat = typeof game.agentSeat === 'function' ? game.agentSeat(tier, seed) : 0;
  const ctx = /** @type {TurnContext} */ ({
    spec: game.spec,
    tier,
    seat,
    turn: 0,
    observation: game.observe(state, seat),
    legalActions: game.legalActions(state, seat),
    feedback: null,
  });
  return { ctx, seat };
}

test('the dial is a baseline-track agent named dial-<expert id>-p<pct>', () => {
  const { agent } = spyExpert();
  /** @type {Array<[number, string]>} */
  const cases = [[0, 'p0'], [0.1, 'p10'], [0.25, 'p25'], [0.5, 'p50'], [0.75, 'p75'], [1, 'p100']];
  for (const [p, suffix] of cases) {
    const dial = skillDial(agent, p, { episodeSeed: 's' });
    assert.equal(dial.id, `dial-test-expert-${suffix}`);
    assert.equal(dial.track, 'baseline');
  }
});

test('p=0 consults the expert on every turn and returns its reply verbatim', async () => {
  const { agent, turns } = spyExpert();
  const dial = skillDial(agent, 0, { episodeSeed: 'episode-1' });
  const game = getGame('tictactoe');
  const tier = game.spec.tiers[0];
  const { ctx } = firstTurn(game, tier, 'seed-x');
  const reply = await dial.act(ctx);
  assert.deepEqual(turns, [0]);
  assert.equal(reply.text, /** @type {string[]} */ (ctx.legalActions)[0]);
  assert.deepEqual(reply.usage, { inputTokens: 1, outputTokens: 2, costUsd: null });
  assert.deepEqual(reply.meta, { note: 'verbatim' });
});

test('p=1 never consults the expert, even one that would throw', async () => {
  const expert = /** @type {Agent} */ ({
    id: 'explosive',
    track: 'baseline',
    async act() {
      throw new Error('the expert must not be consulted at p=1');
    },
  });
  const dial = skillDial(expert, 1, { episodeSeed: 'episode-2' });
  const game = getGame('tictactoe');
  const tier = game.spec.tiers[0];
  const { ctx } = firstTurn(game, tier, 'seed-y');
  const random = createRandomAgent({ episodeSeed: 'episode-2' });
  assert.equal((await dial.act(ctx)).text, (await random.act(ctx)).text);
});

test('each turn is the expert reply above p and the random agent reply below it', async () => {
  // Drive one episode by hand and recompute, from the pinned streams, what
  // every turn should have been: u_t < p plays createRandomAgent's action for
  // that turn index, u_t >= p plays the expert's.
  const game = /** @type {*} */ (getGame('tictactoe'));
  const tier = game.spec.tiers[0];
  const episodeSeed = 'tictactoe/perfect-opponent/public/0';
  const p = 0.5;
  const { agent, turns } = spyExpert();
  const dial = skillDial(agent, p, { episodeSeed });
  const random = createRandomAgent({ episodeSeed });
  const seat = typeof game.agentSeat === 'function' ? game.agentSeat(tier, episodeSeed) : 0;
  /** @type {string[]} */
  const played = [];
  /** @type {string[]} */
  const expected = [];
  let state = game.reset(tier, episodeSeed);
  for (let agentTurn = 0; agentTurn < tier.maxActions; agentTurn++) {
    if (game.outcome(state)) break;
    const legal = game.legalActions(state, seat);
    if (legal.length === 0) break;
    const ctx = /** @type {TurnContext} */ ({
      spec: game.spec,
      tier,
      seat,
      turn: agentTurn,
      observation: game.observe(state, seat),
      legalActions: legal,
      feedback: null,
    });
    const u = nextFloat(rngFromSeed(`${episodeSeed}/dial/${p}/${agentTurn}`)).value;
    expected.push(u < p ? (await random.act(ctx)).text : legal[0]);
    played.push((await dial.act(ctx)).text);
    const parsed = game.parseAction(state, seat, played[played.length - 1]);
    state = game.step(state, seat, /** @type {{ ok: true, action: string }} */ (parsed).action);
    if (game.outcome(state)) break;
    // The built-in opponent answers until it is the agent's seat again.
    for (let guard = 0; guard < 4; guard++) {
      const mover = typeof game.toAct === 'function' ? game.toAct(state) : seat;
      if (mover === seat || game.outcome(state)) break;
      const opp = game.opponent(tier, episodeSeed, mover);
      const oppReply = await opp.act({
        spec: game.spec,
        tier,
        seat: mover,
        turn: agentTurn,
        observation: game.observe(state, mover),
        legalActions: game.legalActions(state, mover),
        feedback: null,
      });
      state = game.step(state, mover, /** @type {{ ok: true, action: string }} */ (game.parseAction(state, mover, oppReply.text)).action);
    }
    if (game.outcome(state)) break;
  }
  assert.ok(turns.length > 0 && turns.length < played.length, 'the episode must mix expert and noisy turns');
  assert.deepEqual(played, expected);
});

test('at p=0 the dial reproduces the engine baseline trajectory byte for byte', async () => {
  const game = /** @type {Game<*>} */ (getGame('tictactoe'));
  const tier = /** @type {TierSpec} */ (game.spec.tiers[0]);
  const seed = 'tictactoe/perfect-opponent/public/0';
  const calibration = /** @type {typeof CALIBRATION_GAMES[number]} */ (
    CALIBRATION_GAMES.find((g) => g.id === 'tictactoe')
  );
  const seat = typeof game.agentSeat === 'function' ? game.agentSeat(tier, seed) : 0;
  const expert = calibration.makeAgent('engine', { episodeSeed: seed, tier, seat });
  const dial = skillDial(expert, 0, { episodeSeed: seed });
  // Packet baselines may close over episode state, so the direct run gets a
  // fresh identical construction.
  const expert2 = calibration.makeAgent('engine', { episodeSeed: seed, tier, seat });
  const directRun = await runEpisode({ game, tierId: tier.id, seed, agent: expert2, now: NOW });
  const dialRun = await runEpisode({ game, tierId: tier.id, seed, agent: dial, now: NOW });
  const strip = (/** @type {Record<string, *>} */ t) => JSON.stringify({ ...t, agent: { ...t.agent, id: 'x' } });
  assert.equal(strip(dialRun), strip(directRun));
});

test('at p=1 the dial reproduces the random agent trajectory byte for byte', async () => {
  const game = /** @type {Game<*>} */ (getGame('tictactoe'));
  const tier = /** @type {TierSpec} */ (game.spec.tiers[0]);
  const seed = 'tictactoe/perfect-opponent/public/0';
  const random = createRandomAgent({ episodeSeed: seed });
  const dial = skillDial(createRandomAgent({ episodeSeed: seed, id: 'engine' }), 1, { episodeSeed: seed });
  const randomRun = await runEpisode({ game, tierId: tier.id, seed, agent: random, now: NOW });
  const dialRun = await runEpisode({ game, tierId: tier.id, seed, agent: dial, now: NOW });
  const strip = (/** @type {Record<string, *>} */ t) => JSON.stringify({ ...t, agent: { ...t.agent, id: 'x' } });
  assert.equal(strip(dialRun), strip(randomRun));
});

test('the same seed gives the same trajectory twice', async () => {
  const game = /** @type {Game<*>} */ (getGame('tictactoe'));
  const tier = /** @type {TierSpec} */ (game.spec.tiers[0]);
  const seed = 'tictactoe/perfect-opponent/public/0';
  const calibration = /** @type {typeof CALIBRATION_GAMES[number]} */ (
    CALIBRATION_GAMES.find((g) => g.id === 'tictactoe')
  );
  const seat = typeof game.agentSeat === 'function' ? game.agentSeat(tier, seed) : 0;
  const run = () => {
    const expert = calibration.makeAgent('engine', { episodeSeed: seed, tier, seat });
    const dial = skillDial(expert, 0.5, { episodeSeed: seed });
    return runEpisode({ game, tierId: tier.id, seed, agent: dial, now: NOW });
  };
  assert.equal(JSON.stringify(await run()), JSON.stringify(await run()));
});

test('skillDial validates its arguments', () => {
  const { agent } = spyExpert();
  assert.throws(() => skillDial(agent, -0.1, { episodeSeed: 's' }), /p must be a number/);
  assert.throws(() => skillDial(agent, 1.1, { episodeSeed: 's' }), /p must be a number/);
  assert.throws(() => skillDial(agent, Number.NaN, { episodeSeed: 's' }), /p must be a number/);
  assert.throws(() => skillDial(agent, 0.5, { episodeSeed: '' }), /episodeSeed is required/);
  assert.throws(
    () => skillDial(/** @type {*} */ ({ id: 'no-act' }), 0.5, { episodeSeed: 's' }),
    /must be an Agent/
  );
  assert.throws(
    () => skillDial(/** @type {*} */ ({ act: async () => ({}), id: '' }), 0.5, { episodeSeed: 's' }),
    /non-empty id/
  );
});
