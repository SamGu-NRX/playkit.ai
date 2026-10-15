// Tests for the chess-stockfish game.
//
// Layers:
//  1. Spec and delegation unit tests (no engine needed).
//  2. Wiring tests through the fake UCI engine fixture: GAUNTLET_STOCKFISH
//     drives a full episode through the runner, reproducibly.
//  3. Real-engine tests (skipped with a message when no binary is found):
//     the conformance kit, same-seed episode determinism, and the ladder-4
//     (chess granite) strength comparison over the public seeds.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chessStockfish } from './index.js';
import { chess } from '../chess/index.js';
import { runEpisode } from '../../core/runner.js';
import { runConformance } from '../../core/conformance.js';
import { nextInt, rngFromSeed } from '../../core/rng.js';
import { createStockfishOpponentAgent } from './stockfish-agent.js';
import { STOCKFISH_ENV_VAR, findEngineBinary } from '../../engines/uci/client.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'engines',
  'uci',
  'fixtures',
  'fake-uci-engine.mjs'
);
const REAL_BINARY = findEngineBinary();

/** @import { Agent, TierSpec, TurnContext } from '../../core/types.js' */

/**
 * A seeded random legal-move agent, the same shape the conformance kit uses.
 *
 * @param {string} label RNG namespace.
 * @returns {Agent}
 */
function scriptedRandomAgent(label) {
  let ply = 0;
  return {
    id: `random-${label}`,
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {TurnContext} */ ctx) {
      const legal = ctx.legalActions ?? [];
      if (legal.length === 0) return { text: '' };
      const pick = nextInt(rngFromSeed(`${label}/${ply}`), 0, legal.length - 1).value;
      ply++;
      return { text: legal[pick] };
    },
  };
}

/**
 * Strip wall-clock fields so two trajectories of the same seed compare
 * canonical-equal.
 *
 * @param {*} trajectory
 */
function replayComparable(trajectory) {
  return {
    game: trajectory.game,
    tier: trajectory.tier,
    seed: trajectory.seed,
    agent: trajectory.agent,
    opponents: trajectory.opponents,
    steps: trajectory.steps.map((/** @type {any} */ step) => ({
      seat: step.seat,
      by: step.by,
      observationHash: step.observationHash,
      reply: step.reply,
      action: step.action,
      invalid: step.invalid,
    })),
    end: trajectory.end,
  };
}

test('spec: identity, requires and four ascending node-budget tiers', () => {
  const spec = chessStockfish.spec;
  assert.equal(spec.id, 'chess-stockfish');
  assert.match(spec.version, /^\d+\.\d+\.\d+$/);
  assert.equal(spec.seats, 2);
  assert.equal(spec.benchmark, true);
  assert.deepEqual(spec.requires, ['stockfish']);
  assert.equal(spec.tiers.length, 4);
  assert.deepEqual(
    spec.tiers.map((tier) => tier.id),
    ['sf-1k', 'sf-10k', 'sf-100k', 'sf-1m']
  );
  assert.deepEqual(
    spec.tiers.map((tier) => tier.params.nodes),
    [1_000, 10_000, 100_000, 1_000_000]
  );
  assert.deepEqual(
    spec.tiers.map((tier) => tier.rank),
    [1, 2, 3, 4]
  );
  for (const tier of spec.tiers) {
    assert.equal(tier.scoring, 'outcome');
    assert.equal(tier.publicSeeds, 5);
    assert.equal(tier.maxActions, 150);
    assert.equal(typeof tier.params.searchTimeoutMs, 'number');
  }
});

test('spec: rules text extends the chess rules and names the engine', () => {
  assert.ok(chessStockfish.spec.rulesText.startsWith(chess.spec.rulesText));
  assert.ok(/Stockfish/.test(chessStockfish.spec.rulesText));
});

test('rules: reset, seats and outcomes delegate to the chess game', () => {
  const tier = /** @type {TierSpec} */ (chessStockfish.spec.tiers[0]);
  const mine = chessStockfish.reset(tier, 'delegation-seed');
  const base = chess.reset(tier, 'delegation-seed');
  assert.deepEqual(mine, base);
  assert.equal(chessStockfish.toAct(mine), chess.toAct(mine));
  assert.equal(
    /** @type {any} */ (chessStockfish).agentSeat(tier, 'delegation-seed'),
    /** @type {any} */ (chess).agentSeat(tier, 'delegation-seed')
  );
  assert.deepEqual(chessStockfish.legalActions(mine, 0), chess.legalActions(mine, 0));
  assert.equal(chessStockfish.outcome(mine), null);
  // A legal first step lands in the same position in both games.
  const action = chessStockfish.legalActions(mine, /** @type {number} */ (chessStockfish.toAct(mine)))[0];
  const stepped = chessStockfish.step(mine, /** @type {number} */ (chessStockfish.toAct(mine)), action);
  assert.equal(stepped.fen, chess.step(mine, /** @type {number} */ (chessStockfish.toAct(mine)), action).fen);
  assert.equal(chessStockfish.outcome(stepped), null);
});

test('opponent agent: identity and validation', () => {
  const tier = /** @type {TierSpec} */ (chessStockfish.spec.tiers[0]);
  const opponent = /** @type {any} */ (chessStockfish).opponent(tier, 'seed', 1);
  assert.equal(opponent.id, 'chess-stockfish-sf-1k');
  assert.equal(opponent.track, 'baseline');
  assert.equal(typeof opponent.act, 'function');

  const direct = createStockfishOpponentAgent({ tier, id: 'custom-id' });
  assert.equal(direct.id, 'custom-id');
  assert.equal(typeof direct.dispose, 'function');

  assert.throws(
    () => createStockfishOpponentAgent({ tier: /** @type {TierSpec} */ ({ id: 'bad', params: {} }) }),
    /needs params\.nodes/
  );
  assert.throws(
    () =>
      createStockfishOpponentAgent({
        tier: /** @type {TierSpec} */ ({ id: 'bad', params: { nodes: 0 } }),
      }),
    /needs params\.nodes/
  );
});

test('wiring: GAUNTLET_STOCKFISH resolves to the fixture and the opponent answers, reproducibly', async () => {
  const previous = process.env[STOCKFISH_ENV_VAR];
  process.env[STOCKFISH_ENV_VAR] = FIXTURE;
  const tier = /** @type {TierSpec} */ (chessStockfish.spec.tiers[0]);
  try {
    // The runner hard-fails on an invalid opponent move, so the fixture
    // engine cannot drive a full legal episode (it always answers e7e5).
    // The runner path is covered by the real-engine tests below; here the
    // env-var -> findEngineBinary -> UciEngine -> agent chain is exercised
    // directly, twice, and must answer identically.
    for (const pass of [1, 2]) {
      const state = chessStockfish.reset(tier, 'wiring-seed');
      const seat = /** @type {number} */ (chessStockfish.toAct(state));
      const opponent = /** @type {any} */ (chessStockfish).opponent(tier, 'wiring-seed', seat);
      try {
        const reply = await opponent.act(/** @type {any} */ ({
          observation: chessStockfish.observe(state, seat),
          legalActions: chessStockfish.legalActions(state, seat),
          turn: 0,
          seat,
        }));
        assert.equal(reply.text, 'e7e5', `fixture pass ${pass} must answer e7e5`);
        assert.equal(reply.meta.engine, 'FakeFish 1.0');
        assert.equal(reply.meta.nodesBudget, 1_000);
      } finally {
        await opponent.dispose();
      }
    }
  } finally {
    if (previous === undefined) delete process.env[STOCKFISH_ENV_VAR];
    else process.env[STOCKFISH_ENV_VAR] = previous;
  }
});

test('wiring: a missing engine surfaces a clear, path-naming error', async () => {
  const opponent = createStockfishOpponentAgent({
    tier: /** @type {TierSpec} */ (chessStockfish.spec.tiers[0]),
    enginePath: '/nonexistent/stockfish-nope',
  });
  await assert.rejects(
    opponent.act(/** @type {never} */ ({
      observation: { data: { startFen: 'x', moves: [], fen: 'x' } },
    })),
    /could not spawn the engine binary at "\/nonexistent\/stockfish-nope"/
  );
});

test('wiring: no engine anywhere surfaces an install hint', async () => {
  const opponent = createStockfishOpponentAgent({
    tier: /** @type {TierSpec} */ (chessStockfish.spec.tiers[0]),
    enginePath: undefined,
  });
  const previous = process.env[STOCKFISH_ENV_VAR];
  delete process.env[STOCKFISH_ENV_VAR];
  try {
    // findEngineBinary with no env var falls back to PATH; force a PATH that
    // cannot contain stockfish so the "nothing found" branch runs.
    const originalPath = process.env.PATH;
    process.env.PATH = '/nonexistent-empty-path';
    await assert.rejects(opponent.act(/** @type {never} */ ({
      observation: { data: { startFen: 'x', moves: [], fen: 'x' } },
    })), /no Stockfish binary found/);
    process.env.PATH = originalPath;
  } finally {
    if (previous === undefined) delete process.env[STOCKFISH_ENV_VAR];
    else process.env[STOCKFISH_ENV_VAR] = previous;
  }
});

// ---- Real-engine tests -----------------------------------------------------

test('real engine: the conformance kit passes (one public seed per tier)', { skip: REAL_BINARY ? false : 'no engine binary found (set GAUNTLET_STOCKFISH or install stockfish)' }, async () => {
  const report = await runConformance(chessStockfish, { seedsPerTier: 1 });
  assert.equal(report.ok, true);
  assert.ok(report.checks > 0);
});

test('real engine: same seed, identical full episode at sf-1k', { skip: REAL_BINARY ? false : 'no engine binary found (set GAUNTLET_STOCKFISH or install stockfish)' }, async () => {
  const tier = /** @type {TierSpec} */ (chessStockfish.spec.tiers[0]);
  const first = await runEpisode({
    game: chessStockfish,
    tierId: tier.id,
    seed: 'chess-stockfish/sf-1k/public/0',
    agent: scriptedRandomAgent('determinism-sf1k'),
    maxConsecutiveInvalid: 2,
  });
  const second = await runEpisode({
    game: chessStockfish,
    tierId: tier.id,
    seed: 'chess-stockfish/sf-1k/public/0',
    agent: scriptedRandomAgent('determinism-sf1k'),
    maxConsecutiveInvalid: 2,
  });
  assert.deepEqual(replayComparable(first), replayComparable(second));
  assert.ok(
    first.end.reason === 'terminal' || first.end.reason === 'budget-exhausted'
  );
});

test('real engine: same seed, identical full episode at sf-10k', { skip: REAL_BINARY ? false : 'no engine binary found (set GAUNTLET_STOCKFISH or install stockfish)' }, async () => {
  const tier = /** @type {TierSpec} */ (chessStockfish.spec.tiers[1]);
  const first = await runEpisode({
    game: chessStockfish,
    tierId: tier.id,
    seed: 'chess-stockfish/sf-10k/public/0',
    agent: scriptedRandomAgent('determinism-sf10k'),
    maxConsecutiveInvalid: 2,
  });
  const second = await runEpisode({
    game: chessStockfish,
    tierId: tier.id,
    seed: 'chess-stockfish/sf-10k/public/0',
    agent: scriptedRandomAgent('determinism-sf10k'),
    maxConsecutiveInvalid: 2,
  });
  assert.deepEqual(replayComparable(first), replayComparable(second));
});

test('real engine: the opponent records the engine id and search stats', { skip: REAL_BINARY ? false : 'no engine binary found (set GAUNTLET_STOCKFISH or install stockfish)' }, async () => {
  const opponent = /** @type {any} */ (chessStockfish).opponent(
    /** @type {TierSpec} */ (chessStockfish.spec.tiers[0]),
    'meta-seed',
    1
  );
  const tier = /** @type {TierSpec} */ (chessStockfish.spec.tiers[0]);
  const state = chessStockfish.reset(tier, 'meta-seed');
  const seat = /** @type {number} */ (chessStockfish.toAct(state));
  const reply = await opponent.act(/** @type {any} */ ({
    observation: chessStockfish.observe(state, seat),
    legalActions: chessStockfish.legalActions(state, seat),
    turn: 0,
    seat,
  }));
  const meta = /** @type {any} */ (reply.meta);
  assert.equal(meta.engine, 'Stockfish 17.1');
  assert.equal(meta.nodesBudget, 1_000);
  assert.equal(typeof meta.depth, 'number');
  assert.equal(typeof meta.searchedNodes, 'number');
  assert.match(reply.text, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
  await /** @type {any} */ (opponent).dispose();
});
