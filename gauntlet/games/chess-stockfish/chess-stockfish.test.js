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
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
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
const GAUNTLET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_ENTRY = path.join(GAUNTLET_ROOT, 'cli', 'gauntlet.js');

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
 * A copy of a reply with wall-clock meta removed: the search itself is a
 * deterministic function of (binary, position, options, budget), but its
 * speed — nps — is not, so it never belongs in a same-seed comparison.
 *
 * @param {*} reply
 */
function deterministicReply(reply) {
  if (!reply || typeof reply !== 'object' || !reply.meta) return reply;
  const meta = { ...reply.meta };
  delete meta.nps;
  return { ...reply, meta };
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
      reply: deterministicReply(step.reply),
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
  assert.equal(spec.tiers.length, 5);
  assert.deepEqual(
    spec.tiers.map((tier) => tier.id),
    ['sf-1k', 'sf-10k', 'sf-100k', 'sf-1m', 'sf-250']
  );
  assert.deepEqual(
    spec.tiers.map((tier) => tier.params.nodes),
    [1_000, 10_000, 100_000, 1_000_000, 250]
  );
  assert.deepEqual(
    spec.tiers.map((tier) => tier.rank),
    [2, 3, 4, 5, 1]
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
        assert.equal(reply.meta.binaryPath, FIXTURE);
        assert.equal(reply.meta.nps, 60_000, 'nps comes from the last info line');
        assert.deepEqual(reply.meta.score, { cp: 41 });
        assert.deepEqual(reply.meta.options, {
          Threads: 1,
          Hash: 16,
          MultiPV: 1,
          Contempt: 0,
        });
      } finally {
        await opponent.dispose();
      }
    }
  } finally {
    if (previous === undefined) delete process.env[STOCKFISH_ENV_VAR];
    else process.env[STOCKFISH_ENV_VAR] = previous;
  }
});

test('wiring: the opponent pins exactly the documented setoption lines', async () => {
  const previous = process.env[STOCKFISH_ENV_VAR];
  process.env[STOCKFISH_ENV_VAR] = FIXTURE;
  const record = path.join(
    tmpdir(),
    `gauntlet-setoptions-${process.pid}-${Date.now()}.log`
  );
  const opponent = createStockfishOpponentAgent({
    tier: /** @type {TierSpec} */ (chessStockfish.spec.tiers[0]),
    engineArgs: [`--record=${record}`],
    idleTimeoutMs: 1_000,
  });
  try {
    await opponent.act(/** @type {never} */ ({
      observation: { data: { startFen: 'x', moves: [], fen: 'x' } },
      seat: 1,
    }));
    const lines = readFileSync(record, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('setoption'));
    // Exactly the documented configuration, in order — nothing else, even
    // though real binaries advertise more (and newer ones fewer).
    assert.deepEqual(lines, [
      'setoption name Threads value 1',
      'setoption name Hash value 16',
      'setoption name MultiPV value 1',
      'setoption name Contempt value 0',
    ]);
  } finally {
    await opponent.dispose();
    rmSync(record, { force: true });
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

test('wiring: a GAUNTLET_STOCKFISH pointing nowhere surfaces a precise error', async () => {
  const opponent = createStockfishOpponentAgent({
    tier: /** @type {TierSpec} */ (chessStockfish.spec.tiers[0]),
    enginePath: undefined,
  });
  const previous = process.env[STOCKFISH_ENV_VAR];
  process.env[STOCKFISH_ENV_VAR] = '/nonexistent/stockfish-nope';
  try {
    // Discovery must refuse the override itself — name it and its value —
    // without falling through to PATH or spawning anything.
    await assert.rejects(opponent.act(/** @type {never} */ ({
      observation: { data: { startFen: 'x', moves: [], fen: 'x' } },
    })), /GAUNTLET_STOCKFISH is set to "\/nonexistent\/stockfish-nope" but that file does not exist/);
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
  assert.match(/** @type {string} */ (meta.engine), /^Stockfish /);
  assert.equal(meta.binaryPath, /** @type {string} */ (REAL_BINARY));
  assert.equal(meta.nodesBudget, 1_000);
  assert.equal(typeof meta.depth, 'number');
  assert.equal(typeof meta.searchedNodes, 'number');
  assert.equal(typeof meta.nps, 'number');
  // From the startpos at 1k nodes the engine reports a centipawn or mate
  // score; keep the assertion shape-honest rather than pinning the value.
  assert.ok(
    meta.score === null ||
    typeof meta.score.cp === 'number' ||
    typeof meta.score.mate === 'number'
  );
  // The opponent sends exactly the pinned set intersected with what this
  // engine advertises — apt Stockfish 17.1 dropped Contempt — and never the
  // strength options. Threads and Hash are advertised by every supported
  // binary, so they are always present.
  const pinned = /** @type {Record<string, number>} */ ({ Threads: 1, Hash: 16, MultiPV: 1, Contempt: 0 });
  for (const [name, value] of Object.entries(meta.options)) {
    assert.ok(name in pinned, `unexpected option ${name} in ${JSON.stringify(meta.options)}`);
    assert.equal(value, pinned[name], `${name} must keep its pinned value`);
  }
  assert.ok(
    'Threads' in meta.options && 'Hash' in meta.options,
    `Threads and Hash must be pinned, got ${JSON.stringify(meta.options)}`
  );
  assert.ok(!('UCI_LimitStrength' in meta.options) && !('UCI_Elo' in meta.options));
  assert.match(reply.text, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
  await /** @type {any} */ (opponent).dispose();
});

test('real engine: a CLI play run exits promptly after its last episode', { skip: REAL_BINARY ? false : 'no engine binary found (set GAUNTLET_STOCKFISH or install stockfish)' }, async () => {
  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, 'play', '--game', 'chess-stockfish', '--tier', 'sf-250', '--agent', 'random'],
    {
      cwd: GAUNTLET_ROOT,
      env: { ...process.env, [STOCKFISH_ENV_VAR]: /** @type {string} */ (REAL_BINARY) },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  /** @type {string[]} */
  const stderr = [];
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => stderr.push(/** @type {string} */ (chunk)));
  const [code, signal] = /** @type {[number | null, string | null]} */ (
    await once(child, 'close')
  );
  const elapsedMs = Date.now() - startedAt;
  assert.equal(signal, null, `the CLI run was killed by ${signal}: ${stderr.join('')}`);
  assert.equal(code, 0, `the CLI run exited ${code}: ${stderr.join('')}`);
  // The engine quits inside runEpisode's finally, so the CLI drains within
  // seconds of its last episode; a leaked engine parks the process until the
  // client's 60 s idle reap instead.
  assert.ok(
    elapsedMs < 30_000,
    `the CLI run took ${(elapsedMs / 1000).toFixed(1)}s — an engine child outlived the last episode`
  );
});
