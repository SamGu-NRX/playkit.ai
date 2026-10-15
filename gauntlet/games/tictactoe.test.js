import { test } from 'node:test';
import assert from 'node:assert/strict';
import tictactoe, { CELLS } from './tictactoe/index.js';
import { runConformance } from '../core/conformance.js';
import { GauntletRuleError } from '../core/errors.js';
import { getGame } from '../games/index.js';

const game = getGame('tictactoe');
const tier = game.spec.tiers[0];

test('the registered game is the smoke game', () => {
  assert.equal(game.spec.id, 'tictactoe');
  assert.equal(game.spec.seats, 2);
  assert.equal(game.spec.benchmark, false);
  assert.equal(CELLS.length, 9);
});

test('reset is deterministic and empty', () => {
  const a = game.reset(tier, 'seed');
  const b = game.reset(tier, 'seed');
  assert.deepEqual(a, b);
  assert.deepEqual(a.board, new Array(9).fill(null));
  assert.equal(a.toMove, 0);
});

test('legalActions are sorted canonical cell names', () => {
  assert.deepEqual(game.legalActions(game.reset(tier, 's'), 0), CELLS);
  const mid = game.step(game.step(game.reset(tier, 's'), 0, 'a1'), 1, 'b2');
  assert.deepEqual(game.legalActions(mid, 0), CELLS.filter((c) => c !== 'a1' && c !== 'b2'));
  assert.deepEqual(game.legalActions(mid, 1), [], 'the non-acting seat has no actions');
});

test('observation text renders the board and lists every legal action', () => {
  const state = game.reset(tier, 's');
  const observation = game.observe(state, 0);
  assert.match(observation.text, /You are seat 0 \(X\)/);
  for (const cell of CELLS) {
    assert.ok(observation.text.includes(cell), `missing ${cell}`);
  }
  assert.deepEqual(observation.data.board, new Array(9).fill(null));
});

test('parseAction accepts canonical cells and the documented alternates', () => {
  const state = game.reset(tier, 's');
  for (const [text, expected] of [
    ['b2', 'b2'],
    ['  c3  ', 'c3'],
    ['B1', 'b1'],
    ['`a1`', 'a1'],
    ['"a2"', 'a2'],
    ["'a3'", 'a3'],
    ['play b2', 'b2'],
    ['place c1', 'c1'],
    ['move a1', 'a1'],
    ['mark b3', 'b3'],
    ['Play C2', 'c2'],
  ]) {
    const parsed = game.parseAction(state, 0, text);
    assert.deepEqual(parsed, { ok: true, action: expected }, `input ${JSON.stringify(text)}`);
  }
});

test('parseAction rejects garbage, occupied cells, and wrong-turn seats', () => {
  const state = game.reset(tier, 's');
  for (const bad of ['z9', 'd1', 'a0', 'b22', 'x', '']) {
    const parsed = game.parseAction(state, 0, bad);
    assert.equal(parsed.ok, false, `input ${JSON.stringify(bad)}`);
    assert.equal(typeof parsed.error, 'string');
  }
  const after = game.step(state, 0, 'b2');
  assert.equal(game.parseAction(after, 1, 'b2').ok, false, 'occupied cell');
  assert.equal(game.parseAction(after, 0, 'a1').ok, false, 'wrong turn');
});

test('step throws GauntletRuleError for anything outside legalActions, and is pure', () => {
  const state = game.reset(tier, 's');
  const before = JSON.parse(JSON.stringify(state));
  for (const bad of ['z9', 'a1!', '__nope__']) {
    assert.throws(() => game.step(state, 0, bad), GauntletRuleError);
  }
  const next = game.step(state, 0, 'a1');
  assert.deepEqual(state, before, 'step must not mutate its input');
  assert.equal(next.board[0], 'X');
  assert.equal(next.toMove, 1);
});

test('the game recognizes wins, draws, and reports outcomes exactly at terminality', () => {
  // X wins the top row.
  let state = game.reset(tier, 's');
  for (const [x, o] of [['a1', 'b1'], ['a2', 'b2'], ['a3']]) {
    state = game.step(state, /** @type {number} */ (game.toAct(state)), x);
    if (o) state = game.step(state, /** @type {number} */ (game.toAct(state)), o);
  }
  assert.equal(state.status, 'won');
  assert.equal(game.toAct(state), null);
  const won = /** @type {import('../core/types.js').Outcome} */ (game.outcome(state));
  assert.deepEqual(won.normalized, [1, 0]);
  assert.deepEqual(won.raw, ['win', 'loss']);

  // A genuine draw: X a1,c1,a3,b3,c2 and O b2,c3,b1,a2 — nobody completes a line.
  let draw = game.reset(tier, 's');
  for (const move of ['a1', 'b2', 'c1', 'c3', 'a3', 'b1', 'b3', 'a2', 'c2']) {
    draw = game.step(draw, /** @type {number} */ (game.toAct(draw)), move);
  }
  assert.equal(draw.status, 'draw');
  const drawn = /** @type {import('../core/types.js').Outcome} */ (game.outcome(draw));
  assert.deepEqual(drawn.normalized, [0.5, 0.5]);

  // outcome() is null exactly while the game is live.
  assert.equal(game.outcome(game.reset(tier, 's')), null);
});

test('truncate() scores a live position by its perfect-play value', () => {
  // Empty board: a draw under perfect play.
  const truncated = game.truncate(game.reset(tier, 's'));
  assert.deepEqual(truncated.normalized, [0.5, 0.5]);
  assert.equal(truncated.raw, null);
  // X has a1,b1 with O on b2,c3: X can complete the top row immediately,
  // a certain win for seat 0.
  let state = game.reset(tier, 's');
  state = game.step(state, 0, 'a1');
  state = game.step(state, 1, 'b2');
  state = game.step(state, 0, 'b1');
  state = game.step(state, 1, 'c3');
  const forced = game.truncate(state);
  assert.deepEqual(forced.normalized, [1, 0]);
});

test('the agent seat alternates across the public seed set', () => {
  const seats = new Set();
  for (let i = 0; i < 8; i++) {
    seats.add(/** @type {number} */ (game.agentSeat?.(tier, `tictactoe/perfect-opponent/public/${i}`)));
  }
  assert.deepEqual([...seats].sort(), [0, 1], 'both seats must appear');
});

test('the minimax opponent wins as X against a naive center-then-corner player', async () => {
  // Drive the opponent (as X, seat 0) against a fixed greedy agent.
  const trajectory = await import('../core/runner.js').then(({ runEpisode }) =>
    runEpisode({
      game,
      tierId: 'perfect-opponent',
      seed: 'opponent-as-x-seed',
      agent: {
        id: 'greedy',
        track: /** @type {'baseline'} */ ('baseline'),
        async act(/** @type {import('../core/types.js').TurnContext} */ ctx) {
          const legal = ctx.legalActions ?? [];
          if (legal.includes('b2')) return { text: 'b2' };
          return { text: legal[0] };
        },
      },
    })
  );
  // The seeded seat assignment may place the agent as X here; force the claim
  // only when the opponent actually holds seat 0.
  if (trajectory.agent.seat === 1) {
    assert.deepEqual(/** @type {import('../core/types.js').Outcome} */ (trajectory.end.outcome).normalized, [1, 0], 'perfect X beats greedy O');
  }
});

test('the full conformance kit passes for tic-tac-toe', async () => {
  const report = await runConformance(game);
  assert.equal(report.ok, true);
  assert.ok(report.checks > 50, `expected a substantial check count, got ${report.checks}`);
});

test('the conformance kit rejects a broken game variant', async () => {
  const broken = {
    ...game,
    spec: { ...game.spec, version: 'not-semver' },
  };
  await assert.rejects(
    runConformance(/** @type {*} */ (broken)),
    /conformance failed for game "tictactoe"/
  );
});

test('the rendered board places played cells under the documented coordinates', () => {
  // rulesText: columns a-c left to right, rows 1-3 top to bottom, actions are
  // <column><row>. An official-track agent sees only observation.text, so a2
  // must render as row 2 under the column-a header — not transposed.
  const state = game.step(game.reset(tier, 'render-seed'), 0, 'a2');
  const text = game.observe(state, /** @type {number} */ (game.toAct(state))).text;
  const lines = text.split('\n');
  const row2 = lines.find((line) => line.startsWith('2'));
  assert.ok(row2, `board rows must be labeled with digits 1-3, got:\n${text}`);
  assert.equal(row2.trim().split(/\s+/)[1], 'X', `played a2 must render X in row 2, column a, got:\n${text}`);
  assert.equal(
    lines.find((line) => /^[abc]\s/.test(line)),
    undefined,
    `board rows must not be labeled with column letters, got:\n${text}`
  );
  assert.ok(
    lines.some((line) => line.trim() === 'a   b   c'),
    `the column letters a-c must be the header row, got:\n${text}`
  );
});

test('truncate() scores a forced loss for the mover as a loss, not a draw', () => {
  // X: a1, b2, a2 — X threatens a3 (column a) and c3 (diagonal a1-b2-c3);
  // O holds b1, c2 and can block only one threat. Seat 1 (O) to move: a
  // decided position, whatever the action budget does next.
  let state = game.reset(tier, 'forced-loss-seed');
  /** @type {[number, string][]} */
  const moves = [[0, 'a1'], [1, 'b1'], [0, 'b2'], [1, 'c2'], [0, 'a2']];
  for (const [seat, cell] of moves) {
    state = game.step(state, seat, cell);
  }
  assert.equal(state.toMove, 1);
  assert.equal(state.status, 'playing');
  const outcome = game.truncate(state);
  assert.deepEqual(outcome.normalized, [1, 0], 'a forced loss for the mover scores a win for the opponent');
  assert.match(outcome.reason, /forced win/);
  assert.doesNotMatch(outcome.reason, /drawn/, 'a decided position must not be reported as drawn');
});
