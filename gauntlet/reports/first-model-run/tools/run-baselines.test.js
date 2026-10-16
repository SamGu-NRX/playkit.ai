import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pin for tools/run-baselines.sh (PR #41 review, finding 3): the script used
 * `|| echo` after every baseline invocation, which swallowed every failure —
 * the script always exited 0 and printed ALL BASELINES DONE even when a
 * campaign crashed, making a partial baseline run indistinguishable from
 * success to automation.
 *
 * The test shadows `node` with a failing stub on PATH (so no real baseline
 * campaign can start), verifies the shadow took effect, and asserts the
 * script exits non-zero. Against the old script this fails: every invocation
 * failed and the echoes drove the exit status to 0.
 */

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'run-baselines.sh');

test('run-baselines.sh exits non-zero when baseline invocations fail', () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'rb-stub-'));
  const stub = join(stubDir, 'node');
  writeFileSync(stub, '#!/bin/sh\nexit 1\n');
  chmodSync(stub, 0o755);
  const env = { ...process.env, PATH: `${stubDir}:${process.env.PATH}` };

  // Guard: inside this environment `node` must resolve to the stub, never to
  // the real interpreter, before we let the script run.
  const which = spawnSync('bash', ['-c', 'command -v node'], { env, encoding: 'utf8' });
  assert.equal(which.stdout.trim(), stub, 'node must be shadowed by the failing stub');

  const res = spawnSync('bash', [script], { env, encoding: 'utf8', timeout: 120_000 });
  assert.notEqual(res.status, 0, 'script must propagate baseline failures to its exit status');
});
