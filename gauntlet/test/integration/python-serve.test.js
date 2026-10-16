/**
 * Integration: the Python client plays one full tictactoe episode through
 * `gauntlet serve` — the CLI's serve subcommand, not the protocol module
 * directly — and the trajectory it records replays cleanly under the JS
 * verifier. Skips when python3 is unavailable.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const gauntletRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('python client plays tictactoe through gauntlet serve', { timeout: 2 * 60 * 1000 }, (t) => {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip('python3 is not available');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'gauntlet-py-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // GauntletClient launches [node_executable, server_path]; the wrapper execs
  // the CLI's serve subcommand regardless of the trailing argument.
  const wrapper = join(root, 'gauntlet-serve.sh');
  writeFileSync(wrapper, `#!/bin/sh\nexec node '${gauntletRoot}/cli/gauntlet.js' serve\n`);
  chmodSync(wrapper, 0o755);

  const trajectoryOut = join(root, 'trajectory.json');
  const driver = join(gauntletRoot, 'test', 'integration', 'python_serve_episode.py');
  const run = spawnSync(
    'python3',
    [driver, trajectoryOut, gauntletRoot, wrapper],
    { encoding: 'utf8', timeout: 90 * 1000 }
  );
  assert.equal(
    run.status,
    0,
    `python driver failed (${run.status}):\n${run.stdout}\n${run.stderr}`
  );
  assert.match(run.stdout, /episode over: terminal/);

  // The trajectory the Python client recorded must replay under the JS CLI.
  const verify = execFileSync(
    process.execPath,
    [join(gauntletRoot, 'cli', 'gauntlet.js'), 'verify', trajectoryOut],
    { encoding: 'utf8' }
  );
  assert.match(verify, /1\/1 trajectories verified/);
});
