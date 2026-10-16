// Chess game tests: registration and shape, seeded reset and the opening
// book, seat alternation, perft through the public game contract, notation,
// turn enforcement, adjudication from crafted FENs, threefold through the
// environment, rendering, truncation bands, engine behaviour, baselines, and
// the conformance kit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { getGame, listGames } from '../index.js';
import { runConformance } from '../../core/conformance.js';
import { rngFromSeed } from '../../core/rng.js';
import chess, {
  chess as game,
  stateFromFen,
  stateToChess,
  PERFT_FENS,
  TRUNCATION_WIN_CP,
} from './index.js';
import { OPENINGS } from './openings.js';
import { bestMove, evaluateWhite, internals, legalUcis, MATE, quiescenceWhite, replayUci, START_FEN } from './engine.js';
import { createGreedyBaselineAgent } from './baselines.js';

/** Deep perft and the full four-tier conformance run only under GAUNTLET_SLOW=1. */
const SLOW = process.env.GAUNTLET_SLOW === '1';

/** @import { TierSpec } from '../../core/types.js' */

const PAPER = /** @type {TierSpec} */ (game.spec.tiers[0]);

test('registration: chess is registered and resolves from the registry', () => {
  assert.equal(game.spec.id, 'chess');
  assert.equal(getGame('chess'), chess);
  const ids = listGames().map((entry) => entry.spec.id);
  assert.ok(ids.includes('chess'), `chess missing from registry, got ${ids.join(', ')}`);
  assert.ok(ids.includes('tictactoe'), 'tictactoe should still be registered');
});

test('spec shape: four engine tiers, 150-action budgets, perft FENs', () => {
  assert.equal(game.spec.version, '1.1.0');
  assert.equal(game.spec.seats, 2);
  assert.equal(game.spec.information, 'perfect');
  assert.equal(game.spec.stochastic, false);
  assert.equal(game.spec.benchmark, true);
  assert.deepEqual(
    game.spec.tiers.map((tier) => tier.id),
    ['paper', 'wood', 'steel', 'granite']
  );
  assert.deepEqual(
    game.spec.tiers.map((tier) => tier.rank),
    [1, 2, 3, 4]
  );
  for (const tier of game.spec.tiers) {
    assert.equal(tier.maxActions, 150, `tier ${tier.id} maxActions must be 150`);
    assert.equal(tier.scoring, 'outcome');
    const params = /** @type {{ depth: number, nodeBudget: number }} */ (tier.params);
    assert.ok(Number.isInteger(params.depth) && params.depth >= 2, 'tier engine depth');
    assert.ok(params.nodeBudget > 0, 'tier engine node budget');
  }
  const depths = game.spec.tiers.map((tier) => /** @type {{ depth: number }} */ (tier.params).depth);
  assert.deepEqual(
    [...depths].sort((a, b) => a - b),
    depths,
    'tier depths should ascend with rank'
  );
  assert.equal(
    PERFT_FENS.start,
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  );
  assert.equal(
    PERFT_FENS.kiwipete,
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'
  );
  assert.equal(PERFT_FENS.position3, '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
});

test('reset is deterministic and lands inside the opening book', () => {
  const a = game.reset(PAPER, 'determinism-seed');
  const b = game.reset(PAPER, 'determinism-seed');
  assert.deepEqual(a, b);
  assert.ok(a.openingName, 'reset must record the opening name');
  const line = OPENINGS.find((opening) => opening.name === a.openingName);
  assert.ok(line, `opening "${a.openingName}" is not in the book`);
  assert.equal(a.openingPlies, line?.san.length);
  assert.equal(a.moves.length, line?.san.length);
  assert.equal(a.san.length, line?.san.length);
  assert.equal(a.startFen, PERFT_FENS.start);
  assert.equal(a.termination, null);
  // The stored FEN must match replaying the stored UCI list.
  const replay = replayUci(a.startFen, a.moves);
  assert.equal(replay.fen(), a.fen);
});

test('agentSeat alternates across the public seed set', () => {
  const seeds = Array.from({ length: 24 }, (_, i) => `public-seed-${i}`);
  const seats = new Set(seeds.map((seed) => game.agentSeat(PAPER, seed)));
  assert.deepEqual([...seats].sort(), [0, 1], 'agent must play both colours across seeds');
  // Deterministic per (tier, seed).
  for (const seed of seeds) {
    assert.equal(game.agentSeat(PAPER, seed), game.agentSeat(PAPER, seed));
  }
});

/**
 * Perft through the public game contract: legalActions/step only.
 *
 * @param {ReturnType<typeof stateFromFen>} state
 * @param {number} depth
 * @returns {number}
 */
function perft(state, depth) {
  if (depth === 0) return 1;
  const seat = game.toAct(state);
  if (seat === null) return 0;
  let nodes = 0;
  for (const action of game.legalActions(state, seat)) {
    const next = game.step(state, seat, action);
    nodes += perft(next, depth - 1);
  }
  return nodes;
}

test('perft through the public contract: start position 20/400/8902', () => {
  const state = stateFromFen(PERFT_FENS.start);
  assert.equal(perft(state, 1), 20);
  assert.equal(perft(state, 2), 400);
  assert.equal(perft(state, 3), 8902);
});

test('perft through the public contract: kiwipete 48/2039', () => {
  const state = stateFromFen(PERFT_FENS.kiwipete);
  assert.equal(perft(state, 1), 48);
  assert.equal(perft(state, 2), 2039);
});

test('perft through the public contract: position 3, 14/191/2812', () => {
  const state = stateFromFen(PERFT_FENS.position3);
  assert.equal(perft(state, 1), 14);
  assert.equal(perft(state, 2), 191);
  assert.equal(perft(state, 3), 2812);
});

test('quiescence detects checkmate behind pseudo-legal captures', () => {
  // Regression: the in-check mate probe used to run only when the side in
  // check had NO pseudo-legal captures, so a mated side whose captures are
  // all illegal (here: contact check by a defended queen, so every rook and
  // pawn capture leaves the king in check) fell through to stand-pat. The
  // root already handled bare mates exactly; this exercises the inner
  // quiescence reached from a capture: Qxe7 delivers a position where black
  // is checkmated (0 legal moves) yet still has 3 pseudo-legal captures.
  const before = stateFromFen('4k3/3pn3/3BPQ2/3Ppr2/8/8/8/K7 w - - 0 1');
  const after = stateToChess(before);
  after.move({ from: 'f6', to: 'e7' });
  assert.equal(after.isCheckmate(), true, 'the fixture must be mate after Qxe7');
  assert.equal(after.moves().length, 0);
  assert.ok(internals(after)._moves({ legal: false }).filter((/** @type {any} */ m) => m.captured || m.promotion).length > 0);
  const score = quiescenceWhite(stateToChess(before), { nodeBudget: 20000 });
  assert.ok(score > MATE - 100, `mate found through a capture must score near MATE, got ${score}`);
  // The bare mated position itself scores exactly MATE at the root.
  assert.equal(quiescenceWhite(after, { nodeBudget: 20000 }), MATE);
});

test('env steps agree with public chess.js moves over a middlegame line', () => {
  const line = [
    'e2e4',
    'e7e5',
    'g1f3',
    'b8c6',
    'f1c4',
    'f8c5',
    'c2c3',
    'g8f6',
    'd2d4',
    'e5d4',
    'c3d4',
    'c5b6',
    'e1g1',
    'e8g8',
  ];
  let state = stateFromFen(PERFT_FENS.start);
  const publicChess = new Chess();
  for (let i = 0; i < line.length; i++) {
    const seat = /** @type {number} */ (game.toAct(state));
    state = game.step(state, seat, line[i]);
    publicChess.move(line[i]);
    assert.equal(state.fen, publicChess.fen(), `FEN divergence at ply ${i + 1}`);
    assert.equal(state.moves.length, i + 1);
    assert.equal(state.san.length, i + 1);
    assert.equal(state.termination, null, `no early termination at ply ${i + 1}`);
  }
  // The SAN history from the environment matches chess.js's public SAN.
  const san = publicChess.history();
  assert.equal(state.san.length, san.length);
  for (let i = 0; i < san.length; i++) {
    assert.equal(state.san[i], san[i]);
  }
});

test('legalActions: sorted UCI for the mover, empty otherwise', () => {
  const state = game.reset(PAPER, 'legal-actions-seed');
  const seat = /** @type {number} */ (game.toAct(state));
  const legal = game.legalActions(state, seat);
  assert.deepEqual(legal, [...legal].sort());
  assert.ok(new Set(legal).size === legal.length);
  // The public chess.js move list, converted, must match exactly.
  const position = stateToChess(state);
  assert.deepEqual(legal, legalUcis(position));
  const other = seat === 0 ? 1 : 0;
  assert.deepEqual(game.legalActions(state, other), []);
  // A finished game has no legal actions for anyone.
  const mate = stateFromFen('R5k1/5ppp/8/8/8/8/8/7K b - - 0 1');
  assert.deepEqual(game.legalActions(mate, 0), []);
  assert.deepEqual(game.legalActions(mate, 1), []);
});

test('parseAction: UCI and SAN both canonicalise to UCI', () => {
  const state = stateFromFen(PERFT_FENS.start);
  assert.deepEqual(game.parseAction(state, 0, 'e2e4'), { ok: true, action: 'e2e4' });
  assert.deepEqual(game.parseAction(state, 0, 'e4'), { ok: true, action: 'e2e4' });
  assert.deepEqual(game.parseAction(state, 0, 'Nf3'), { ok: true, action: 'g1f3' });
  assert.deepEqual(game.parseAction(state, 0, '  e2e4  '), { ok: true, action: 'e2e4' });
});

test('parseAction: castling SAN', () => {
  let state = stateFromFen(PERFT_FENS.start);
  for (const uci of ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5']) {
    state = game.step(state, /** @type {number} */ (game.toAct(state)), uci);
  }
  assert.deepEqual(game.parseAction(state, 0, 'O-O'), { ok: true, action: 'e1g1' });
  assert.deepEqual(game.parseAction(state, 0, '0-0'), { ok: true, action: 'e1g1' });
});

test('parseAction: promotion and underpromotion', () => {
  const state = stateFromFen('8/P7/8/8/8/8/7k/K7 w - - 0 1');
  assert.deepEqual(game.parseAction(state, 0, 'a7a8q'), { ok: true, action: 'a7a8q' });
  assert.deepEqual(game.parseAction(state, 0, 'a7a8=Q'), { ok: true, action: 'a7a8q' });
  assert.deepEqual(game.parseAction(state, 0, 'a8=Q'), { ok: true, action: 'a7a8q' });
  assert.deepEqual(game.parseAction(state, 0, 'a7a8n'), { ok: true, action: 'a7a8n' });
  assert.deepEqual(game.parseAction(state, 0, 'a8=N'), { ok: true, action: 'a7a8n' });
});

test('parseAction: check marks and wrapping quotes are tolerated', () => {
  const state = stateFromFen(PERFT_FENS.start);
  assert.deepEqual(game.parseAction(state, 0, 'e4+'), { ok: true, action: 'e2e4' });
  assert.deepEqual(game.parseAction(state, 0, '"e2e4"'), { ok: true, action: 'e2e4' });
  assert.deepEqual(game.parseAction(state, 0, '`Nf3`'), { ok: true, action: 'g1f3' });
  assert.deepEqual(game.parseAction(state, 0, "'Nf3'"), { ok: true, action: 'g1f3' });
  assert.deepEqual(game.parseAction(state, 0, 'move e2e4'), { ok: true, action: 'e2e4' });
});

test('parseAction: invalid inputs return a diagnostic error', () => {
  const state = stateFromFen(PERFT_FENS.start);
  for (const text of ['', 'xyz', 'z9z9', 'king takes queen']) {
    const parsed = game.parseAction(state, 0, text);
    assert.equal(parsed.ok, false, `expected rejection of ${JSON.stringify(text)}`);
    assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
  }
  // Well-formed UCI that is not legal here.
  const illegal = game.parseAction(state, 0, 'e2e5');
  assert.equal(illegal.ok, false);
  assert.ok(String(illegal.error).includes('not legal'));
});

test('turn enforcement: wrong-seat step throws, wrong-seat parse fails', () => {
  const state = stateFromFen(PERFT_FENS.start);
  assert.throws(() => game.step(state, 1, 'e7e5'), (err) => err instanceof Error && /turn/.test(err.message));
  const parsed = game.parseAction(state, 1, 'e7e5');
  assert.equal(parsed.ok, false);
  // A finished game refuses both step and parse.
  const mate = stateFromFen('R5k1/5ppp/8/8/8/8/8/7K b - - 0 1');
  assert.throws(() => game.step(mate, 1, 'a8a7'));
  assert.equal(game.parseAction(mate, 1, 'a8a7').ok, false);
});

test('checkmate adjudication from a crafted FEN', () => {
  const state = stateFromFen('R5k1/5ppp/8/8/8/8/8/7K b - - 0 1');
  assert.deepEqual(state.termination, { type: 'checkmate', winner: 'w' });
  assert.equal(game.toAct(state), null);
  const outcome = /** @type {NonNullable<ReturnType<typeof game.outcome>>} */ (game.outcome(state));
  assert.deepEqual(outcome.normalized, [1, 0]);
  assert.deepEqual(outcome.raw, ['win', 'loss']);
  assert.equal(outcome.reason, 'white wins by checkmate');
});

test('stalemate adjudication from a crafted FEN', () => {
  const state = stateFromFen('7k/5Q2/8/8/8/8/8/K7 b - - 0 1');
  assert.deepEqual(state.termination, { type: 'stalemate', winner: null });
  const outcome = /** @type {NonNullable<ReturnType<typeof game.outcome>>} */ (game.outcome(state));
  assert.deepEqual(outcome.normalized, [0.5, 0.5]);
  assert.deepEqual(outcome.raw, ['draw', 'draw']);
  assert.equal(outcome.reason, 'draw by stalemate');
});

test('fifty-move adjudication from a crafted FEN', () => {
  // One quiet move from a 99 halfmove clock reaches 100.
  const state = stateFromFen('7k/8/8/8/8/8/R7/K7 w - - 99 60');
  assert.equal(state.termination, null);
  const stepped = game.step(state, 0, 'a1b1');
  assert.deepEqual(stepped.termination, { type: 'fifty', winner: null });
  const outcome = /** @type {NonNullable<ReturnType<typeof game.outcome>>} */ (game.outcome(stepped));
  assert.equal(outcome.reason, 'draw by fifty-move rule');
  // A FEN already at the limit is terminal on arrival.
  const done = stateFromFen('7k/8/8/8/8/8/R7/K7 w - - 100 60');
  assert.deepEqual(done.termination, { type: 'fifty', winner: null });
});

test('insufficient-material adjudication from a crafted FEN', () => {
  const state = stateFromFen('8/8/8/8/8/8/4k3/4KB2 w - - 0 1');
  assert.deepEqual(state.termination, { type: 'material', winner: null });
  const outcome = /** @type {NonNullable<ReturnType<typeof game.outcome>>} */ (game.outcome(state));
  assert.deepEqual(outcome.normalized, [0.5, 0.5]);
  assert.equal(outcome.reason, 'draw by insufficient material');
});

test('threefold repetition through the environment: king shuffles', () => {
  // Knight per side so insufficient material cannot fire first; kings on
  // d1/d8 shuffle around the start position until its third occurrence.
  let state = stateFromFen('n2k4/8/8/8/8/8/8/3K1N2 w - - 0 1');
  const shuffles = ['d1c1', 'd8c8', 'c1d1', 'c8d8', 'd1c1', 'd8c8', 'c1d1', 'c8d8'];
  for (let i = 0; i < shuffles.length; i++) {
    const seat = /** @type {number} */ (game.toAct(state));
    state = game.step(state, seat, shuffles[i]);
    if (i < shuffles.length - 1) {
      assert.equal(state.termination, null, `no termination before the third occurrence (ply ${i + 1})`);
    }
  }
  assert.deepEqual(state.termination, { type: 'threefold', winner: null });
  const outcome = /** @type {NonNullable<ReturnType<typeof game.outcome>>} */ (game.outcome(state));
  assert.equal(outcome.reason, 'draw by threefold repetition');
  assert.deepEqual(outcome.normalized, [0.5, 0.5]);
});

test('observation rendering: labelled board, side to move, opening, legal list', () => {
  const state = game.reset(PAPER, 'render-seed');
  const seat = /** @type {number} */ (game.toAct(state));
  const observation = game.observe(state, seat);
  assert.ok(typeof observation.text === 'string' && observation.text.length > 0);
  const lines = observation.text.split('\n');
  assert.ok(lines.includes('    a b c d e f g h'), 'file header must be present');
  assert.ok(lines.some((line) => line.startsWith('8 |')), 'rank 8 label must be present');
  assert.ok(lines.some((line) => line.startsWith('1 |')), 'rank 1 label must be present');
  assert.ok(observation.text.includes('Side to move:'));
  assert.ok(observation.text.includes(`seat ${seat}`));
  assert.ok(observation.text.includes(`Opening: ${state.openingName}`));
  const legal = game.legalActions(state, seat);
  assert.ok(legal.length > 0 && legal.length <= 64);
  for (const action of legal) {
    assert.ok(observation.text.includes(action), `legal action ${action} must be listed`);
  }
  // JSON-safe payload carrying the full state plus the seat.
  assert.deepEqual(JSON.parse(JSON.stringify(observation.data)).moves, state.moves);
});

test('truncation adjudication: quiescence bands at the 500cp threshold', () => {
  assert.equal(TRUNCATION_WIN_CP, 500);
  // Queen up, no captures available: well above the threshold.
  const winning = stateFromFen('k7/8/8/8/8/7q/8/K7 w - - 0 1');
  const winScore = quiescenceWhite(stateToChess(winning), { nodeBudget: 20000 });
  assert.ok(winScore <= -TRUNCATION_WIN_CP, `black should lead by ${winScore}cp`);
  const winOutcome = game.truncate(winning);
  assert.deepEqual(winOutcome.normalized, [0, 1]);
  assert.deepEqual(winOutcome.raw, null);
  assert.ok(winOutcome.reason.includes('truncated'));
  // White queen up.
  const whiteWinning = stateFromFen('7k/8/8/8/8/8/6Q1/7K w - - 0 1');
  assert.ok(quiescenceWhite(stateToChess(whiteWinning), { nodeBudget: 20000 }) >= TRUNCATION_WIN_CP);
  assert.deepEqual(game.truncate(whiteWinning).normalized, [1, 0]);
  // Pawn up only: inside the draw band.
  const drawish = stateFromFen('6k1/8/8/8/8/8/6P1/6K1 w - - 0 1');
  const drawScore = quiescenceWhite(stateToChess(drawish), { nodeBudget: 20000 });
  assert.ok(
    drawScore > -TRUNCATION_WIN_CP && drawScore < TRUNCATION_WIN_CP,
    `pawn-up endgame should sit inside the draw band, got ${drawScore}cp`
  );
  const drawOutcome = game.truncate(drawish);
  assert.deepEqual(drawOutcome.normalized, [0.5, 0.5]);
  assert.deepEqual(drawOutcome.raw, null);
});

test('engine: deterministic, legal, and finds the unique mate in one', () => {
  const state = stateFromFen('6k1/8/6P1/8/8/5Q2/6P1/6KR w - - 0 1');
  const position = stateToChess(state);
  const first = bestMove(position, { depth: 3, nodeBudget: 20000 }, rngFromSeed('engine-probe'));
  assert.equal(first.uci, 'f3f7', `engine should find Qf7#, got ${first.uci}`);
  assert.equal(first.score, 999999, 'mate in one scores the full 999999');
  const positionAgain = stateToChess(state);
  const second = bestMove(positionAgain, { depth: 3, nodeBudget: 20000 }, rngFromSeed('engine-probe'));
  assert.deepEqual(first, second, 'same seed must give the same result');
  assert.ok(game.legalActions(state, 0).includes(first.uci), 'engine move must be legal');
  // The stepped state is checkmate.
  const after = game.step(state, 0, first.uci);
  assert.deepEqual(after.termination, { type: 'checkmate', winner: 'w' });
});

test('step() does not mutate its input state and caches agree with replays', () => {
  // The per-state caches must behave exactly like fresh replays: a state
  // stepped twice gives identical children, and the parent state still
  // replays to its own position after its child was built.
  let state = game.reset(PAPER, 'cache-consistency-seed');
  const before = JSON.stringify(state);
  const seat = /** @type {number} */ (game.toAct(state));
  const childA = game.step(state, seat, game.legalActions(state, seat)[0]);
  const childB = game.step(state, seat, game.legalActions(state, seat)[0]);
  assert.deepEqual(childA, childB, 'stepping the same state twice must give identical children');
  assert.equal(JSON.stringify(state), before, 'step must not mutate the parent state');
  const replayed = replayUci(state.startFen, state.moves).fen();
  assert.equal(replayed, state.fen, 'parent position must still match a fresh replay');
});

test('baselines complete episodes with zero invalid actions', async () => {
  const seed = 'baseline-e2e-seed';
  const seatAgent = game.agentSeat(PAPER, seed);
  const opponent = game.opponent(PAPER, seed, seatAgent === 0 ? 1 : 0);
  const greedy = createGreedyBaselineAgent({ id: 'greedy-e2e', episodeSeed: seed });
  let state = game.reset(PAPER, seed);
  let agentActions = 0;
  for (let ply = 0; ply < 2 * PAPER.maxActions; ply++) {
    const seat = game.toAct(state);
    if (seat === null) break;
    if (seat === seatAgent) {
      agentActions++;
      if (agentActions > PAPER.maxActions) break;
    }
    const agent = seat === seatAgent ? greedy : opponent;
    const legal = game.legalActions(state, seat);
    const observation = game.observe(state, seat);
    const context = /** @type {import('../../core/types.js').TurnContext} */ (
      { observation, legalActions: legal, turn: ply }
    );
    const result = await agent.act(context);
    assert.ok(
      legal.includes(result.text),
      `agent ${agent.id} played invalid ${result.text}`
    );
    state = game.step(state, seat, result.text);
  }
  // The episode must have actually played out, not stopped after one ply.
  assert.ok(agentActions >= 2, `episode ended after only ${agentActions} agent actions`);
});

test('conformance kit passes across the tiers', async () => {
  // The kit replays history per ply, so the full four-tier run is expensive:
  // by default only the paper tier runs (1 seed); GAUNTLET_SLOW=1 runs all
  // four tiers with the full seed budget.
  const target = SLOW ? game : { ...game, spec: { ...game.spec, tiers: [PAPER] } };
  const report = await runConformance(target, { seedsPerTier: SLOW ? 3 : 1 });
  assert.equal(report.ok, true);
  assert.equal(report.game, 'chess');
  assert.ok(report.checks > 0);
});

test('truncation referee: a mover capture crossing the win band stays in the draw band', () => {
  // Black to move can win the hanging white queen with Nxd4, so the honest
  // quiescence value is about -320 for white: inside the draw band. A root
  // that maximizes from white's perspective over black's options instead
  // returns white's best case (+575) and flips a draw to a white win.
  const blackToMove = new Chess('4k3/8/2n5/8/3Q4/8/8/4K3 b - - 0 1');
  const score = quiescenceWhite(blackToMove, {
    nodeBudget: 20000,
    quiescenceMaxPlies: 10,
  });
  assert.ok(
    Math.abs(score) < TRUNCATION_WIN_CP,
    `black-to-move hanging-queen quiescence must stay inside the draw band, got ${score}`
  );
  // Control: white to move, Rxd8 Kxd8 is a dead-equal capture chain.
  const whiteToMove = new Chess('3qk3/8/8/8/8/8/3R4/4K3 w - - 0 1');
  assert.equal(
    quiescenceWhite(whiteToMove, { nodeBudget: 20000, quiescenceMaxPlies: 10 }),
    0,
    'dead-equal white-to-move capture chain must quiesce to 0'
  );
});

test('evaluation symmetry: the start position evaluates to 0 and mirrored FENs cancel', () => {
  // Mirrors a FEN across the horizontal axis with colours swapped, so
  // evaluateWhite(mirror(fen)) === -evaluateWhite(fen) iff the evaluation is
  // colour-symmetric. A king table picked from partially accumulated material
  // breaks this (the black king is scanned first and misread the phase).
  /** @param {string} fen @returns {string} */
  const mirrorFen = (fen) => {
    const [board, side, castling, ep, half, full] = fen.split(' ');
    /** @param {string} s @returns {string} */
    const swapCase = (s) =>
      s.replace(/[A-Za-z]/g, (ch) => (ch >= 'a' ? ch.toUpperCase() : ch.toLowerCase()));
    const flipped = board
      .split('/')
      .reverse()
      .map((rank) => swapCase(rank))
      .join('/');
    const rights = castling === '-' ? '' : swapCase(castling);
    const mirroredCastling = ['K', 'Q', 'k', 'q'].filter((c) => rights.includes(c)).join('') || '-';
    const mirroredEp = ep === '-' ? '-' : swapCase(ep);
    return [flipped, side === 'w' ? 'b' : 'w', mirroredCastling, mirroredEp, half, full].join(' ');
  };
  assert.equal(evaluateWhite(new Chess(START_FEN)), 0, 'the mirrored start position must evaluate to 0');
  const positions = [
    START_FEN,
    PERFT_FENS.kiwipete,
    'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
  ];
  for (const fen of positions) {
    const mirrored = evaluateWhite(new Chess(mirrorFen(fen)));
    const original = evaluateWhite(new Chess(fen));
    // -0 and 0 compare unequal under Object.is; cancellation means the sum
    // of the two signed evaluations is zero.
    assert.equal(mirrored + original, 0, `mirrored FEN must cancel for ${fen}`);
  }
});

test('opening book: every named line is legal from the start position', () => {
  assert.ok(OPENINGS.length > 0, 'the opening book must not be empty');
  for (const opening of OPENINGS) {
    const line = new Chess();
    for (const san of opening.san) {
      const move = line.move(san);
      assert.ok(move, `opening "${opening.name}": ${san} is illegal`);
    }
  }
});

