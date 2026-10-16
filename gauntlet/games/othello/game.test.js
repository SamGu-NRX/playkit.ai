/**
 * Tests for the Othello game: bitboard rules against the published perft
 * table, engine behavior and budgets, the game bundle's contract surface,
 * the runner end to end on every tier, conformance, and the baselines
 * including the skill dial.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bitFor,
  applyPass,
  applyPlacement,
  discCounts,
  emptyState,
  legalPlacements,
  nameOf,
  parseName,
  perft,
  flipsBB,
  popcount2,
} from './rules.js';
import { chooseMove } from './engine.js';
import game from './index.js';
import { createDialAgent, createEngineAgent, createGreedyAgent } from './baselines.js';
import { createRandomAgent } from '../../agents/random.js';
import { runEpisode } from '../../core/runner.js';
import { runConformance } from '../../core/conformance.js';

/**
 * The game's optional agentSeat method, narrowed to non-optional for tests.
 *
 * @type {NonNullable<typeof game.agentSeat>}
 */
const seatOf = /** @type {NonNullable<typeof game.agentSeat>} */ (game.agentSeat);

/**
 * A full TurnContext for a state, as the runner would build it.
 *
 * @param {import('./rules.js').OthelloState} state
 * @param {number} seat
 * @param {string[]} legalActions
 * @param {number} turn
 * @param {import('../../core/types.js').TierSpec} [tier]
 * @returns {import('../../core/types.js').TurnContext}
 */
function makeCtx(state, seat, legalActions, turn, tier = game.spec.tiers[0]) {
  return {
    spec: game.spec,
    tier,
    seat,
    turn,
    observation: game.observe(state, seat),
    legalActions,
    feedback: null,
  };
}

/**
 * Build a state from explicit black/white square names plus mover seat.
 *
 * @param {string[]} blackNames
 * @param {string[]} whiteNames
 * @param {number} toMove
 * @param {number} [agentSeat] Default 0.
 * @returns {ReturnType<typeof emptyState>}
 */
function stateFrom(blackNames, whiteNames, toMove, agentSeat = 0) {
  const bb = [0, 0, 0, 0];
  for (const name of blackNames) {
    const bit = bitFor(name.charCodeAt(0) - 97, Number(name[1]) - 1);
    bb[0] = (bb[0] | bit.a) >>> 0;
    bb[1] = (bb[1] | bit.b) >>> 0;
  }
  for (const name of whiteNames) {
    const bit = bitFor(name.charCodeAt(0) - 97, Number(name[1]) - 1);
    bb[2] = (bb[2] | bit.a) >>> 0;
    bb[3] = (bb[3] | bit.b) >>> 0;
  }
  const discs = blackNames.length + whiteNames.length;
  return {
    bb: /** @type {[number, number, number, number]} */ (bb),
    toMove,
    status: 'playing',
    discs,
    history: [],
    openingPlies: 0,
    agentSeat,
  };
}

test('spec: the othello bundle declares the expected shape', () => {
  assert.equal(game.spec.id, 'othello');
  assert.equal(game.spec.seats, 2);
  assert.equal(game.spec.stochastic, false);
  assert.equal(game.spec.benchmark, true);
  assert.equal(game.spec.information, 'perfect');
  assert.deepEqual(game.spec.tags.sort(), ['adversarial', 'planning']);
  assert.ok(game.spec.rulesText.includes('d3'));
  assert.ok(game.spec.rulesText.includes('pass'));
  for (const tier of game.spec.tiers) {
    assert.equal(tier.scoring, 'outcome');
    assert.equal(tier.publicSeeds, 12);
    assert.ok(tier.maxActions > 60, `${tier.id} must cover a full 60-placement game`);
  }
  assert.deepEqual(
    game.spec.tiers.map((t) => t.rank),
    [1, 2, 3, 4]
  );
});

test('rules: the standard opening has four centered discs and four legal placements', () => {
  const state = emptyState(0);
  assert.deepEqual(discCounts(state), [2, 2]);
  assert.equal(state.toMove, 0);
  assert.deepEqual(legalPlacements(state, 0), ['c4', 'd3', 'e6', 'f5']);
  assert.deepEqual(game.legalActions(state, 0), ['c4', 'd3', 'e6', 'f5']);
});

test('rules: d3 flips exactly d4 and hands the move to White', () => {
  const state = emptyState(0);
  const next = applyPlacement(state, 0, 'd3'.charCodeAt(0) - 97, Number('d3'[1]) - 1);
  assert.deepEqual(discCounts(next), [4, 1]);
  assert.equal(next.toMove, 1);
  assert.deepEqual(next.history, ['d3']);
  const bit = bitFor(3, 3);
  assert.ok((next.bb[0] & bit.a) !== 0, 'd4 is black after the flip');
  assert.ok((next.bb[2] & bit.a) === 0, 'd4 is no longer white');
  const white = legalPlacements(next, 1);
  assert.ok(white.includes('c3') && white.includes('e3') && white.includes('c5'), white.join(','));
});

test('rules: square naming round-trips and every square has a unique bit', () => {
  const seen = new Set();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const name = nameOf(col, row);
      const parsed = parseName(name);
      assert.ok(parsed, name);
      assert.equal(parsed.col, col);
      assert.equal(parsed.row, row);
      const bit = bitFor(col, row);
      const key = `${bit.a},${bit.b}`;
      assert.ok(!seen.has(key), `duplicate bit at ${name}`);
      seen.add(key);
      assert.ok((bit.a !== 0) !== (bit.b !== 0), `exactly one limb set at ${name}`);
    }
  }
  assert.equal(seen.size, 64);
  assert.equal(parseName('i3'), null);
  assert.equal(parseName('d9'), null);
  assert.equal(parseName('d'), null);
  assert.equal(parseName('3d'), null);
  assert.equal(parseName('d0'), null);
});

test('rules: perft matches the published table through depth 9', () => {
  // Reference: github.com/RBelex-007/othello-ocaml README (verified this
  // session): 1 4; 2 12; 3 56; 4 244; 5 1396; 6 8200; 7 55092; 8 390216;
  // 9 3005288. A forced pass consumes a ply.
  const expected = [4, 12, 56, 244, 1396, 8200, 55092, 390216, 3005288];
  const state = emptyState(0);
  for (let depth = 1; depth <= 9; depth++) {
    assert.equal(perft(state, depth), expected[depth - 1], `perft(${depth})`);
  }
});

test('rules: occupied squares and non-bracketing placements throw', () => {
  const state = emptyState(0);
  assert.throws(() => applyPlacement(state, 0, 3, 3), /occupied/); // d4
  assert.throws(() => applyPlacement(state, 0, 0, 0), /bracket/); // a1
  assert.throws(() => applyPlacement(state, 1, 2, 3), /turn/); // not White's turn
});

test('rules: a forced pass hands the move over and the game ends when a side runs dry', () => {
  // Black owns b3..g3, White owns h3 alone: every line through h3 ends
  // off-board or empty for Black, so Black has no placement and must pass.
  // White's only placement is then a3, flipping all six black discs — Black
  // is left with no disc and the game ends immediately, White 8-0.
  let state = stateFrom(['b3', 'c3', 'd3', 'e3', 'f3', 'g3'], ['h3'], 0);
  assert.deepEqual(legalPlacements(state, 0), []);
  assert.deepEqual(game.legalActions(state, 0), ['pass']);
  state = applyPass(state, 0);
  assert.equal(state.toMove, 1);
  assert.equal(state.status, 'playing');
  assert.deepEqual(state.history, ['pass']);
  // White still has a placement — the game is not over.
  assert.deepEqual(game.legalActions(state, 1), ['a3']);
  state = applyPlacement(state, 1, 0, 2); // a3
  assert.deepEqual(discCounts(state), [0, 8]);
  assert.equal(state.status, 'over');
  const outcome = /** @type {import('../../core/types.js').Outcome} */ (game.outcome(state));
  assert.deepEqual(outcome.normalized, [0, 1]);
  assert.ok(outcome.reason.includes('8-0'));
});

test('engine: choices are deterministic and respect the node budget', () => {
  const state = emptyState(0);
  const first = chooseMove(state, { nodeBudget: 2000 });
  const second = chooseMove(state, { nodeBudget: 2000 });
  assert.equal(first.move, second.move);
  assert.equal(first.score, second.score);
  assert.equal(first.nodes, second.nodes);
  assert.ok(first.nodes <= 2000 + 1, `nodes ${first.nodes} within budget`);
  assert.ok(legalPlacements(state, 0).includes(first.move));
});

test('engine: deeper budgets on the opening stay plausible', () => {
  const state = emptyState(0);
  const depths = [];
  for (const budget of [400, 4000, 32000]) {
    const r = chooseMove(state, { nodeBudget: budget });
    depths.push(r.depth);
    assert.ok(r.depth >= 1);
    assert.ok(legalPlacements(state, 0).includes(r.move));
  }
  for (let i = 1; i < depths.length; i++) {
    assert.ok(depths[i] >= depths[i - 1], `depth ${depths[i]} at budget ${i} after ${depths[i - 1]}`);
  }
  for (const d of depths) {
    assert.ok(d >= 2 && d <= 60, `search depth ${d} is a plausible full-game depth`);
  }
});

test('engine: a forced corner is played and a single legal move is chosen', () => {
  // White b2, Black c3: a1 is the only legal placement.
  const state = stateFrom(['c3'], ['b2'], 0);
  for (const budget of [200, 2000]) {
    const r = chooseMove(state, { nodeBudget: budget });
    assert.equal(r.move, 'a1', `budget ${budget}`);
  }
});

test('engine: the move is always legal across a self-play playout', () => {
  let state = emptyState(0);
  let placements = 0;
  for (let ply = 0; ply < 120 && state.status === 'playing'; ply++) {
    const legal = legalPlacements(state, state.toMove);
    if (legal.length === 0) {
      state = applyPass(state, state.toMove);
      continue;
    }
    const r = chooseMove(state, { nodeBudget: 300 });
    assert.ok(legal.includes(r.move), `illegal ${r.move} not in ${legal.join(',')}`);
    state = applyPlacement(state, state.toMove, r.move.charCodeAt(0) - 97, Number(r.move[1]) - 1);
    placements++;
  }
  assert.equal(state.status, 'over');
  assert.ok(placements >= 55 && placements <= 60, `placements ${placements}`);
});

test('engine: the 4000-node budget beats the 400-node budget', () => {
  // Four games, two per colour pairing, seeded openings not needed.
  let strong = 0;
  /**
   * @param {number} blackBudget
   * @param {number} whiteBudget
   */
  const play = (blackBudget, whiteBudget) => {
    let state = emptyState(0);
    while (state.status === 'playing') {
      const seat = state.toMove;
      const legal = legalPlacements(state, seat);
      if (legal.length === 0) {
        state = applyPass(state, seat);
        continue;
      }
      const r = chooseMove(state, { nodeBudget: seat === 0 ? blackBudget : whiteBudget });
      state = applyPlacement(state, seat, r.move.charCodeAt(0) - 97, Number(r.move[1]) - 1);
    }
    const [black, white] = discCounts(state);
    return black - white;
  };
  strong += play(4000, 400) > 0 ? 1 : 0;
  strong += play(400, 4000) < 0 ? 1 : 0;
  strong += play(4000, 400) > 0 ? 1 : 0;
  strong += play(400, 4000) < 0 ? 1 : 0;
  assert.ok(strong >= 3, `strong budget scored ${strong}/4`);
});

test('baselines: greedy takes a corner when one is legal', async () => {
  const state = stateFrom(['c3'], ['b2'], 0);
  const reply = await createGreedyAgent().act(makeCtx(state, 0, ['a1'], 0));
  assert.equal(reply.text, 'a1');
});

test('baselines: greedy on the standard opening breaks ties by sorted order', async () => {
  // All four opening placements flip one disc and weigh equally (-1 + 1 = 0),
  // so the deterministic tie-break takes the first sorted action.
  const state = emptyState(0);
  const reply = await createGreedyAgent().act(
    makeCtx(state, 0, ['c4', 'd3', 'e6', 'f5'], 0)
  );
  assert.equal(reply.text, 'c4');
});

test('baselines: greedy plays a legal full episode against the random opponent', async () => {
  const tier = game.spec.tiers[0];
  const seed = 'greedy-sanity';
  const agent = createGreedyAgent();
  const opponent = /** @type {NonNullable<typeof game.opponent>} */ (game.opponent)(tier, seed, 1 - seatOf(tier, seed));
  let state = game.reset(tier, seed);
  const agentSeat = seatOf(tier, seed);
  const turns = [0, 0];
  let guard = 0;
  while (state.status === 'playing' && guard++ < 200) {
    const seat = state.toMove;
    const legal = game.legalActions(state, seat);
    const mover = seat === agentSeat ? agent : opponent;
    const ctx = makeCtx(state, seat, legal, turns[seat]++);
    const reply = await mover.act(ctx);
    const parsed = game.parseAction(state, seat, reply.text);
    assert.ok(parsed.ok, `seat ${seat} played ${JSON.stringify(reply.text)}: ${parsed.ok ? '' : parsed.error}`);
    state = game.step(state, seat, /** @type {{ ok: true, action: string }} */ (parsed).action);
  }
  assert.equal(state.status, 'over');
  assert.ok(state.discs >= 55, `game ended with ${state.discs} discs`);
});

test('baselines: the dial at p=1 mirrors the bundled random agent exactly', async () => {
  const tier = game.spec.tiers[0];
  const episodeSeed = 'dial-one';
  const dial = createDialAgent({ episodeSeed, p: 1 });
  const random = createRandomAgent({ episodeSeed });
  for (const turn of [0, 1, 2, 3]) {
    const state = emptyState(0);
    const legal = legalPlacements(state, 0);
    const [a, b] = await Promise.all([
      dial.act(makeCtx(state, 0, legal, turn)),
      random.act(makeCtx(state, 0, legal, turn)),
    ]);
    assert.equal(a.text, b.text, `turn ${turn}`);
  }
});

test('baselines: the dial at p=0 is the expert, and mid dial values differ', async () => {
  const tier = game.spec.tiers[0];
  const state = emptyState(0);
  const legal = legalPlacements(state, 0);
  const expert = await createDialAgent({ episodeSeed: 'dial-zero', p: 0 }).act(
    makeCtx(state, 0, legal, 0)
  );
  const engineReply = await createEngineAgent(6000).act(makeCtx(state, 0, legal, 0));
  assert.equal(expert.text, engineReply.text);
  // p=0.5 draws a Bernoulli; on this turn it must still be legal either way.
  const mid = await createDialAgent({ episodeSeed: 'dial-mid', p: 0.5 }).act(
    makeCtx(state, 0, legal, 0)
  );
  assert.ok(legal.includes(mid.text));
  assert.throws(() => createDialAgent({ episodeSeed: 'x', p: 1.5 }), /p must be in/);
});

test('index: reset is deterministic, bounded by three opening plies, and alternates seats', () => {
  const tier = game.spec.tiers[1];
  const seats = new Set();
  for (let i = 0; i < 12; i++) {
    const seed = `othello/${tier.id}/public/${i}`;
    const a = game.reset(tier, seed);
    const b = game.reset(tier, seed);
    assert.deepEqual(a, b, seed);
    assert.ok(a.openingPlies >= 0 && a.openingPlies <= 3, `openingPlies ${a.openingPlies}`);
    assert.ok(a.discs === 4 + a.openingPlies, `discs ${a.discs} vs opening ${a.openingPlies}`);
    seats.add(seatOf(tier, seed));
  }
  assert.ok(seats.size === 2, 'agent seat must take both values across seeds');
});

test('index: legalActions are sorted placements, or exactly ["pass"]', () => {
  const state = emptyState(0);
  assert.deepEqual(game.legalActions(state, 0), ['c4', 'd3', 'e6', 'f5']);
  // The pass fixture: Black has no placement, so the sole legal action is
  // the exact text "pass"; a non-mover sees no actions.
  const passState = stateFrom(['b3', 'c3', 'd3', 'e3', 'f3', 'g3'], ['h3'], 0);
  assert.deepEqual(game.legalActions(passState, 0), ['pass']);
  assert.deepEqual(game.legalActions(passState, 1), [], 'not the mover');
  // A finished state exposes no actions.
  let over = applyPass(passState, 0);
  over = applyPlacement(over, 1, 0, 2);
  assert.equal(over.status, 'over');
  assert.deepEqual(game.legalActions(over, 1), []);
});

test('index: observe names the seat, the board, and the legal actions', () => {
  const state = emptyState(0);
  const observation = game.observe(state, 0);
  assert.ok(observation.text.includes('You are seat 0 (Black)'));
  assert.ok(observation.text.includes('a b c d e f g h'));
  assert.ok(observation.text.includes('c4, d3, e6, f5'));
  assert.ok(observation.text.includes('Black to move.'));
  assert.deepEqual(observation.data.you, 0);
  const opponentView = game.observe(state, 1);
  assert.ok(opponentView.text.includes('You are seat 1 (White)'));
});

test('index: parseAction accepts the documented alternates and rejects the rest', () => {
  const state = emptyState(0);
  for (const text of ['d3', 'D3', ' d3 ', '"d3"', "'d3'", '`d3`', 'play d3', 'move d3', 'place d3', 'PLAY D3']) {
    const parsed = game.parseAction(state, 0, text);
    assert.ok(parsed.ok, text);
    assert.equal(/** @type {{ action: string }} */ (parsed).action, 'd3', text);
  }
  // A pass while a placement exists is invalid.
  const pass = game.parseAction(state, 0, 'pass');
  assert.ok(!pass.ok);
  assert.match(/** @type {{ error: string }} */ (pass).error, /cannot pass/);
  // Occupied square: d4.
  const occupied = game.parseAction(state, 0, 'd4');
  assert.ok(!occupied.ok);
  assert.match(/** @type {{ error: string }} */ (occupied).error, /occupied/);
  // Empty square that brackets nothing: a1.
  const dead = game.parseAction(state, 0, 'a1');
  assert.ok(!dead.ok);
  assert.match(/** @type {{ error: string }} */ (dead).error, /bracket/);
  // Junk.
  for (const junk of ['x9', 'd', '3', 'd10', 'hello', 'c5 pass']) {
    assert.ok(!game.parseAction(state, 0, junk).ok, junk);
  }
  // Wrong turn.
  assert.ok(!game.parseAction(state, 1, 'd3').ok);
});

test('index: pass parses only when no placement exists', () => {
  const passState = stateFrom(['b3', 'c3', 'd3', 'e3', 'f3', 'g3'], ['h3'], 0);
  const parsed = game.parseAction(passState, 0, 'PASS');
  assert.ok(parsed.ok);
  assert.equal(/** @type {{ action: string }} */ (parsed).action, 'pass');
  // A square is rejected when the mover has no placement.
  const placed = game.parseAction(passState, 0, 'a3');
  assert.ok(!placed.ok);
  assert.match(/** @type {{ error: string }} */ (placed).error, /pass/);
  // After the pass, White has a placement and can no longer pass.
  const afterPass = applyPass(passState, 0);
  const late = game.parseAction(afterPass, 1, 'pass');
  assert.ok(!late.ok);
  assert.match(/** @type {{ error: string }} */ (late).error, /cannot pass/);
});

test('index: truncate on a live position scores the disc majority', () => {
  const state = emptyState(0);
  const outcome = game.truncate(state);
  assert.deepEqual(outcome.normalized, [0.5, 0.5]);
  assert.match(outcome.reason, /level 2-2/);
  // A finished position truncates to the real outcome (pass fixture: after
  // Black's forced pass, White's a3 wipes Black out, 8-0).
  let finished = stateFrom(['b3', 'c3', 'd3', 'e3', 'f3', 'g3'], ['h3'], 0);
  finished = applyPass(finished, 0);
  finished = applyPlacement(finished, 1, 0, 2);
  assert.equal(finished.status, 'over');
  const over = /** @type {import('../../core/types.js').Outcome} */ (game.truncate(finished));
  assert.deepEqual(over.normalized, [0, 1]);
  assert.ok(over.reason.length > 0);
});

test('index: the random opponent is deterministic per seed and turn', async () => {
  const tier = game.spec.tiers[0];
  const opponent = /** @type {NonNullable<typeof game.opponent>} */ (game.opponent);
  const state = emptyState(0);
  const ctx = makeCtx(state, 0, ['c4', 'd3', 'e6', 'f5'], 0);
  const a = await opponent(tier, 'seed-x', 1).act(ctx);
  const b = await opponent(tier, 'seed-x', 1).act(ctx);
  assert.equal(a.text, b.text);
  assert.ok(['c4', 'd3', 'e6', 'f5'].includes(a.text));
});

test('runner: the greedy baseline completes legal episodes on every tier', async () => {
  for (const tier of game.spec.tiers) {
    const trajectory = await runEpisode({
      game,
      tierId: tier.id,
      seed: `othello/${tier.id}/public/0`,
      agent: createGreedyAgent(),
    });
    assert.equal(trajectory.game.id, 'othello', tier.id);
    assert.equal(trajectory.end.invalidActions, 0, tier.id);
    assert.ok(trajectory.end.outcome, `${tier.id} should finish with an outcome`);
    const outcome = /** @type {import('../../core/types.js').Outcome} */ (trajectory.end.outcome);
    assert.equal(outcome.normalized.length, game.spec.seats);
    assert.ok(
      outcome.normalized.every((v) => v === 0.5 || v === 0 || v === 1),
      `${tier.id}: normalized ${outcome.normalized.join(',')}`
    );
    assert.ok(trajectory.end.agentActions > 0);
    assert.ok(trajectory.end.agentActions <= tier.maxActions, `${tier.id}: ${trajectory.end.agentActions} actions`);
    for (const step of trajectory.steps) {
      assert.equal(step.invalid, false, `${tier.id}: ${step.reply.text}`);
    }
  }
});

test('runner: the engine baseline beats the random opponent on ladder-1', async () => {
  let score = 0;
  for (let i = 0; i < 3; i++) {
    const trajectory = await runEpisode({
      game,
      tierId: 'ladder-1',
      seed: `othello/ladder-1/public/${i}`,
      agent: createEngineAgent(6000),
    });
    const outcome = /** @type {import('../../core/types.js').Outcome} */ (trajectory.end.outcome);
    const tier = game.spec.tiers[0];
    const seat = seatOf(tier, `othello/ladder-1/public/${i}`);
    score += outcome.normalized[seat];
  }
  assert.ok(score >= 2, `engine vs random scored ${score}/3`);
});

test('conformance: the full kit passes on three seeds per tier', async () => {
  const report = await runConformance(game);
  assert.equal(report.ok, true);
  assert.ok(report.checks > 0);
});
