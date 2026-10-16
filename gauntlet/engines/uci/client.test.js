// UCI client protocol tests. The fake-engine cases run everywhere: they
// drive a Node fixture (fixtures/fake-uci-engine.mjs) through the handshake,
// searches, garbage output, crashes, and hangs. The real-engine cases skip
// with a message when no binary is found (GAUNTLET_STOCKFISH or PATH).

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_HASH_MB,
  STOCKFISH_ENV_VAR,
  UciEngine,
  engineIdSlug,
  findEngineBinary,
  parseBestmove,
  parseIdName,
  parseInfoLine,
  probeEngineIdSync,
} from './client.js';

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(FIXTURE_DIR, 'fixtures', 'fake-uci-engine.mjs');
const REAL_BINARY = findEngineBinary();

/**
 * A UciEngine over the fake fixture. Defaults keep the tests quick.
 *
 * @param {string[]} [fixtureArgs]
 * @param {{ commandTimeoutMs?: number, idleTimeoutMs?: number }} [options]
 * @returns {UciEngine}
 */
function fakeEngine(fixtureArgs = [], options = {}) {
  return new UciEngine({
    binaryPath: process.execPath,
    engineArgs: [FIXTURE, ...fixtureArgs],
    commandTimeoutMs: options.commandTimeoutMs ?? 5000,
    idleTimeoutMs: options.idleTimeoutMs ?? 2000,
  });
}

test('parseIdName extracts the id name line only', () => {
  assert.equal(parseIdName('id name Stockfish 17.1'), 'Stockfish 17.1');
  assert.equal(parseIdName('id author someone'), null);
  assert.equal(parseIdName('bestmove e2e4'), null);
});

test('parseBestmove reads bestmove and optional ponder', () => {
  assert.deepEqual(parseBestmove('bestmove e2e4 ponder e7e5'), {
    bestmove: 'e2e4',
    ponder: 'e7e5',
  });
  assert.deepEqual(parseBestmove('bestmove a8q'), { bestmove: 'a8q', ponder: null });
  assert.deepEqual(parseBestmove('bestmove (none)'), { bestmove: '(none)', ponder: null });
  assert.equal(parseBestmove('info depth 3'), null);
});

test('parseInfoLine reads the numeric fields and the pv', () => {
  const info = parseInfoLine(
    'info depth 12 seldepth 15 multipv 1 score cp 34 nodes 1234 nps 50000 time 25 pv e2e4 e7e5 g1f3'
  );
  assert.deepEqual(info, {
    depth: 12,
    seldepth: 15,
    multipv: 1,
    scoreCp: 34,
    scoreMate: null,
    nodes: 1234,
    nps: 50000,
    timeMs: 25,
    pv: 'e2e4 e7e5 g1f3',
  });
  const mate = parseInfoLine('info depth 9 score mate 3 pv f3f7');
  assert.equal(mate?.scoreMate, 3);
  assert.equal(mate?.scoreCp, null);
  const negative = parseInfoLine('info score cp -87 nodes 5');
  assert.equal(negative?.scoreCp, -87);
  assert.equal(parseInfoLine('uciok'), null);
});

test('engineIdSlug slugs the part before " by "', () => {
  assert.equal(
    engineIdSlug('Stockfish 17.1 by the Stockfish developers (see AUTHORS file)'),
    'stockfish-17.1'
  );
  assert.equal(engineIdSlug('Weird Engine'), 'weird-engine');
  assert.equal(engineIdSlug(null), null);
  assert.equal(engineIdSlug(''), null);
});

test('DEFAULT_HASH_MB is the fixed table size episodes rely on', () => {
  assert.equal(DEFAULT_HASH_MB, 16);
});

test('findEngineBinary honours GAUNTLET_STOCKFISH when it exists', () => {
  const previous = process.env[STOCKFISH_ENV_VAR];
  process.env[STOCKFISH_ENV_VAR] = FIXTURE;
  try {
    assert.equal(findEngineBinary(), FIXTURE);
  } finally {
    if (previous === undefined) delete process.env[STOCKFISH_ENV_VAR];
    else process.env[STOCKFISH_ENV_VAR] = previous;
  }
});

test('findEngineBinary throws when GAUNTLET_STOCKFISH points nowhere', () => {
  const previous = process.env[STOCKFISH_ENV_VAR];
  process.env[STOCKFISH_ENV_VAR] = '/nonexistent/stockfish-nope';
  try {
    assert.throws(() => findEngineBinary(), /GAUNTLET_STOCKFISH.*does not exist/);
  } finally {
    if (previous === undefined) delete process.env[STOCKFISH_ENV_VAR];
    else process.env[STOCKFISH_ENV_VAR] = previous;
  }
});

test('findEngineBinary returns null for an unknown PATH name', () => {
  // Hermetic even when GAUNTLET_STOCKFISH is ambient (the documented setup
  // step exports it suite-wide): clear it for the lookup, restore after.
  const previous = process.env[STOCKFISH_ENV_VAR];
  delete process.env[STOCKFISH_ENV_VAR];
  try {
    assert.equal(findEngineBinary('definitely-not-an-engine-xyz'), null);
  } finally {
    if (previous === undefined) delete process.env[STOCKFISH_ENV_VAR];
    else process.env[STOCKFISH_ENV_VAR] = previous;
  }
});

test('findEngineBinary keeps GAUNTLET_STOCKFISH scoped to the stockfish name', () => {
  const previous = process.env[STOCKFISH_ENV_VAR];
  process.env[STOCKFISH_ENV_VAR] = FIXTURE;
  try {
    // Stockfish lookups: the override wins.
    assert.equal(findEngineBinary(), FIXTURE);
    assert.equal(findEngineBinary('stockfish'), FIXTURE);
    // Any other requested name is looked up on its own merits.
    assert.equal(findEngineBinary('definitely-not-an-engine-xyz'), null);
  } finally {
    if (previous === undefined) delete process.env[STOCKFISH_ENV_VAR];
    else process.env[STOCKFISH_ENV_VAR] = previous;
  }
});

test('findEngineBinary probes the extra game directories after PATH', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gauntlet-engine-'));
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const link = path.join(dir, 'stockfish');
    await symlink(FIXTURE, link);
    assert.equal(findEngineBinary('stockfish', { searchDirs: [dir] }), link);
    assert.equal(findEngineBinary('other-name-here', { searchDirs: [dir] }), null);
  } finally {
    process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test('findEngineBinary finds /usr/games/stockfish when PATH omits it', { skip: existsSync('/usr/games/stockfish') ? false : '/usr/games/stockfish is not installed here' }, () => {
  // The Debian/CI layout the README documents: apt installs to /usr/games
  // and a non-interactive PATH does not include it.
  const previousPath = process.env.PATH;
  const previousEnv = process.env[STOCKFISH_ENV_VAR];
  process.env.PATH = '/bin';
  delete process.env[STOCKFISH_ENV_VAR];
  try {
    assert.equal(findEngineBinary(), '/usr/games/stockfish');
  } finally {
    process.env.PATH = previousPath;
    if (previousEnv === undefined) delete process.env[STOCKFISH_ENV_VAR];
    else process.env[STOCKFISH_ENV_VAR] = previousEnv;
  }
});

test('probeEngineIdSync reads the fixture id name', () => {
  assert.equal(probeEngineIdSync(FIXTURE), 'FakeFish 1.0');
});

test('probeEngineIdSync returns null for a missing binary', () => {
  assert.equal(probeEngineIdSync('/nonexistent/stockfish-nope'), null);
});

test('handshake captures the id name and the engine answers searches', async () => {
  const engine = fakeEngine();
  await engine.start();
  try {
    assert.equal(engine.idName, 'FakeFish 1.0');
    engine.positionStart(['e2e4', 'e7e5']);
    const result = await engine.goNodes(500);
    assert.equal(result.bestmove, 'e7e5');
    assert.equal(result.ponder, 'g1f3');
    assert.equal(result.info?.depth, 9);
    assert.equal(result.info?.nodes, 900);
    assert.equal(result.info?.pv, 'e7e5');
  } finally {
    await engine.quit();
  }
});

test('setoption and ucinewgame round-trip and leave the engine usable', async () => {
  const engine = fakeEngine();
  await engine.start();
  try {
    await engine.setoption('Threads', 1);
    await engine.setoption('Hash', DEFAULT_HASH_MB);
    await engine.ucinewgame();
    engine.positionStart([]);
    const result = await engine.goNodes(100);
    assert.equal(result.bestmove, 'e7e5');
  } finally {
    await engine.quit();
  }
});

test('garbage lines around the protocol do not desync the client', async () => {
  const engine = fakeEngine(['--garbage']);
  await engine.start();
  try {
    assert.equal(engine.idName, 'FakeFish 1.0');
    engine.positionStart([]);
    const result = await engine.goNodes(100);
    assert.equal(result.bestmove, 'e7e5');
  } finally {
    await engine.quit();
  }
});

test('a hanging engine fails the search with a timeout error', async () => {
  const engine = fakeEngine(['--hang-on-go']);
  await engine.start();
  try {
    engine.positionStart([]);
    await assert.rejects(
      engine.goNodes(100, { searchTimeoutMs: 400 }),
      /did not respond to "go nodes 100" within 400ms/
    );
    // The timed-out engine is unusable; the client says so clearly.
    await engine.quit();
    assert.throws(() => engine.positionStart([]), /exited unexpectedly|no writable stdin/);
    await assert.rejects(engine.goNodes(100), /exited unexpectedly|no writable stdin/);
  } finally {
    await engine.quit();
  }
});

test('an engine that crashes mid-search surfaces the crash', async () => {
  const engine = fakeEngine(['--crash-on-go']);
  await engine.start();
  engine.positionStart([]);
  await assert.rejects(engine.goNodes(100), /exited unexpectedly .*code=7/);
  await engine.quit();
});

test('an engine that dies during the handshake fails start()', async () => {
  const engine = fakeEngine(['--crash-handshake']);
  await assert.rejects(engine.start(), /exited unexpectedly .*code=3/);
});

test('a missing binary fails start() with a path-naming error', async () => {
  const engine = new UciEngine({ binaryPath: '/nonexistent/stockfish-nope' });
  await assert.rejects(
    engine.start(),
    /could not spawn the engine binary at "\/nonexistent\/stockfish-nope"/
  );
});

test('quit() is idempotent and resolves after the engine is gone', async () => {
  const engine = fakeEngine();
  await engine.start();
  await engine.quit();
  await engine.quit();
  await assert.rejects(engine.goNodes(100), /exited unexpectedly|no writable stdin/);
});

test('a timed-out handshake kills the engine and reports the command', async () => {
  // /bin/cat speaks no UCI: it echoes nothing UCI-shaped and never terminates.
  const engine = new UciEngine({
    binaryPath: process.execPath,
    engineArgs: ['-e', 'process.stdin.resume()'],
    commandTimeoutMs: 400,
    idleTimeoutMs: 2000,
  });
  await assert.rejects(engine.start(), /did not respond to "uci" within 400ms/);
  await engine.quit();
});

test('constructing without a binary path is a clear error', () => {
  assert.throws(
    () => new UciEngine(/** @type {never} */ ({})),
    /requires options\.binaryPath/
  );
});

test('goNodes rejects a non-positive node budget', async () => {
  const engine = fakeEngine();
  await engine.start();
  try {
    await assert.rejects(engine.goNodes(0), /positive integer/);
    await assert.rejects(engine.goNodes(-5), /positive integer/);
    await assert.rejects(engine.goNodes(1.5), /positive integer/);
  } finally {
    await engine.quit();
  }
});

test('goNodes with a one-node budget still answers', async () => {
  const engine = fakeEngine();
  await engine.start();
  try {
    engine.positionStart([]);
    const result = await engine.goNodes(1);
    assert.equal(result.bestmove, 'e7e5');
  } finally {
    await engine.quit();
  }
});

test('idleTimeoutMs 0 keeps the engine alive indefinitely', async () => {
  const engine = fakeEngine([], { idleTimeoutMs: 0 });
  await engine.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    engine.positionStart([]);
    const result = await engine.goNodes(100);
    assert.equal(result.bestmove, 'e7e5');
  } finally {
    await engine.quit();
  }
});

// Real-engine tests: skipped with a message when no binary is on the machine.
test('real engine: handshake and id name', { skip: REAL_BINARY ? false : 'no engine binary found (set GAUNTLET_STOCKFISH or install stockfish)' }, async (t) => {
  const engine = new UciEngine({ binaryPath: /** @type {string} */ (REAL_BINARY) });
  await engine.start();
  t.diagnostic(`real engine id name: ${engine.idName}`);
  assert.ok(engine.idName, 'the real engine must report an id name');
  await engine.quit();
});

test('real engine: the same position and node budget gives the same bestmove', { skip: REAL_BINARY ? false : 'no engine binary found (set GAUNTLET_STOCKFISH or install stockfish)' }, async () => {
  const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6'];
  const engines = [];
  try {
    for (let i = 0; i < 2; i++) {
      const engine = new UciEngine({ binaryPath: /** @type {string} */ (REAL_BINARY) });
      await engine.start();
      await engine.setoption('Threads', 1);
      await engine.setoption('Hash', DEFAULT_HASH_MB);
      await engine.ucinewgame();
      engine.positionStart(moves);
      engines.push(engine);
    }
    const [first, second] = engines;
    const one = await first.goNodes(1000);
    const two = await second.goNodes(1000);
    assert.equal(one.bestmove, two.bestmove);
    assert.match(one.bestmove, /^[a-h][1-8][a-h][1-8][qrbn]?$/);
  } finally {
    for (const engine of engines) await engine.quit();
  }
});
