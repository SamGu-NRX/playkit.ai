/**
 * Tests for the Connect Four game: rules, engine behavior, the game bundle's
 * contract surface, the runner end to end on every tier, conformance, and the
 * baselines.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COLUMNS,
  HEIGHT,
  WIDTH,
  applyMove,
  emptyState,
  legalCols,
} from './rules.js';
import { chooseExactMove, chooseMove, solveExact } from './engine.js';
import game, { MIN_WIN_PLIES, MAX_WIN_PLIES } from './index.js';
import { createEngineAgent, createGreedyAgent } from './baselines.js';
import { runEpisode } from '../../core/runner.js';
import { runConformance } from '../../core/conformance.js';
import { getGame } from '../../games/index.js';

/**
 * The game's optional agentSeat method, narrowed to non-optional for tests.
 *
 * @type {NonNullable<typeof game.agentSeat>}
 */
const seatOf = /** @type {NonNullable<typeof game.agentSeat>} */ (game.agentSeat);

/**
 * Play a column sequence from an empty board, seat 0 first.
 *
 * @param {number[]} moves
 * @returns {ReturnType<typeof emptyState>}
 */
function played(moves) {
  let state = emptyState(0);
  for (const col of moves) {
    state = applyMove(state, state.toMove, col);
  }
  return state;
}

test('the registered game is connect4', () => {
  assert.equal(getGame('connect4'), game);
  assert.equal(game.spec.id, 'connect4');
  assert.equal(game.spec.seats, 2);
  assert.equal(game.spec.stochastic, false);
  assert.equal(game.spec.benchmark, true);
  assert.equal(game.spec.information, 'perfect');
  assert.deepEqual(game.spec.tags.sort(), ['adversarial', 'deduction', 'planning']);
});

test('rules: an empty board has seven legal columns and a nearly full column fewer', () => {
  const empty = emptyState(0);
  assert.deepEqual(legalCols(empty), [0, 1, 2, 3, 4, 5, 6]);
  let state = empty;
  for (let i = 0; i < HEIGHT; i++) {
    state = applyMove(state, state.toMove, 0);
  }
  assert.deepEqual(legalCols(state), [1, 2, 3, 4, 5, 6]);
});

test('rules: a horizontal four wins with the winning seat recorded', () => {
  // X plays 0,1,2 then 3; O sprinkles in 6.
  const state = played([0, 6, 1, 6, 2, 6, 3]);
  assert.equal(state.status, 'won');
  assert.equal(state.winner, 0);
  assert.equal(state.toMove, 1);
  assert.equal(game.toAct(state), null);
  const outcome = /** @type {import('../../core/types.js').Outcome} */ (game.outcome(state));
  assert.deepEqual(outcome.normalized, [1, 0]);
  assert.deepEqual(outcome.raw, ['win', 'loss']);
});

test('rules: a vertical four wins', () => {
  const state = played([0, 6, 0, 6, 0, 6, 0]);
  assert.equal(state.status, 'won');
  assert.equal(state.winner, 0);
});

test('rules: a diagonal four wins', () => {
  // Up-right diagonal for X at (0,0), (1,1), (2,2), (3,3).
  const state = played([0, 0, 1, 1, 2, 5, 2, 6, 3]);
  assert.equal(state.status, 'won');
  assert.equal(state.winner, 0);
});

test('rules: step never mutates its input and blocks illegal plays', () => {
  const state = played([0, 1]);
  const before = JSON.stringify(state);
  const next = game.step(state, 0, 'column 4');
  assert.equal(JSON.stringify(state), before);
  assert.equal(next.heights[3], 1);
  assert.throws(() => game.step(state, 1, '3'));
  assert.throws(() => game.step(state, 1, 'column 3'), /not seat 1/);
  assert.throws(() => game.step(state, 0, 'drop column 9'), /cannot parse/);
  assert.throws(() => game.step(state, 0, 'banana'), /cannot parse/);
  const full = played([0, 0, 0, 0, 0, 0]);
  assert.throws(() => game.step(full, full.toMove, '1'), /full/);
});

test('rules: parseAction accepts the canonical column and the documented alternates', () => {
  const state = emptyState(0);
  for (const [text, expected] of [
    ['4', '4'],
    [' 4 ', '4'],
    ['column 4', '4'],
    ['col 4', '4'],
    ['play 4', '4'],
    ['drop 4', '4'],
    ['place 4', '4'],
    ['move 4', '4'],
    ['COLUMN 4', '4'],
    ['"4"', '4'],
    ['`col 4`', '4'],
    ["'4'", '4'],
  ]) {
    const parsed = game.parseAction(state, 0, text);
    assert.deepEqual(parsed, { ok: true, action: expected }, `input ${JSON.stringify(text)}`);
  }
  for (const bad of ['3.5', '-1', 'four', '', 'drop', '44', 'col: 4', '8', '0']) {
    const parsed = game.parseAction(state, 0, bad);
    assert.equal(parsed.ok, false, `input ${JSON.stringify(bad)}`);
    assert.equal(typeof parsed.error, 'string');
  }
  // Columns 1 and 3 are full without a line of four anywhere (each column's
  // stack alternates colors because consecutive moves fill the same column).
  const stacked = played([0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2]);
  assert.deepEqual(game.legalActions(stacked, stacked.toMove), ['2', '4', '5', '6', '7']);
});

test('rules: a full board without four-in-a-row is a draw', () => {
  // A generated fill sequence reaching a full board with no four anywhere.
  let state = emptyState(0);
  for (const col of [
    3, 4, 5, 6, 3, 5, 0, 6, 1, 6, 3, 5, 0, 3, 4, 3, 6, 0, 5, 3, 0, 2, 0, 1,
    5, 2, 4, 5, 2, 6, 4, 1, 0, 4, 4, 1, 1, 6, 1, 2, 2, 2,
  ]) {
    state = applyMove(state, state.toMove, col);
  }
  assert.equal(state.status, 'draw');
  const outcome = /** @type {import('../../core/types.js').Outcome} */ (game.outcome(state));
  assert.deepEqual(outcome.normalized, [0.5, 0.5]);
  assert.equal(game.outcome(emptyState(0)), null);
});

test('engine: takes an immediate win and blocks an immediate loss', () => {
  const win = played([0, 6, 0, 6, 0, 6]); // X has three in column 0
  assert.equal(chooseMove(win, { depth: 2 }).col, 0);
  // O to move; X threatens column 0 and O has no win of its own.
  const block = played([0, 6, 0, 6, 0, 5, 1]);
  assert.equal(chooseMove(block, { depth: 4 }).col, 0);
});

test('engine: prefers the center opening and finds a forced mate', () => {
  assert.equal(chooseMove(emptyState(0), { depth: 8 }).col, 3);

  // X has three-in-a-column stacks at 0, 1, 2 and plays 3 for a horizontal four.
  const state = played([0, 0, 1, 1, 2, 2]);
  const choice = chooseMove(state, { depth: 6 });
  assert.equal(choice.col, 3);
  assert.ok(choice.score > 999900, `score should be a mate score, got ${choice.score}`);
});

test('engine: exact solver separates win, loss, and unproven distances', () => {
  // X to move with the immediate win.
  const winValue = solveExact(played([0, 6, 0, 6, 0, 6]));
  assert.deepEqual(winValue, { verdict: 'win', plies: 1 });

  // O to move in a double threat (X wins through column 1 or column 5):
  // a forced loss for O, proven within the horizon.
  const lossValue = solveExact(played([2, 0, 2, 5, 5, 1, 0, 3, 4, 6, 4, 0, 4]), { horizon: 15 });
  assert.equal(lossValue.verdict, 'loss');
  assert.ok(lossValue.plies !== null && lossValue.plies >= 2);

  // From the empty board nothing is forced within nine plies.
  assert.deepEqual(solveExact(emptyState(0), { horizon: 9 }), { verdict: 'unproven', plies: null });

  // chooseExactMove matches the solver's verdict and produces a legal move.
  const choice = chooseExactMove(played([0, 6, 0, 6, 0, 6, 1]), null);
  assert.equal(choice.verdict, 'win');
  assert.ok(choice.col >= 0 && choice.col < WIDTH);
});

test('engine: same seed gives the same tie-breaks, moves stay legal', () => {
  const state = emptyState(0);
  const a = chooseMove(state, { depth: 5, seedKey: 'seed-a' });
  const a2 = chooseMove(state, { depth: 5, seedKey: 'seed-a' });
  const b = chooseMove(state, { depth: 5, seedKey: 'seed-b' });
  assert.equal(a.col, a2.col);
  assert.ok([a.col, b.col].every((col) => legalCols(state).includes(col)));
});

test('game: the tier ladder has ascending engine depths and a forced-win tier', () => {
  const tiers = game.spec.tiers;
  assert.deepEqual(
    tiers.map((t) => t.id),
    ['ladder-1', 'ladder-2', 'ladder-3', 'ladder-4', 'forced-win']
  );
  assert.deepEqual(
    tiers.map((t) => t.params),
    [
      { opponent: 'random' },
      { opponent: 'engine', depth: 4 },
      { opponent: 'engine', depth: 8 },
      { opponent: 'engine', depth: 12 },
      { opponent: 'engine', depth: 12, exact: true, minWinPlies: 17, maxWinPlies: 21 },
    ]
  );
  for (const tier of tiers) {
    assert.equal(tier.scoring, 'outcome');
    assert.equal(tier.maxActions, 30);
    assert.equal(tier.publicSeeds, 12);
  }
  assert.deepEqual(COLUMNS, ['1', '2', '3', '4', '5', '6', '7']);
  assert.ok(game.spec.rulesText.includes('7-column by 6-row'));
  assert.ok(game.spec.rulesText.includes('e.g. "4"'));
});

test('game: the agent seat alternates across public seeds on every tier', () => {
  for (const tier of game.spec.tiers) {
    const seats = new Set();
    for (let i = 0; i < tier.publicSeeds; i++) {
      seats.add(seatOf(tier, `public-${i}`));
    }
    assert.ok(seats.has(0) && seats.has(1), `${tier.id}: seats ${[...seats].join(',')}`);
  }
});

test('game: forced-win positions are generated, legal, and announced', () => {
  const tier = /** @type {typeof game.spec.tiers[number]} */ (
    game.spec.tiers.find((t) => t.id === 'forced-win')
  );
  let wins = 0;
  // public-10 and public-56 are the seeds whose first generation pass finds
  // no position; they exercise the retry pass, which must stay inside the
  // advertised band.
  for (const seed of ['public-0', 'public-1', 'public-2', 'public-10', 'public-56']) {
    const state = game.reset(tier, seed);
    assert.equal(state.status, 'playing');
    assert.ok(state.discs >= 18, `too few discs: ${state.discs}`);
    assert.equal(state.toMove, state.agentSeat);
    assert.ok(
      state.forcedWinPlies !== null &&
        state.forcedWinPlies >= tier.params.minWinPlies &&
        state.forcedWinPlies <= tier.params.maxWinPlies,
      `win distance out of the advertised band: ${state.forcedWinPlies}`
    );
    const value = solveExact(state);
    assert.equal(value.verdict, 'win');
    const seat = state.agentSeat;
    const obs = game.observe(state, seat);
    assert.ok(obs.text.includes('forced win'), 'the observation announces the forced win');
    assert.ok(obs.text.includes(`seat ${seat}`));
    assert.ok(game.legalActions(state, seat).length > 0);
    wins++;
  }
  assert.equal(wins, 5);
});

test('game: the forced-win band constants are the exported tier contract', () => {
  // The band must never go shallow again: the calibration defect this tier
  // fixes came from positions weak agents could convert by luck.
  assert.equal(typeof MIN_WIN_PLIES, 'number');
  assert.equal(typeof MAX_WIN_PLIES, 'number');
  assert.ok(MIN_WIN_PLIES >= 13, `band floor must stay deep, got ${MIN_WIN_PLIES}`);
  assert.ok(MAX_WIN_PLIES >= MIN_WIN_PLIES, `band must be non-empty, got ${MIN_WIN_PLIES}..${MAX_WIN_PLIES}`);
});

test('game: reset is deterministic per tier and seed', () => {
  for (const tier of game.spec.tiers) {
    for (const seed of ['public-0', 'public-1']) {
      const a = JSON.stringify(game.reset(tier, seed));
      const b = JSON.stringify(game.reset(tier, seed));
      assert.equal(a, b, `${tier.id}/${seed}`);
    }
  }
});

test('game: observations render the board, mover, marks, and legal actions', () => {
  const state = played([0, 6, 0]);
  const obs = game.observe(state, 0);
  assert.ok(obs.text.includes('You are seat 0 (X)'));
  assert.ok(obs.text.includes('O to move.'));
  assert.ok(obs.text.includes('1, 2, 3, 4, 5, 6, 7'));
  assert.ok(obs.text.includes('X . . . . . .'));
  assert.ok(obs.text.includes('X . . . . . O'));
  const opponentView = game.observe(state, 1);
  assert.ok(opponentView.text.includes('You are seat 1 (O)'));
});

test('game: truncation on a live position scores it as perfect play would', () => {
  const losing = played([0, 6, 0, 6, 0, 6, 1]); // O to move, losing by force
  const outcome = game.truncate(losing);
  assert.equal(outcome.raw, null);
  assert.ok(outcome.reason.includes('truncated'));
  assert.ok(outcome.normalized.every((v) => v === 0.5 || v === 0 || v === 1));
  // X to move with the immediate win available: seat 0 wins.
  const winning = game.truncate(played([0, 6, 0, 6, 0, 6]));
  assert.deepEqual(winning.normalized, [1, 0]);
});

test('runner: episodes run to a scored outcome on every tier', async () => {
  const agent = createEngineAgent(6);
  for (const tier of game.spec.tiers) {
    const trajectory = await runEpisode({
      game,
      tierId: tier.id,
      seed: 'public-0',
      agent,
    });
    assert.equal(trajectory.game.id, 'connect4');
    assert.equal(trajectory.tier, tier.id);
    assert.equal(trajectory.end.invalidActions, 0, `${tier.id}`);
    assert.ok(trajectory.end.outcome, `${tier.id} should finish with an outcome`);
    const outcome = /** @type {import('../../core/types.js').Outcome} */ (trajectory.end.outcome);
    assert.equal(outcome.normalized.length, game.spec.seats);
    assert.ok(
      outcome.normalized.every((v) => v === 0.5 || v === 0 || v === 1),
      `${tier.id}: normalized ${outcome.normalized.join(',')}`
    );
    assert.ok(trajectory.end.agentActions > 0);
    assert.ok(trajectory.end.agentActions <= tier.maxActions, `${tier.id}: agentActions ${trajectory.end.agentActions}`);
    assert.ok(trajectory.steps.length > 0);
    for (const step of trajectory.steps) {
      assert.equal(step.invalid, false, `${tier.id}: ${step.reply.text}`);
    }
  }
});

test('runner: same seed and agent reproduce the same trajectory', async () => {
  const run = async () => {
    const trajectory = await runEpisode({
      game,
      tierId: 'ladder-3',
      seed: 'public-3',
      agent: createEngineAgent(6),
    });
    return JSON.stringify({
      seat: trajectory.agent.seat,
      steps: trajectory.steps.map((s) => s.action),
      outcome: trajectory.end.outcome,
    });
  };
  assert.equal(await run(), await run());
});

test('runner: invalid replies draw feedback and forfeit after three', async () => {
  const trajectory = await runEpisode({
    game,
    tierId: 'ladder-1',
    seed: 'public-0',
    agent: {
      id: 'always-wrong',
      track: /** @type {'baseline'} */ ('baseline'),
      async act() {
        return { text: 'banana' };
      },
    },
  });
  assert.equal(trajectory.end.reason, 'forfeit-invalid');
  assert.equal(trajectory.end.invalidActions, 3);
});

test('baselines: greedy blocks a single threat and takes an immediate win', async () => {
  const greedy = createGreedyAgent();
  // O to move; X threatens column 0 and O has no win of its own.
  const blockState = played([0, 6, 0, 6, 0, 5, 1]);
  const blockMove = await greedy.act({
    spec: game.spec,
    tier: /** @type {typeof game.spec.tiers[number]} */ (game.spec.tiers[0]),
    seat: blockState.toMove,
    turn: 0,
    observation: { text: '', data: blockState },
    legalActions: ['1', '2', '3', '4', '5', '6', '7'],
    feedback: null,
  });
  assert.equal(blockMove.text, '1');

  const winState = played([0, 6, 0, 6, 0, 6]);
  const winMove = await greedy.act({
    spec: game.spec,
    tier: /** @type {typeof game.spec.tiers[number]} */ (game.spec.tiers[0]),
    seat: winState.toMove,
    turn: 0,
    observation: { text: '', data: winState },
    legalActions: ['1', '2', '3', '4', '5', '6', '7'],
    feedback: null,
  });
  assert.equal(winMove.text, '1');
});

test('baselines: engine agent answers with a legal column', async () => {
  const engine = createEngineAgent(4);
  const state = played([0, 6, 1]);
  const move = await engine.act({
    spec: game.spec,
    tier: /** @type {typeof game.spec.tiers[number]} */ (game.spec.tiers[1]),
    seat: state.toMove,
    turn: 2,
    observation: { text: '', data: state },
    legalActions: ['1', '2', '3', '4', '5', '6', '7'],
    feedback: null,
  });
  assert.ok(/^[1-7]$/.test(move.text));
});

test('baselines: greedy beats random across public seeds', async () => {
  const tier = /** @type {typeof game.spec.tiers[number]} */ (game.spec.tiers[0]);
  let score = 0;
  for (let i = 0; i < tier.publicSeeds; i++) {
    const seed = `public-${i}`;
    const trajectory = await runEpisode({
      game,
      tierId: tier.id,
      seed,
      agent: createGreedyAgent(),
    });
    const agentSeat = trajectory.agent.seat;
    score += /** @type {import('../../core/types.js').Outcome} */ (trajectory.end.outcome)
      .normalized[agentSeat];
  }
  assert.ok(score > 6, `greedy should beat random over 12 seeds, scored ${score}`);
});

test('the full conformance kit passes for connect4', async () => {
  const report = await runConformance(game);
  assert.equal(report.ok, true);
  assert.ok(report.checks > 50, `expected a substantial check count, got ${report.checks}`);
});
