/**
 * Tests for the GNU Go GTP client: response-block parsing, binary discovery
 * (GAUNTLET_GNUGO override, PATH and extra-dir probing), process wiring
 * against fake responder scripts (handshake, banners, error replies, crashes,
 * quit), and the live protocol against a real GNU Go when one is installed.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GtpEngine,
  GTP_ENV_VAR,
  findGtpBinary,
  parseGtpBlock,
} from './client.js';

const CLIENT_URL = JSON.stringify(new URL('./client.js', import.meta.url).href);

test('parser: an empty block holds no response', () => {
  assert.equal(parseGtpBlock(''), null);
  assert.equal(parseGtpBlock('banner text only\n\n'), null);
});

test('parser: ok blocks carry the marker-stripped payload', () => {
  assert.deepEqual(parseGtpBlock('= \n\n'), { ok: true, payload: '' });
  assert.deepEqual(parseGtpBlock('= A1\n\n'), { ok: true, payload: 'A1' });
  assert.deepEqual(parseGtpBlock('= 3.8\n\n'), { ok: true, payload: '3.8' });
  assert.deepEqual(parseGtpBlock('= white 0.5\n\n'), { ok: true, payload: 'white 0.5' });
  assert.deepEqual(parseGtpBlock('= W\n\n'), { ok: true, payload: 'W' });
});

test('parser: error blocks carry the GTP message', () => {
  assert.deepEqual(parseGtpBlock('? invalid color\n\n'), { ok: false, payload: 'invalid color' });
  assert.deepEqual(parseGtpBlock('? unreachable\n\n'), { ok: false, payload: 'unreachable' });
});

test('parser: banner lines before the marker are discarded', () => {
  assert.deepEqual(parseGtpBlock('GNU Go 3.8 says hello\n= A1\n\n'), { ok: true, payload: 'A1' });
});

test('discovery: GAUNTLET_GNUGO wins when it exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-gnugo-'));
  try {
    const fake = join(dir, 'fake-gnugo');
    writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    chmodSync(fake, 0o755);
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { findGtpBinary } from ${CLIENT_URL};` +
        `console.log(JSON.stringify(findGtpBinary()));`,
    ], { env: { ...process.env, [GTP_ENV_VAR]: fake } });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout.toString()), fake);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery: a GAUNTLET_GNUGO pointing nowhere names the path and the variable', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { findGtpBinary } from ${CLIENT_URL};` +
      'try { findGtpBinary(); } catch (err) { console.log(String(err.message)); }',
  ], { env: { ...process.env, [GTP_ENV_VAR]: '/nonexistent/gnugo-nope' } });
  assert.equal(result.status, 0);
  assert.match(
    result.stdout.toString(),
    /GAUNTLET_GNUGO is set to "\/nonexistent\/gnugo-nope" but that file does not exist/,
  );
});

test('discovery: without the env override and with no search dirs, the lookup is null', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { findGtpBinary } from ${CLIENT_URL};` +
      'console.log(JSON.stringify(findGtpBinary("gnugo", { searchDirs: [] })));',
  ], { env: { PATH: '' } });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout.toString()), null);
});

test('discovery: the injected search dir supplies the binary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-gnugo-'));
  try {
    const fake = join(dir, 'gnugo');
    writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    chmodSync(fake, 0o755);
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { findGtpBinary } from ${CLIENT_URL};` +
        `console.log(JSON.stringify(findGtpBinary("gnugo", { searchDirs: [${JSON.stringify(dir)}] })));`,
    ], { env: { PATH: '' } });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout.toString()), fake);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Remove every temp dir this suite created (mkdtemp appends a random suffix
 * to the prefix, so tests clean by prefix at the end of each test).
 *
 * @returns {void}
 */
function cleanupFake() {
  for (const entry of readdirSync(tmpdir())) {
    if (entry.startsWith('gauntlet-gnugo-')) {
      rmSync(join(tmpdir(), entry), { recursive: true, force: true });
    }
  }
}

/**
 * A fake engine: one reply block per stdin line, per the script given.
 *
 * @param {string} scriptBody Shell lines after the shebang.
 * @returns {string} Path to the executable script.
 */
function fakeEngine(scriptBody) {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-gnugo-'));
  const fake = join(dir, 'fake-gnugo');
  writeFileSync(fake, `#!/bin/sh\n${scriptBody}\n`);
  chmodSync(fake, 0o755);
  return fake;
}

test('process wiring: the handshake answers name and version and start resolves', async () => {
  const fake = fakeEngine('while IFS= read -r line; do printf \'= \\n\\n\'; done');
  try {
    const engine = new GtpEngine({ binaryPath: fake });
    await engine.start();
    assert.equal(engine.binaryPath, fake);
    assert.equal(typeof engine.idName, 'string');
    await engine.quit();
  } finally {
    cleanupFake();
  }
});

test('process wiring: a banner-only block is skipped and the real reply arrives', async () => {
  const fake = fakeEngine(
    'first=1\nwhile IFS= read -r line; do if [ "$first" = 1 ]; then first=0; printf \'GNU Go 3.8 banner\\n= GNU Go\\n\\n\'; else printf \'= \\n\\n\'; fi; done\n',
  );
  try {
    const engine = new GtpEngine({ binaryPath: fake });
    await engine.start();
    // The first handshake command (name) got the banner block's payload.
    assert.equal(engine.idName, 'GNU Go');
    await engine.quit();
  } finally {
    cleanupFake();
  }
});

test('process wiring: an error reply rejects with the GTP message', async () => {
  const fake = fakeEngine(
    'first=1\nwhile IFS= read -r line; do if [ "$first" = 1 ]; then first=0; printf \'= \\n\\n\'; else printf \'? cannot happen\\n\\n\'; fi; done\n',
  );
  try {
    const engine = new GtpEngine({ binaryPath: fake });
    // The handshake's second command (version) gets the error reply, so
    // start() itself rejects with the engine's message.
    await assert.rejects(engine.start(), /GTP command failed: cannot happen/);
    await engine.quit();
  } finally {
    cleanupFake();
  }
});

test('process wiring: a crashed engine fails the in-flight command', async () => {
  // One ok reply (the name), then the process kills itself before version.
  const fake = fakeEngine('printf \'= \\n\\n\'; kill -9 $$\n');
  const engine = new GtpEngine({ binaryPath: fake });
  // The rejection races the write error against the exit event; either is a clear failure.
  await assert.rejects(engine.start(), /exited unexpectedly|stdin write failed/);
});

test('process wiring: after quit, further commands say the engine is not running', async () => {
  const fake = fakeEngine('while IFS= read -r line; do printf \'= \\n\\n\'; done\n');
  try {
    const engine = new GtpEngine({ binaryPath: fake });
    await engine.start();
    await engine.quit();
    await assert.rejects(engine.command('name'), /not running/);
  } finally {
    cleanupFake();
  }
});

test('process wiring: repeated commands do not accumulate stdin error listeners', async () => {
  const fake = fakeEngine('while IFS= read -r line; do printf \'= 1\\n\\n\'; done');
  try {
    const engine = new GtpEngine({ binaryPath: fake });
    await engine.start();
    for (let i = 0; i < 15; i++) {
      await engine.command('is_legal black C3');
    }
    // The protective no-op stdin error handler is attached once at start.
    // One per command grows without bound across an episode (hundreds of
    // commands) and trips Node's MaxListenersExceededWarning on the 11th.
    assert.equal(
      engine.stdinErrorListenerCount,
      1,
      'stdin error handler must be attached once at start, not once per command',
    );
    await engine.quit();
    assert.equal(engine.stdinErrorListenerCount, 0, 'quit detaches the child');
  } finally {
    cleanupFake();
  }
});

test('process wiring: a late reply to a timed-out command is not misattributed to the next command', async () => {
  // The fake echoes ids like GNU Go does (=1 SlowGo), so the client can hold
  // it to id discipline. The genmove reply is sent from a backgrounded
  // subshell 300ms out — after the client's 100ms deadline but before the
  // next command's (slower) real reply — so the stale LATE block arrives
  // exactly in the window where a naive client would misattribute it.
  const fake = fakeEngine(
    'namecount=0\n' +
      'while IFS= read -r line; do\n' +
      '  cmd=$(printf \'%s\' "$line" | sed -E \'s/^[0-9]+ //\')\n' +
      '  id=$(printf \'%s\' "$line" | sed -nE \'s/^([0-9]+) .*/\\1/p\')\n' +
      '  case "$cmd" in\n' +
      '    name)\n' +
      '      namecount=$((namecount + 1))\n' +
      '      if [ "$namecount" -ge 2 ]; then sleep 0.5; fi\n' +
      '      if [ -n "$id" ]; then printf \'=%s SlowGo\\n\\n\' "$id"; else printf \'= SlowGo\\n\\n\'; fi ;;\n' +
      '    version) if [ -n "$id" ]; then printf \'=%s 1.0\\n\\n\' "$id"; else printf \'= 1.0\\n\\n\'; fi ;;\n' +
      '    genmove*) if [ -n "$id" ]; then (sleep 0.3; printf \'=%s LATE\\n\\n\' "$id") & else (sleep 0.3; printf \'= LATE\\n\\n\') & fi ;;\n' +
      '    *) if [ -n "$id" ]; then printf \'=%s ok\\n\\n\' "$id"; else printf \'= ok\\n\\n\'; fi ;;\n' +
      '  esac\n' +
      'done',
  );
  const engine = new GtpEngine({ binaryPath: fake, commandTimeoutMs: 100 });
  try {
    await engine.start();
    await assert.rejects(engine.command('genmove black'), /timed out after 100ms/);
    // The stale LATE block arrives while "name" is pending; id discipline
    // drops it and "name" settles from its own reply.
    assert.equal(await engine.command('name', { timeoutMs: 1500 }), 'SlowGo');
  } finally {
    // Even on a failed assertion: a live engine's open stdio pipe would hold
    // the test process open past the runner's exit.
    await engine.quit().catch(() => {});
    cleanupFake();
  }
});

const REAL_BINARY = findGtpBinary();

test('real gnugo: the protocol starts, identifies itself, and accepts setup', { skip: REAL_BINARY ? false : 'no GNU Go binary found (set GAUNTLET_GNUGO or install gnugo)' }, async () => {
  const binary = /** @type {string} */ (REAL_BINARY);
  const engine = new GtpEngine({
    binaryPath: binary,
    engineArgs: ['--mode', 'gtp', '--level', '1', '--seed', '424242'],
  });
  try {
    await engine.start();
    assert.match(/** @type {string} */ (engine.idName), /GNU Go/);
    await engine.boardsize(9);
    await engine.komi(7);
    await engine.clearBoard();
    await engine.play('black', 'C3');
  } finally {
    await engine.quit();
  }
});

test('real gnugo: fixed seed and fixed moves produce identical genmoves', { skip: REAL_BINARY ? false : 'no GNU Go binary found' }, async () => {
  const runOnce = async () => {
    const engine = new GtpEngine({
      binaryPath: /** @type {string} */ (REAL_BINARY),
      engineArgs: ['--mode', 'gtp', '--level', '1', '--seed', '424242'],
    });
    try {
      await engine.start();
      await engine.boardsize(9);
      await engine.clearBoard();
      const replies = [];
      for (const vertex of ['C3', 'G7', 'E5', 'C7', 'G3']) {
        // GNU Go's own genmove replies may occupy one of the fixed black
        // points; is_legal makes the replay deterministic under the seed.
        const verdict = await engine.command('is_legal black ' + vertex);
        if (String(verdict).trim() === '1') {
          await engine.play('black', vertex);
        }
        const reply = await engine.genmove('white');
        replies.push(reply);
      }
      return replies;
    } finally {
      await engine.quit();
    }
  };
  const first = await runOnce();
  const second = await runOnce();
  assert.ok(first.length === 5, `expected five replies, got ${JSON.stringify(first)}`);
  assert.ok(first.every((reply) => /^[A-J][1-9]$|^PASS$|^RESIGN$/i.test(reply)), JSON.stringify(first));
  assert.deepEqual(second, first);
});
