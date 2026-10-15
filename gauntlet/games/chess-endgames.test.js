import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineAgent, greedyAgent } from './chess-endgames/baselines.js';
import { probe, tableMaxDTM } from './chess-endgames/tablebase.js';
import { runConformance } from '../core/conformance.js';
import { runEpisode } from '../core/runner.js';
import { publicSeed } from '../core/seeds.js';
import { GauntletRuleError } from '../core/errors.js';
import { getGame } from '../games/index.js';
import { Chess } from 'chess.js';

const game = getGame('chess-endgames');

test('the registered game exposes the four conversion tiers', () => {
  assert.equal(game.spec.id, 'chess-endgames');
  assert.equal(game.spec.seats, 2);
  assert.equal(game.spec.benchmark, true);
  assert.deepEqual(
    game.spec.tiers.map((t) => t.id),
    ['kqk', 'krk', 'kbbk', 'kbnk'],
  );
  assert.deepEqual(game.spec.tiers.map((t) => t.publicSeeds), [10, 10, 10, 10]);
  for (const tier of game.spec.tiers) {
    assert.equal(tier.scoring, 'outcome');
    assert.equal(tier.params.bandMin < tier.params.bandMax, true);
  }
});

test('table maxima match the published DTM values', () => {
  assert.equal(tableMaxDTM('kqk'), 10);
  assert.equal(tableMaxDTM('krk'), 16);
  assert.equal(tableMaxDTM('kbbk'), 19);
  assert.equal(tableMaxDTM('kbnk'), 33);
});

test('table spot values: corner KQK mate in 6, stalemate draws, mate-in-one', () => {
  assert.deepEqual(probe('kqk', '7k/8/8/8/8/8/8/K5Q1 w - - 0 1'), { dtm: 6, draw: false });
  assert.deepEqual(probe('kqk', 'k7/2Q5/8/8/8/8/8/K7 b - - 0 1'), { dtm: null, draw: true });
  // Black to move one move before a forced mate: DTM 1.
  assert.deepEqual(probe('krk', 'k7/8/1K6/8/8/8/8/6R1 b - - 0 1'), { dtm: 1, draw: false });
  // Black to move and already mated: DTM 0.
  assert.deepEqual(probe('krk', 'R6k/8/7K/8/8/8/8/8 b - - 0 1'), { dtm: 0, draw: false });
});

test('reset is deterministic and in band for every tier', () => {
  for (const tier of game.spec.tiers) {
    for (let i = 0; i < 3; i++) {
      const seed = publicSeed(game.spec.id, tier.id, i);
      const a = game.reset(tier, seed);
      const b = game.reset(tier, seed);
      assert.deepEqual(a, b, `seed ${seed} must deal deterministically`);
      assert.equal(a.status, 'playing');
      assert.equal(a.fen.split(' ')[1], 'w', 'White (the agent) moves first');
      const value = probe(a.eg, a.fen);
      assert.equal(value.draw, false, `seed ${seed} must be a won position`);
      assert.equal(value.dtm !== null, true);
      assert.equal(
        /** @type {number} */ (value.dtm) >= /** @type {number} */ (tier.params.bandMin) &&
          /** @type {number} */ (value.dtm) <= /** @type {number} */ (tier.params.bandMax),
        true,
        `seed ${seed} DTM ${value.dtm} must fall in [${tier.params.bandMin}, ${tier.params.bandMax}]`,
      );
      assert.equal(a.startDtm, value.dtm);
    }
  }
});

test('legalActions come from chess.js and the wrong-turn seat has none', () => {
  const tier = game.spec.tiers[0];
  const state = game.reset(tier, 'legal-seed');
  const legal = game.legalActions(state, 0);
  assert.ok(legal.length > 0);
  assert.ok(legal.every((u) => /^[a-h][1-8][a-h][1-8]$/.test(u)));
  assert.deepEqual([...legal], [...legal].sort(), 'legal actions are sorted');
  assert.deepEqual(game.legalActions(state, 1), [], 'the non-acting seat has no actions');
});

test('parseAction accepts UCI and documented alternates, rejects garbage', () => {
  const tier = game.spec.tiers[0];
  const state = game.reset(tier, 'parse-seed');
  const [first] = game.legalActions(state, 0);
  const from = first.slice(0, 2);
  const to = first.slice(2, 4);
  for (const [text, expected] of /** @type {[string, string | null][]} */ ([
    [first, first],
    [`${from}${to}`, first],
    [`${from}-${to}`, first],
    [`move ${from}${to}`, first],
    ['`e2e4`', null],
    ['z9z9', null],
    ['e2', null],
    ['Qxa7', null],
    ['', null],
  ])) {
    const parsed = game.parseAction(state, 0, text);
    if (expected === null && text === '`e2e4`') {
      // e2e4 may or may not be legal depending on the dealt position; either a
      // parse or a legality rejection is acceptable, garbage must still fail.
      if (parsed.ok) assert.equal(parsed.action, 'e2e4');
      else assert.equal(typeof parsed.error, 'string');
    } else if (expected === null) {
      assert.equal(parsed.ok, false, `input ${JSON.stringify(text)} must not parse`);
      assert.equal(typeof parsed.error, 'string');
    } else {
      assert.deepEqual(parsed, { ok: true, action: expected }, `input ${JSON.stringify(text)}`);
    }
  }
  const moved = game.step(state, 0, first);
  assert.equal(game.parseAction(moved, 0, first).ok, false, 'wrong turn after White moved');
});

test('step throws GauntletRuleError outside legalActions and is pure', () => {
  const tier = game.spec.tiers[0];
  const state = game.reset(tier, 'step-seed');
  const before = JSON.parse(JSON.stringify(state));
  for (const bad of ['e2e4!', '__nope__', 'a0a1', /** @type {*} */ (42)]) {
    assert.throws(() => game.step(state, 0, bad), GauntletRuleError);
  }
  assert.deepEqual(state, before, 'step must not mutate its input');
  // The defender seat cannot play on the agent's turn.
  const [first] = game.legalActions(state, 0);
  assert.throws(() => game.step(state, 1, first), GauntletRuleError);
});

test('observation renders the board, budget, and every legal action', () => {
  const tier = game.spec.tiers[0];
  const state = game.reset(tier, 'observe-seed');
  const observation = game.observe(state, 0);
  assert.match(observation.text, /You are seat 0 \(White/);
  assert.match(observation.text, /mate in \d+ White moves/);
  assert.match(observation.text, /Actions used: 0 of at most \d+\./);
  for (const uci of game.legalActions(state, 0)) {
    assert.ok(observation.text.includes(uci), `missing ${uci}`);
  }
  assert.deepEqual(observation.data.legal, game.legalActions(state, 0));
  assert.equal(observation.data.you, 0);
});

test('outcome scores conversion efficiency and failures as zero', () => {
  // A conversion in exactly the optimal number of moves scores 1.0.
  const converted = {
    eg: 'kqk',
    fen: 'k7/8/1K6/8/8/8/8/6Q1 w - - 0 1',
    startDtm: 5,
    whiteMoves: 5,
    status: 'mated',
  };
  const win = /** @type {import('../core/types.js').Outcome} */ (game.outcome(converted));
  assert.deepEqual(win.normalized, [1, 0]);
  assert.deepEqual(win.raw, ['win', 'loss']);
  // Doubling the conversion length squares the ratio: (5/10)^2 = 0.25.
  const slow = { ...converted, whiteMoves: 10 };
  const slowWin = /** @type {import('../core/types.js').Outcome} */ (game.outcome(slow));
  assert.ok(Math.abs(slowWin.normalized[0] - 0.25) < 1e-12);
  // Failures score zero for the agent.
  const stalemated = /** @type {import('../core/types.js').Outcome} */ (
    game.outcome({ ...converted, status: 'stalemate', whiteMoves: 9 })
  );
  assert.deepEqual(stalemated.normalized, [0, 1]);
  assert.equal(game.outcome(game.reset(game.spec.tiers[0], 'live-seed')), null);
});

test('truncate() scores a live position by its remaining perfect-play minimum', () => {
  const tier = game.spec.tiers[0];
  const state = game.reset(tier, 'truncate-seed');
  const value = /** @type {{ dtm: number }} */ (probe(state.eg, state.fen));
  const assessment = game.truncate(state);
  assert.equal(assessment.raw, null);
  // No moves made and converting perfectly from here: score = (D/D)^2 = 1.
  assert.deepEqual(assessment.normalized, [1, 0]);
  assert.match(assessment.reason, new RegExp(`mates in ${value.dtm}`));
});

test('the perfect defender resists longest, preferring drawn children', async () => {
  const tier = game.spec.tiers[0];
  const state = game.reset(tier, 'defender-seed');
  const [first] = game.legalActions(state, 0);
  const afterWhite = game.step(state, 0, first);
  const opponent = /** @type {NonNullable<typeof game.opponent>} */ (game.opponent)(
    tier,
    'defender-seed',
    1,
  );
  const reply = await opponent.act(
    /** @type {import('../core/types.js').TurnContext} */ (
      /** @type {*} */ ({ observation: game.observe(afterWhite, 1), turn: 0 })
    ),
  );
  const chosen = /** @type {string} */ (reply.text);
  // Rank every defender reply: a draw is best for Black (rank 0), else the
  // longest resistance is the largest child DTM.
  const chess = new Chess(afterWhite.fen);
  let bestRank = -1;
  for (const m of chess.moves({ verbose: true })) {
    const child = new Chess(afterWhite.fen);
    child.move({ from: m.from, to: m.to });
    const v = probe(afterWhite.eg, child.fen());
    const rank = v.draw ? 0 : /** @type {number} */ (v.dtm) + 1;
    if (rank > bestRank) bestRank = rank;
  }
  const child = new Chess(afterWhite.fen);
  child.move({ from: chosen.slice(0, 2), to: chosen.slice(2, 4) });
  const v = probe(afterWhite.eg, child.fen());
  const chosenRank = v.draw ? 0 : /** @type {number} */ (v.dtm) + 1;
  assert.equal(chosenRank, bestRank, 'the defender must play a maximally resisting move');
});

test('the engine baseline converts every tier at exactly 1.0 in optimal moves', async () => {
  for (const tier of game.spec.tiers) {
    for (let i = 0; i < 2; i++) {
      const seed = publicSeed(game.spec.id, tier.id, i);
      const trajectory = await runEpisode({
        game,
        tierId: tier.id,
        seed,
        agent: engineAgent(tier, seed, 0),
      });
      const outcome = /** @type {import('../core/types.js').Outcome} */ (trajectory.end.outcome);
      assert.equal(outcome.normalized[0], 1, `engine must score 1.0 on ${seed}`);
      const match = /checkmate on move (\d+) against perfect defense \(optimal was (\d+)\)/.exec(
        outcome.reason,
      );
      assert.ok(match, `outcome reason must name the move count on ${seed}: ${outcome.reason}`);
      assert.equal(
        match[1],
        match[2],
        `engine must convert in exactly the DTM on ${seed}`,
      );
    }
  }
});

test('the greedy baseline plays legally and never outscores the engine', async () => {
  const tier = game.spec.tiers[0];
  const seed = publicSeed(game.spec.id, tier.id, 0);
  const trajectory = await runEpisode({
    game,
    tierId: tier.id,
    seed,
    agent: greedyAgent(tier, seed, 0),
  });
  const outcome = /** @type {import('../core/types.js').Outcome} */ (trajectory.end.outcome);
  assert.ok(outcome.normalized[0] <= 1, 'greedy cannot exceed the perfect score');
  assert.ok(outcome.normalized[0] >= 0);
});

test('the full conformance kit passes for chess endgames', async () => {
  const report = await runConformance(game);
  assert.equal(report.ok, true);
  assert.ok(report.checks > 50, `expected a substantial check count, got ${report.checks}`);
});
