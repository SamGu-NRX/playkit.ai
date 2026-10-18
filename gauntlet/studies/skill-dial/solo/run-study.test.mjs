/**
 * Concurrency test for the skill-dial solo orchestrator (`run-study.mjs`),
 * run as a subprocess.
 *
 * Pins the wiring fix: the orchestrator used to `await` each worker's exit
 * inside the spawn loop, so `--workers 6` ran the workers one at a time (PR
 * #72 review). The fix spawns every worker first, then awaits all of them.
 *
 * The test points the orchestrator at a stub worker (env seam
 * SKILL_DIAL_WORKER_SCRIPT) that records its start and end times and sleeps
 * for one second. With concurrent workers every start precedes every end;
 * with the serialized loop the second worker's start necessarily follows the
 * first worker's end. The orchestrator then exits 1 because the stub wrote no
 * episodes - which also pins that the missing-episode gate still trips.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const WORKER_STUB = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const out = argv[argv.indexOf('--out') + 1];
const index = argv[argv.indexOf('--index') + 1];
writeFileSync(join(out, \`start-\${index}\`), String(Date.now()));
const busyUntil = Date.now() + 1000;
while (Date.now() < busyUntil) {}
writeFileSync(join(out, \`done-\${index}\`), String(Date.now()));
`;

test('the orchestrator runs its workers concurrently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-dial-orch-'));
  const out = join(dir, 'runs');
  writeFileSync(join(dir, 'worker-stub.mjs'), WORKER_STUB);
  try {
    const child = spawn(
      process.execPath,
      [join(here, 'run-study.mjs'), '--out', out, '--workers', '3'],
      { cwd: here, env: { ...process.env, SKILL_DIAL_WORKER_SCRIPT: join(dir, 'worker-stub.mjs') }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const stderr = [];
    child.stderr.on('data', (d) => stderr.push(d));
    const exit = await new Promise((res, rej) => {
      child.on('exit', (code) => res(code));
      child.on('error', rej);
    });
    // The stub produces no trajectories, so the missing-episode gate must
    // fail the run - exactly what the gate is for.
    assert.equal(exit, 1, `orchestrator exit (stderr: ${stderr.join('')})`);
    const names = readdirSync(out);
    for (const k of ['0', '1', '2']) {
      assert.ok(names.includes(`start-${k}`), `worker ${k} started`);
      assert.ok(names.includes(`done-${k}`), `worker ${k} finished`);
    }
    const starts = names.filter((n) => n.startsWith('start-')).map((n) => Number(readFileSync(join(out, n), 'utf8')));
    const dones = names.filter((n) => n.startsWith('done-')).map((n) => Number(readFileSync(join(out, n), 'utf8')));
    // Concurrent: the LAST worker started before the FIRST one finished.
    assert.ok(
      Math.max(...starts) < Math.min(...dones),
      `all three workers overlapped (starts ${starts}, dones ${dones})`
    );
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.jobs, manifest.missing);
    assert.equal(manifest.ran, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A worker that exits nonzero used to reject the orchestrator's
// Promise.all before manifest.json was written, while the sibling workers
// ran on unwatched - the run left no manifest and no exit naming the
// failure (PR review r4305289838). Pins the settle-all fix: every worker is
// awaited, the manifest is always written (naming the failed worker), and
// the orchestrator exits nonzero only AFTER the manifest lands.
const WORKER_ONE_FAILS_STUB = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const out = argv[argv.indexOf('--out') + 1];
const index = argv[argv.indexOf('--index') + 1];
writeFileSync(join(out, \`done-\${index}\`), String(Date.now()));
if (index === '1') {
  process.stderr.write('stub worker 1 exploded\\n');
  process.exit(3);
}
`;

test('a failed worker does not skip the manifest: all workers settle, the manifest names the failure, exit is nonzero', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-dial-orch-fail-'));
  const out = join(dir, 'runs');
  writeFileSync(join(dir, 'worker-fail-stub.mjs'), WORKER_ONE_FAILS_STUB);
  try {
    const child = spawn(
      process.execPath,
      [join(here, 'run-study.mjs'), '--out', out, '--workers', '3'],
      { cwd: here, env: { ...process.env, SKILL_DIAL_WORKER_SCRIPT: join(dir, 'worker-fail-stub.mjs') }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const stderr = [];
    child.stderr.on('data', (d) => stderr.push(d));
    const exit = await new Promise((res, rej) => {
      child.on('exit', (code) => res(code));
      child.on('error', rej);
    });
    const names = readdirSync(out);
    // All workers ran to completion before the orchestrator exited - the
    // failure settled, it did not cancel the siblings.
    for (const k of ['0', '1', '2']) {
      assert.ok(names.includes(`done-${k}`), `worker ${k} finished`);
    }
    const stderrText = stderr.join('');
    assert.match(stderrText, /worker 1 exited with code 3/, `stderr must name the failing worker (got: ${stderrText})`);
    assert.equal(exit, 1, 'a failed worker must fail the orchestrator');
    const manifestPath = join(out, 'manifest.json');
    assert.ok(names.includes('manifest.json'), 'manifest.json must be written even when a worker fails');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(manifest.failedWorkers, [1], 'the manifest must name the failed worker');
    assert.equal(manifest.missing, manifest.jobs, 'the stub wrote no episodes, so the missing gate still holds');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
