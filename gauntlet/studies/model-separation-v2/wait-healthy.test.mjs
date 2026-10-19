import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const waitHealthy = path.join(here, 'wait-healthy.sh');
const versusDir = path.join(here, 'versus');
const soloDir = path.join(here, 'solo');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start an HTTP server that answers every request 200 and report its port.
 *
 * @param {string} portFile
 * @returns {import('node:child_process').ChildProcess}
 */
function startHealthServer(portFile) {
  return spawn(
    process.execPath,
    [
      '-e',
      [
        "const http = require('node:http');",
        "const fs = require('node:fs');",
        'const s = http.createServer((q, res) => { res.end("ok"); });',
        `s.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(portFile)}, String(s.address().port)));`,
      ].join('\n'),
    ],
    { stdio: 'ignore' }
  );
}

describe('model-separation-v2 wait-healthy.sh', () => {
  it('syntax-checks the helper and the launchers it serves', () => {
    for (const script of [
      waitHealthy,
      path.join(versusDir, 'full-run.sh'),
      path.join(versusDir, 'probe-run.sh'),
      path.join(versusDir, 'reproduce.sh'),
      path.join(soloDir, 'serve-and-run.sh'),
      path.join(soloDir, 'run-7b.sh'),
      path.join(soloDir, 'run-7b-rest.sh'),
    ]) {
      spawnSync('bash', ['-n', script], { timeout: 15000 }).status === 0 ||
        assert.fail(`bash -n failed for ${script}`);
    }
  });

  it('exits 0 as soon as /health answers', async () => {
    const work = mkdtempSync(path.join(tmpdir(), 'wait-healthy-ok-'));
    const portFile = path.join(work, 'health.port');
    const server = startHealthServer(portFile);
    try {
      let port = 0;
      const giveUp = Date.now() + 5000;
      while (Date.now() < giveUp) {
        try {
          port = Number(readFileSync(portFile, 'utf8').trim());
        } catch {
          // not written yet
        }
        if (port >= 1) break;
        await sleep(100);
      }
      assert.ok(port >= 1, 'the health server must report its port');
      const res = spawnSync(
        'bash',
        [waitHealthy, String(server.pid), 'healthy-stem', '/dev/null'],
        {
          encoding: 'utf8',
          timeout: 30000,
          env: { ...process.env, WAIT_HEALTH_URL: `http://127.0.0.1:${port}/health` },
        }
      );
      assert.equal(res.status, 0, `the helper must succeed, stderr: ${res.stderr}`);
    } finally {
      server.kill('SIGKILL');
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('fails at once when the server exits before /health succeeds', async () => {
    const dead = spawn('sh', ['-c', 'exit 0']);
    await new Promise((resolve) => dead.on('exit', resolve));
    const res = spawnSync(
      'bash',
      [waitHealthy, String(dead.pid), 'dead-stem', '/tmp/none.log'],
      { encoding: 'utf8', timeout: 30000, env: { ...process.env, HEALTH_ATTEMPTS: '5' } }
    );
    assert.equal(res.status, 1, 'a dead server must fail the health phase');
    assert.match(res.stderr, /exited before \/health succeeded/);
  });

  it('exhausts its attempt budget loudly when the server stays alive but /health never succeeds', () => {
    const alive = spawn('sleep', ['60']);
    try {
      const res = spawnSync(
        'bash',
        [waitHealthy, String(alive.pid), 'never-stem', '/tmp/never.log'],
        {
          encoding: 'utf8',
          timeout: 40000,
          env: {
            ...process.env,
            HEALTH_ATTEMPTS: '2',
            WAIT_HEALTH_URL: 'http://127.0.0.1:1/health',
          },
        }
      );
      assert.equal(res.status, 1, 'the attempt budget must end in a loud failure');
      assert.match(res.stderr, /\/health never succeeded after 2 attempts/);
    } finally {
      alive.kill('SIGKILL');
    }
  });

  it('the launchers delegate their health phase to the helper and abort loudly when /health never succeeds', () => {
    const work = mkdtempSync(path.join(tmpdir(), 'wait-healthy-launchers-'));
    // Stays alive, serves nothing, ignores llama-server's arguments, and its
    // name must not match the launchers' pkill llama-server cleanup.
    const fake = path.join(work, 'fake-model-server');
    writeFileSync(fake, '#!/bin/bash\nexec sleep 60\n');
    chmodSync(fake, 0o755);
    const cases = [
      { script: path.join(versusDir, 'probe-run.sh'), args: ['fake.gguf', 'fake-stem', 'fake-tag'] },
      {
        script: path.join(soloDir, 'serve-and-run.sh'),
        args: ['fake', '/dev/null', path.join(work, 'runs')],
      },
    ];
    try {
      for (const c of cases) {
        const res = spawnSync('bash', [c.script, ...c.args], {
          encoding: 'utf8',
          timeout: 60000,
          env: {
            ...process.env,
            LLAMA: fake,
            MODELS: work,
            HEALTH_ATTEMPTS: '2',
            WAIT_HEALTH_URL: 'http://127.0.0.1:1/health',
          },
        });
        assert.equal(res.status, 1, `${c.script} must abort loudly (stderr: ${res.stderr})`);
        assert.match(
          res.stderr,
          /\/health never succeeded/,
          `${c.script} must report the health exhaustion`
        );
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
