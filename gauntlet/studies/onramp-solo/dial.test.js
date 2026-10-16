/**
 * Tests for the pinned skill dial used by the on-ramp study. The dial
 * definition (pinned: coin from `rngFromSeed(`${episodeSeed}/dial/${p}/${turn}`)`,
 * random branch reproduces `createRandomAgent` exactly, expert otherwise)
 * is shared by every skill-ladder packet, so its behavior is pinned here:
 * ids, bounds, p=1 equivalence with the random agent, p=0 purity,
 * deterministic branch decisions, and counted fallback when the expert
 * throws.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRandomAgent } from '../../agents/random.js';
import { nextFloat, rngFromSeed } from '../../core/rng.js';
import { dialId, skillDial, DIAL_P_VALUES } from './dial.js';

/** @import { Agent } from '../../core/types.js' */

/**
 * A TurnContext stub: the dial only reads `turn` and `legalActions`.
 * @param {number} turn
 * @param {string[]} [legal]
 * @returns {import('../../core/types.js').TurnContext}
 */
function ctx(turn, legal = ['left', 'right', 'up', 'down']) {
  return {
    turn,
    legalActions: legal,
    observation: { text: '', data: null },
    feedback: null,
  };
}

test('the dial id follows the pinned format and the p ladder is the pinned six values', () => {
  assert.equal(dialId('engine', 0.5), 'dial-engine-p50');
  assert.equal(dialId('greedy', 0.25), 'dial-greedy-p25');
  assert.equal(dialId('random', 0), 'dial-random-p0');
  assert.deepEqual([...DIAL_P_VALUES], [0, 0.1, 0.25, 0.5, 0.75, 1]);
});

test('skillDial rejects out-of-range p and a missing episode seed', () => {
  const expert = { id: 'expert', track: 'baseline', act: async () => ({ text: 'left' }) };
  assert.throws(() => skillDial({ expert, p: -0.1, episodeSeed: 's' }), /p must be in \[0, 1\]/);
  assert.throws(() => skillDial({ expert, p: 1.1, episodeSeed: 's' }), /p must be in \[0, 1\]/);
  assert.throws(() => skillDial({ expert, p: 0.5, episodeSeed: '' }), /episodeSeed is required/);
  const ok = skillDial({ expert, p: 0.5, episodeSeed: 's' });
  assert.equal(ok.track, 'baseline');
});

test('dial-p1 replays createRandomAgent move for move', async () => {
  const never = {
    id: 'expert',
    track: 'baseline',
    act: async () => {
      throw new Error('the expert must never be asked at p=1');
    },
  };
  for (const seed of ['a/seed', 'b/seed', 'c/seed']) {
    const dial = skillDial({ expert: never, p: 1, episodeSeed: seed });
    const random = createRandomAgent({ episodeSeed: seed });
    for (let turn = 0; turn < 24; turn++) {
      const reply = await dial.act(ctx(turn));
      const expected = await random.act(ctx(turn));
      assert.equal(reply.text, expected.text, `seed ${seed} turn ${turn}`);
    }
  }
});

test('dial-p0 is the expert, asked every turn', async () => {
  /** @type {string[]} */
  const asked = [];
  const expert = {
    id: 'expert',
    track: 'baseline',
    async act(c) {
      asked.push(`t${c.turn}`);
      return { text: 'expert-move' };
    },
  };
  const dial = skillDial({ expert, p: 0, episodeSeed: 'seed' });
  assert.equal(dial.id, 'dial-expert-p0');
  for (let turn = 0; turn < 6; turn++) {
    const reply = await dial.act(ctx(turn));
    assert.equal(reply.text, 'expert-move');
  }
  assert.deepEqual(asked, ['t0', 't1', 't2', 't3', 't4', 't5']);
});

test('branch decisions are deterministic in (episodeSeed, p, turn)', async () => {
  // The same episode seed and p must produce the same expert/random split
  // across separately constructed dial instances; different seeds must be
  // free to differ (assert they are not all identical over many seeds).
  /**
   * Records whether the expert was asked, per turn.
   * @returns {{ agent: Agent, asked: boolean[] }}
   */
  function makeProbe(seed) {
    /** @type {boolean[]} */
    const asked = [];
    return {
      asked,
      agent: skillDial({
        expert: {
          id: 'expert',
          track: 'baseline',
          async act(c) {
            asked[c.turn] = true;
            return { text: 'left' };
          },
        },
        p: 0.5,
        episodeSeed: seed,
      }),
    };
  }
  const a = makeProbe('split/seed');
  const b = makeProbe('split/seed');
  for (let turn = 0; turn < 40; turn++) {
    await a.agent.act(ctx(turn));
    await b.agent.act(ctx(turn));
  }
  assert.deepEqual(Array.from({ length: 40 }, (_, i) => b.asked[i] === true), Array.from({ length: 40 }, (_, i) => a.asked[i] === true));
  const flags = Array.from({ length: 40 }, (_, i) => a.asked[i] === true);
  assert.ok(flags.some(Boolean) && flags.some((v) => !v), 'p=0.5 must mix branches over 40 turns');

  const diffs = new Set();
  for (let s = 0; s < 8; s++) {
    const probe = makeProbe(`split/seed/${s}`);
    for (let turn = 0; turn < 12; turn++) await probe.agent.act(ctx(turn));
    diffs.add(JSON.stringify(probe.asked));
  }
  assert.ok(diffs.size > 1, 'different episode seeds should split differently');
});

test('an expert throw falls back to the random branch and is counted', async () => {
  const failing = {
    id: 'expert',
    track: 'baseline',
    async act() {
      throw new Error('beyond the proven range');
    },
  };
  const p = 0.25;
  const dial = skillDial({ expert: failing, p, episodeSeed: 'fb/seed' });
  const random = createRandomAgent({ episodeSeed: 'fb/seed' });
  let usedRandom = 0;
  let expertTurns = 0;
  for (let turn = 0; turn < 30; turn++) {
    const reply = await dial.act(ctx(turn));
    const expected = await random.act(ctx(turn));
    if (reply.text === expected.text) usedRandom++;
    // The pinned coin formula decides which turns were delegated to the
    // expert (u >= p is the expert branch); every delegated turn throws, so
    // that count is the fallbacks.
    const u = nextFloat(rngFromSeed(`fb/seed/dial/${p}/${turn}`)).value;
    if (u >= p) expertTurns += 1;
  }
  assert.equal(dial.fallbackCount, expertTurns);
  assert.ok(expertTurns > 0 && expertTurns < 30, `p=0.25 must mix branches over 30 turns (got ${expertTurns})`);
  // Every turn's reply is the random branch (by coin, or by fallback), so the
  // whole episode must replay createRandomAgent's stream move for move.
  assert.equal(usedRandom, 30, 'fallback replies must match the random stream exactly');
});
