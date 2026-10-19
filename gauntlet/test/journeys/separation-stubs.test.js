import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const gauntletRoot = path.join(here, '..', '..');
const stubsDir = path.join(gauntletRoot, 'journeys', 'pilot', 'stubs');
const pilotDir = path.join(gauntletRoot, 'journeys', 'pilot');

/**
 * Spawn a stub that binds an ephemeral port and reports the assigned one
 * through --port-file, then wait for the report (up to ~5 s).
 *
 * @param {'anthropic' | 'openai' | 'openai-chat'} wire
 * @param {string} portFile
 * @param {string} [stubPath] Override the stub script path (tests inject fakes).
 * @returns {{ child: import('node:child_process').ChildProcess, port: number }}
 */
function startEphemeralStub(wire, portFile, stubPath) {
  const child = spawn(process.execPath, [
    stubPath ?? path.join(stubsDir, `${wire}.mjs`),
    '--port',
    '0',
    '--port-file',
    portFile,
  ]);
  const deadline = Date.now() + 5000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`stub ${wire} exited before reporting its port`);
    }
    let reported = '';
    try {
      reported = readFileSync(portFile, 'utf8').trim();
    } catch {
      // not written yet
    }
    const port = Number(reported);
    if (reported !== '' && Number.isInteger(port) && port >= 1 && port <= 65535) {
      return { child, port };
    }
    if (Date.now() > deadline) {
      // Stop the child before throwing: a timed-out startup must not leave a
      // listening stub behind to keep the test process open (greptile #120).
      child.kill('SIGTERM');
      throw new Error(`stub ${wire} never reported a usable port in ${portFile} within 5s`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

/**
 * POST to the stub like the rehearsal's readiness check does.
 *
 * @param {number} port
 * @returns {Promise<number>} HTTP status.
 */
async function ping(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/ping`, { method: 'POST', body: '{}' });
  await res.arrayBuffer();
  return res.status;
}

/**
 * Terminate a stub and wait for a clean exit.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<void>}
 */
async function stopStub(child) {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(undefined);
    child.on('exit', resolve);
  });
}

describe('journeys/pilot stub port allocation', () => {
  it('syntax-checks the pilot journey scripts (separation-run, rehearse, pilot)', () => {
    for (const script of ['separation-run.sh', 'rehearse.sh', 'pilot.sh']) {
      spawnSync('bash', ['-n', path.join(pilotDir, script)], { timeout: 15000 }).status === 0 ||
        assert.fail(`bash -n failed for ${script}`);
    }
  });

  it('an ephemeral stub (--port 0) binds, writes the assigned port, and answers requests', async () => {
    const work = tmpdir();
    const portFile = path.join(work, `gauntlet-stub-port-test-${process.pid}-${Date.now()}.port`);
    rmSync(portFile, { force: true });
    const { child, port } = startEphemeralStub('anthropic', portFile);
    try {
      assert.equal(
        Number.isInteger(port) && port >= 1 && port <= 65535,
        true,
        `the reported port must be a usable TCP port, got "${port}"`
      );
      assert.equal(await ping(port), 200, 'the stub must answer on the port it reported');
    } finally {
      await stopStub(child);
      rmSync(portFile, { force: true });
    }
  });

  it('two ephemeral stubs launched the way separation-run.sh does get distinct ports', async () => {
    const stamp = `${process.pid}-${Date.now()}`;
    const portFileA = path.join(tmpdir(), `gauntlet-stub-a-${stamp}.port`);
    const portFileB = path.join(tmpdir(), `gauntlet-stub-b-${stamp}.port`);
    rmSync(portFileA, { force: true });
    rmSync(portFileB, { force: true });
    const a = startEphemeralStub('anthropic', portFileA);
    try {
      const b = startEphemeralStub('openai', portFileB);
      try {
        assert.notEqual(a.port, b.port, 'two concurrently-bound stubs must not share a port');
        assert.equal(await ping(a.port), 200);
        assert.equal(await ping(b.port), 200);
      } finally {
        await stopStub(b.child);
        rmSync(portFileB, { force: true });
      }
    } finally {
      await stopStub(a.child);
      rmSync(portFileA, { force: true });
    }
  });

  it('refuses --port 0 without --port-file loudly (the launcher could never learn the port)', () => {
    const res = spawnSync(
      process.execPath,
      [path.join(stubsDir, 'openai-chat.mjs'), '--port', '0'],
      { encoding: 'utf8', timeout: 15000 }
    );
    assert.notEqual(res.status, 0, 'an ephemeral stub without a port file must refuse to start');
    assert.match(
      `${res.stderr}${res.stdout}`,
      /--port-file/,
      'the refusal must name --port-file so the fix is discoverable'
    );
  });

  it('refuses a bare --port-file with no path loudly (the flag-parsing sentinel must not become the path)', () => {
    // Precompute the path: non-recursive mkdirSync returns nothing, and the
    // recursive overload's return is string | undefined under strict checkJs.
    const work = path.join(tmpdir(), `gauntlet-stub-bare-${process.pid}-${Date.now()}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      const res = spawnSync(
        process.execPath,
        [path.join(stubsDir, 'openai-chat.mjs'), '--port', '0', '--port-file'],
        { encoding: 'utf8', timeout: 15000, cwd: work }
      );
      assert.equal(
        typeof res.status,
        'number',
        'the stub must refuse by itself, not run until the harness timeout kills it'
      );
      assert.notEqual(res.status, 0, 'a bare --port-file must be refused');
      assert.match(
        `${res.stderr}${res.stdout}`,
        /--port-file/,
        'the refusal must name --port-file so the fix is discoverable'
      );
      assert.equal(
        existsSync(path.join(work, '1')),
        false,
        'the sentinel path must not be written into a stray file named "1"'
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('skips the empty port-file write window and reports the real port', async () => {
    // Precompute the path: non-recursive mkdirSync returns nothing, and the
    // recursive overload's return is string | undefined under strict checkJs.
    const work = path.join(tmpdir(), `gauntlet-stub-race-${process.pid}-${Date.now()}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const portFile = path.join(work, 'lazy.port');
    rmSync(portFile, { force: true });
    const lazy = path.join(work, 'lazy-stub.mjs');
    // Writes an empty port file first, then the real port 500 ms later: a
    // parent that only waits for existence reads the empty window as port 0
    // even though the stub is healthy.
    writeFileSync(
      lazy,
      [
        "import http from 'node:http';",
        "import { writeFileSync } from 'node:fs';",
        'const portFile = process.argv[process.argv.length - 1];',
        'const server = http.createServer((req, res) => {',
        '  res.statusCode = 200;',
        "  res.end('pong');",
        '});',
        'server.listen(0, "127.0.0.1", () => {',
        "  writeFileSync(portFile, '', 'utf8');",
        '  setTimeout(() => {',
        "    writeFileSync(portFile, `${server.address().port}\\n`, 'utf8');",
        '  }, 500);',
        '});',
      ].join('\n')
    );
    try {
      const { child, port } = startEphemeralStub('anthropic', portFile, lazy);
      try {
        assert.equal(
          Number.isInteger(port) && port >= 1 && port <= 65535,
          true,
          `the helper must skip the empty window and report the real port, got "${port}"`
        );
        assert.equal(await ping(port), 200, 'the reported port must be the stub it is reading from');
      } finally {
        await stopStub(child);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('kills a stub that never reports its port before the helper gives up', async () => {
    // Precompute the path: non-recursive mkdirSync returns nothing, and the
    // recursive overload's return is string | undefined under strict checkJs.
    const work = path.join(tmpdir(), `gauntlet-stub-hang-${process.pid}-${Date.now()}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const portFile = path.join(work, 'silent.port');
    rmSync(portFile, { force: true });
    const silent = path.join(work, 'silent-stub.mjs');
    // Serves nothing to the port file and never exits: the helper's startup
    // deadline must stop this child before throwing, not leak it.
    writeFileSync(
      silent,
      [
        "import http from 'node:http';",
        "import { writeFileSync } from 'node:fs';",
        'const portFile = process.argv[process.argv.length - 1];',
        'const server = http.createServer();',
        'server.listen(0, "127.0.0.1", () => {',
        "  writeFileSync(`${portFile}.pid`, String(process.pid), 'utf8');",
        '});',
      ].join('\n')
    );
    try {
      assert.throws(
        () => startEphemeralStub('openai', portFile, silent),
        /never reported a usable port/,
        'the deadline must surface as a thrown startup failure'
      );
      const pid = Number(readFileSync(`${portFile}.pid`, 'utf8').trim());
      const giveUp = Date.now() + 5000;
      let alive = true;
      while (Date.now() < giveUp) {
        alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
          break;
        }
        // await (not Atomics.wait): the event loop must run so the killed
        // child is reaped - a zombie still answers kill(pid, 0).
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(
        alive,
        false,
        'the timed-out stub must be stopped by the helper, not left running'
      );
    } finally {
      rmSync(`${portFile}.pid`, { force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
