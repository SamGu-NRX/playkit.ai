/**
 * Tests for the Go (9x9) game: hand-derived rule positions (captures, ko,
 * suicide, two-pass ending, area scoring), the contract surface, the runner
 * end to end, conformance (the random tier always; the engine ladder when a
 * GNU Go binary is present), and the baselines.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  areaScore,
  boardString,
  emptyState,
  groupAndLiberties,
  nameOf,
  parseName,
} from './rules.js';
import game from './index.js';
import { createGreedyAgent, gnugoSeedInt } from './baselines.js';
import { createRandomAgent } from '../../agents/random.js';
import { runEpisode } from '../../core/runner.js';
import { runConformance } from '../../core/conformance.js';
import { findGtpBinary } from '../../engines/gtp/client.js';

const REAL_BINARY = findGtpBinary();

/**
 * Play a sequence of canonical actions from the empty board, alternating
 * seats from Black, following the game's own parse path. Every listed action
 * must be legal; the first rejection fails the test.
 *
 * @param {string[]} actions
 * @param {number} [agentSeat]
 * @returns {import('./rules.js').GoState}
 */
function playSequence(actions, agentSeat = 0) {
  let state = emptyState(agentSeat);
  for (const action of actions) {
    const seat = state.toMove;
    const parsed = game.parseAction(state, seat, action);
    assert.equal(parsed.ok, true, `setup action "${action}" rejected: ${parsed.ok ? '' : parsed.error}`);
    state = game.step(state, seat, /** @type {{ ok: true, action: string }} */ (parsed).action);
  }
  return state;
}

test('rules: coordinates skip the letter I and A1 is the first index', () => {
  assert.equal(nameOf(0, 0), 'A1');
  assert.equal(nameOf(8, 8), 'J9');
  assert.equal(parseName('i5'), null);
  assert.deepEqual(parseName('j5'), { col: 8, row: 4 });
  assert.deepEqual(parseName('d5'), { col: 3, row: 4 });
});

test('rules: a lone centre stone has four liberties', () => {
  const state = playSequence(['E5']);
  const group = groupAndLiberties(state.board, 4 * 9 + 4);
  assert.equal(group.stones.length, 1);
  assert.equal(group.liberties, 4);
});

test('rules: a corner stone is captured when its last liberty is filled', () => {
  // Black A1; White B1 takes one liberty; Black plays elsewhere; White A2
  // takes the last liberty and removes the stone.
  const state = playSequence(['A1', 'B1', 'J9', 'A2']);
  assert.equal(state.board[0], 0, 'A1 should be empty after the capture');
  assert.equal(state.captures[1], 1, 'White has one capture');
  assert.equal(state.captures[0], 0);
  // One stone captured by a group with more than one liberty is not a ko.
  assert.equal(state.koPoint, null);
});

test('rules: playing into a fully enclosed point is rejected as suicide', () => {
  // Black builds {A1, A2, B2, C1}: after White's J-stone fillers, the point B1
  // is bordered by A1, B2, C1 — all Black — so White playing B1 captures
  // nothing and leaves no liberty.
  const state = playSequence([
    'A1', 'J9', 'A2', 'J8', 'B2', 'J7', 'C1', 'J6', 'E5',
  ]);
  const parsed = game.parseAction(state, 1, 'B1');
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : /** @type {{error: string}} */ (parsed).error, /suicide/i);
  // The owner of the surrounding wall plays the same point legally (Black to
  // move on the same wall without the E5 filler).
  const blackTurn = playSequence(['A1', 'J9', 'A2', 'J8', 'B2', 'J7', 'C1', 'J6']);
  const own = game.parseAction(blackTurn, 0, 'B1');
  assert.equal(own.ok, true);
});

test('rules: simple ko bars the immediate recapture and the observation names the point', () => {
  // Edge ko: B(A2) W(B2) B(C2) W(C1) B(B1) W(A1) captures B1; Black's instant
  // recapture at B1 would recreate the position before White A1.
  const before = playSequence(['A2', 'B2', 'C2', 'C1', 'B1', 'A1']);
  assert.equal(before.board[0], 2, 'White stone sits at A1');
  assert.equal(before.captures[1], 1);
  assert.equal(before.koPoint, 'B1', 'the ko point is the captured stone');
  const observation = game.observe(before, 0);
  assert.match(observation.text, /Ko: immediately recapturing at B1 is barred/);
  const parsed = game.parseAction(before, 0, 'B1');
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? '' : /** @type {{error: string}} */ (parsed).error, /superko/);
  // One move elsewhere (a ko threat) and the recapture becomes legal again.
  const afterThreat = playSequence(['A2', 'B2', 'C2', 'C1', 'B1', 'A1', 'J9']);
  const recapture = game.parseAction(afterThreat, 1, 'B1');
  assert.equal(recapture.ok, true, 'after a threat in between, the recapture is legal');
});

test('rules: capturing two stones is not a ko, so the point is refillable at once', () => {
  // White {B1, C1} under the Black second-rank wall; Black D1 takes one
  // liberty, White passes, Black A1 takes the other and captures both.
  const state = playSequence(['A2', 'B1', 'B2', 'C1', 'C2', 'J9', 'D2', 'J8', 'D1', 'pass', 'A1']);
  assert.equal(state.board[1], 0, 'B1 is gone');
  assert.equal(state.board[2], 0, 'C1 is gone');
  assert.equal(state.captures[0], 2);
  assert.equal(state.koPoint, null, 'a two-stone capture is never a ko');
  const refill = game.parseAction(state, 1, 'B1');
  assert.equal(refill.ok, true, 'White may immediately refill at B1');
});

test('rules: two consecutive passes end the game and the position is area-scored', () => {
  // Black {A1, A2, B1}, White {H1, J2}: area Black 3; White has 2 stones plus
  // the single-point eye J1 (bordered only by H1 and J2) plus komi 7 = 10.
  const state = playSequence(['A2', 'H1', 'A1', 'J2', 'B1', 'pass', 'pass']);
  assert.equal(state.status, 'over');
  const outcome = game.outcome(state);
  assert.ok(outcome);
  assert.deepEqual(outcome.normalized, [0, 1]);
  assert.deepEqual(outcome.raw, ['3', '10']);
  assert.match(outcome.reason, /seat 1 \(White\) wins by 7 on area/);
  // toAct is null on the finished state.
  assert.equal(game.toAct(state), null);
});

test('rules: area scoring counts stones plus surrounded empty regions and skips dame', () => {
  // Black fills ranks 1-2, White fills ranks 8-9; the empty middle borders
  // both colours, so it is dame.
  /** @type {string[]} */
  const actions = [];
  for (let col = 0; col < 9; col++) {
    actions.push(`play ${nameOf(col, 0)}`);
    actions.push(`play ${nameOf(col, 8)}`);
  }
  for (let col = 0; col < 9; col++) {
    actions.push(`play ${nameOf(col, 1)}`);
    actions.push(`play ${nameOf(col, 7)}`);
  }
  const state = playSequence(actions.slice(0, 36));
  const score = areaScore(state.board);
  assert.equal(score.black, 18);
  assert.equal(score.white, 25);
  assert.equal(score.blackTerritory, 0);
  assert.equal(score.whiteTerritory, 0);
  assert.equal(score.dame, 45);
  const outcome = game.outcome({ ...state, status: 'over' });
  assert.ok(outcome);
  assert.deepEqual(outcome.raw, ['18', '25']);
});

test('rules: a two-stone group is removed together', () => {
  // Black {A1, B1} against White's C1; White A2 and B2 close the cage.
  const state = playSequence(['B1', 'C1', 'A1', 'D1', 'J9', 'A2', 'J8', 'B2']);
  assert.equal(state.board[0], 0);
  assert.equal(state.board[1], 0);
  assert.equal(state.captures[1], 2);
});

test('rules: superko history survives a JSON round trip', () => {
  const state = playSequence(['E5', 'E4', 'D5']);
  const restored = /** @type {import('./rules.js').GoState} */ (JSON.parse(JSON.stringify(state)));
  assert.equal(boardString(restored.board), boardString(state.board));
  assert.deepEqual(restored.superko, state.superko);
  const parsed = game.parseAction(restored, 1, 'D4');
  assert.equal(parsed.ok, true);
});

test('contract: parseAction accepts the documented alternates and canonicalises', () => {
  const state = emptyState(0);
  for (const text of ['D5', 'd5', 'play D5', 'play d5', 'move d5', 'place D5', '"d5"', '`D5`', ' action: play d5 ']) {
    const parsed = game.parseAction(state, 0, text);
    assert.equal(parsed.ok, true, `"${text}" should parse`);
    assert.equal(parsed.ok ? parsed.action : '', 'play D5');
  }
  const pass = game.parseAction(state, 0, 'pass');
  assert.equal(pass.ok, true);
  assert.equal(pass.ok ? pass.action : '', 'pass');
});

test('contract: parseAction rejects malformed output with precise errors', () => {
  const state = emptyState(0);
  for (const text of ['__not_a_gauntlet_action__', 'hello world', 'I5', 'K3', 'D0', 'D10', 'resign']) {
    const parsed = game.parseAction(state, 0, text);
    assert.equal(parsed.ok, false, `"${text}" should not parse`);
  }
  const iParsed = game.parseAction(state, 0, 'I5');
  assert.match(iParsed.ok ? '' : /** @type {{error: string}} */ (iParsed).error, /without I/);
  const wrongSeat = game.parseAction(state, 1, 'D5');
  assert.equal(wrongSeat.ok, false);
  assert.match(wrongSeat.ok ? '' : /** @type {{error: string}} */ (wrongSeat).error, /turn/);
});

test('contract: legalActions at the start lists every point plus pass, sorted', () => {
  const state = emptyState(0);
  const legal = game.legalActions(state, 0);
  assert.equal(legal.length, 82);
  assert.deepEqual(legal, legal.slice().sort());
  assert.equal(legal[0], 'pass');
  assert.ok(legal.includes('play A1'));
  assert.ok(legal.includes('play J9'));
  assert.ok(!legal.some((action) => action.includes('I')));
  assert.deepEqual(game.legalActions(state, 1), [], 'the wrong seat has no legal actions');
});

test('contract: the observation lists legal actions when there are at most 64', () => {
  const start = game.observe(emptyState(0), 0);
  assert.match(start.text, /Legal actions \(82 > 64, not listed\)/);
  assert.ok(!start.text.includes('play A1,'));
  // Fill two full ranks per side: 36 stones down, 45 empty points left.
  /** @type {string[]} */
  const fill = [];
  for (let col = 0; col < 9; col++) {
    fill.push(`play ${nameOf(col, 0)}`);
    fill.push(`play ${nameOf(col, 8)}`);
  }
  for (let col = 0; col < 9; col++) {
    fill.push(`play ${nameOf(col, 1)}`);
    fill.push(`play ${nameOf(col, 7)}`);
  }
  const mid = playSequence(fill.slice(0, 36));
  const observation = game.observe(mid, 1);
  assert.match(observation.text, /Legal actions \(46, at most 64 so all are listed\)/);
  for (const action of game.legalActions(mid, 1)) {
    assert.ok(observation.text.includes(action), `observation should list ${action}`);
  }
});

test('contract: the observation names the seat, the mover, and the running area count', () => {
  const observation = game.observe(emptyState(0), 0);
  assert.match(observation.text, /You are seat 0 \(Black\)/);
  assert.match(observation.text, /Black to move\./);
  assert.match(observation.text, /Black 0, White 7/);
  const data = /** @type {import('./rules.js').GoState} */ (observation.data);
  assert.equal(data.agentSeat, 0);
  assert.equal(data.board.length, 81);
});

test('contract: the board rendering puts A1 at the bottom-left and J9 at the top-right', () => {
  const state = playSequence(['A1', 'J9']);
  const observation = game.observe(state, 0);
  const rank1 = /** @type {string} */ (observation.text.split('\n').find((line) => line.startsWith('  1 ')));
  const rank9 = /** @type {string} */ (observation.text.split('\n').find((line) => line.startsWith('  9 ')));
  assert.match(rank1, /^  1 X/);
  assert.match(rank9, /O$/);
});

test('contract: the agent seat alternates across seeds and reset agrees', () => {
  const tier = game.spec.tiers[0];
  const seats = new Set();
  for (let i = 0; i < 8; i++) {
    const seed = `go/ladder-1/public/${i}`;
    const seat = /** @type {NonNullable<typeof game.agentSeat>} */ (game.agentSeat)(tier, seed);
    seats.add(seat);
    assert.equal(game.reset(tier, seed).agentSeat, seat);
  }
  assert.equal(seats.size, 2, 'both colours should appear across seeds');
});

test('contract: truncate scores by the area leader and says so', () => {
  // With agentSeat 1 (White), Black 3 vs White 2 + komi 7: the agent leads.
  const state = playSequence(['A2', 'H1', 'A1', 'J2', 'B1'], 1);
  const outcome = game.truncate(state);
  assert.deepEqual(outcome.normalized, [0, 1]);
  assert.equal(outcome.raw, null);
  assert.match(outcome.reason, /^truncated: /);
  assert.match(outcome.reason, /agent leads/);
});

test('episode: the runner completes an episode against the random opponent', async () => {
  const trajectory = await runEpisode({
    game,
    tierId: 'ladder-1',
    seed: 'go/ladder-1/public/0',
    agent: createRandomAgent({ episodeSeed: 'go/ladder-1/public/0' }),
  });
  assert.ok(trajectory.end.reason === 'terminal' || trajectory.end.reason === 'budget-exhausted');
  assert.equal(trajectory.game.id, 'go');
  assert.ok(trajectory.steps.length > 10);
  assert.ok(trajectory.steps.every((step) => !step.invalid), 'the random agent plays legal canonical actions');
  const last = /** @type {import('../../core/types.js').TrajectoryStep} */ (trajectory.steps.at(-1));
  assert.equal(last.action, 'pass', 'a two-pass ending finishes with a pass');
  const outcome = /** @type {import('../../core/types.js').Outcome} */ (trajectory.end.outcome);
  assert.match(outcome.reason, /on area|area counts are level|jigo \(draw\)/);
});

test('baseline: greedy beats the random opponent across both colours and several seeds', async () => {
  let agentScore = 0;
  for (const seed of ['go/ladder-1/public/0', 'go/ladder-1/public/1', 'go/ladder-1/public/2', 'go/ladder-1/public/3']) {
    const trajectory = await runEpisode({
      game,
      tierId: 'ladder-1',
      seed,
      agent: createGreedyAgent({ episodeSeed: seed }),
    });
    const outcome = /** @type {import('../../core/types.js').Outcome} */ (trajectory.end.outcome);
    agentScore += outcome.normalized[trajectory.agent.seat];
  }
  assert.ok(agentScore >= 3, `greedy should dominate random; scored ${agentScore}/4`);
});

test('baseline: greedy tie-breaks are seeded and repeatable', async () => {
  const state = playSequence(['E5', 'E4', 'D5', 'D4'], 1);
  const ctx = /** @type {*} */ ({
    spec: game.spec,
    tier: game.spec.tiers[0],
    seat: 0,
    turn: 0,
    observation: game.observe(state, 0),
    legalActions: game.legalActions(state, 0),
    feedback: null,
  });
  const first = await createGreedyAgent({ episodeSeed: 'seed-a' }).act(ctx);
  const second = await createGreedyAgent({ episodeSeed: 'seed-a' }).act(ctx);
  assert.equal(first.text, second.text);
  assert.ok(game.legalActions(state, 0).includes(first.text.trim()));
});

test('baseline: gnugoSeedInt is stable, distinct, and never zero', () => {
  assert.equal(gnugoSeedInt('go/x'), gnugoSeedInt('go/x'));
  assert.notEqual(gnugoSeedInt('go/x'), gnugoSeedInt('go/y'));
  for (const seed of ['a', 'b', 'go/ladder-2/public/3', '']) {
    const value = gnugoSeedInt(seed);
    assert.ok(Number.isInteger(value) && value >= 1 && value <= 900000000, `${seed} -> ${value}`);
  }
});

test('conformance: the full kit passes on the random tier (three seeds)', async () => {
  const report = await runConformance({ ...game, spec: { ...game.spec, tiers: game.spec.tiers.slice(0, 1) } });
  assert.equal(report.ok, true, report.failures.join('\n'));
  assert.ok(report.checks > 100);
});

test('conformance: the full kit passes on every tier including the GNU Go ladder', { skip: REAL_BINARY ? false : 'no GNU Go binary found (set GAUNTLET_GNUGO or install gnugo)' }, async () => {
  const report = await runConformance(game);
  assert.equal(report.ok, true, report.failures.join('\n'));
});

test('engine: same seed and moves produce identical episodes at level 1', { skip: REAL_BINARY ? false : 'no GNU Go binary found' }, async () => {
  const runOnce = async () => {
    const trajectory = await runEpisode({
      game,
      tierId: 'ladder-2',
      seed: 'go/ladder-2/public/0',
      agent: createRandomAgent({ episodeSeed: 'go/ladder-2/public/0' }),
    });
    return {
      moves: trajectory.steps.map((step) => step.action),
      end: { reason: trajectory.end.reason, outcome: trajectory.end.outcome },
    };
  };
  const first = await runOnce();
  const second = await runOnce();
  assert.deepEqual(second, first);
  assert.ok(first.moves.length > 10);
});

test('engine: a full episode against GNU Go level 1 keeps the opponent legal', { skip: REAL_BINARY ? false : 'no GNU Go binary found' }, async () => {
  const trajectory = await runEpisode({
    game,
    tierId: 'ladder-2',
    seed: 'go/ladder-2/public/1',
    agent: createRandomAgent({ episodeSeed: 'go/ladder-2/public/1' }),
  });
  assert.ok(trajectory.end.reason === 'terminal' || trajectory.end.reason === 'budget-exhausted');
  assert.ok(trajectory.opponents[0].id.startsWith('gnugo-level-1'), 'the opponent is GNU Go level 1');
  for (const step of trajectory.steps.filter((s) => s.by === 'opponent')) {
    assert.equal(step.invalid, false);
  }
});
