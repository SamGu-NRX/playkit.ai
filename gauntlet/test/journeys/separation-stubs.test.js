import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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
 * @returns {{ child: import('node:child_process').ChildProcess, port: number }}
 */
function startEphemeralStub(wire, portFile) {
  const child = spawn(process.execPath, [
    path.join(stubsDir, `${wire}.mjs`),
    '--port',
    '0',
    '--port-file',
    portFile,
  ]);
  const deadline = Date.now() + 5000;
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) {
      throw new Error(`stub ${wire} never wrote its port file (portFile=${portFile})`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`stub ${wire} exited before reporting its port`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  const port = Number(readFileSync(portFile, 'utf8').trim());
  return { child, port };
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
});
