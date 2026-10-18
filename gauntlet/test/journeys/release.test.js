import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const release = path.join(here, '..', '..', 'journeys', 'release', 'release.sh');

/**
 * Whether a gnugo binary is resolvable on the given PATH — the same gate
 * release.sh applies with `command -v gnugo` before stage D. Checking fixed
 * install paths here instead would skip the journey whenever GNU Go lives
 * anywhere else on PATH, leaving the test gate weaker than the script it
 * replays.
 *
 * @param {NodeJS.ProcessEnv} [env] Environment whose PATH is searched;
 *   defaults to process.env.
 * @returns {boolean}
 */
const hasGnugo = (env = process.env) => {
  try {
    execFileSync('gnugo', ['--version'], { stdio: 'ignore', timeout: 15000, env: { ...env } });
    return true;
  } catch (err) {
    // ENOENT means no gnugo anywhere on that PATH — the same outcome
    // release.sh's `command -v gnugo` gate produces. Any other failure means
    // a gnugo was found but unhappy at runtime — it exists, which is what
    // this gate asks; stage D below fails loudly if it cannot drive it.
    // Resolution must happen against the passed env's own PATH (the custom
    // PATH probe below depends on it), so no shell is spawned: `spawnSync`
    // would resolve the shell itself against that PATH and ENOENT.
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    return code !== 'ENOENT';
  }
};

/**
 * Run release.sh with the given stage list.
 *
 * @param {string} stages RELEASE_STAGES value.
 * @param {Record<string, string>} env extra environment.
 * @returns {string} combined stdout.
 */
const runStage = (stages, env = {}) =>
  execFileSync('bash', [release], {
    encoding: 'utf8',
    timeout: 600000,
    env: { ...process.env, RELEASE_STAGES: String(stages), JOURNEY_WORK: process.env.JOURNEY_WORK ?? '/tmp/gauntlet-release-test', ...env },
  });

describe('journeys/release/release.sh', () => {
  it('parses (bash -n)', () => {
    execFileSync('bash', ['-n', release]);
  });

  it('replays stage E (human at the terminal): scripted solve, verify, kit report', { timeout: 600000 }, () => {
    const out = runStage('E');
    assert.match(out, /journey E: PASS/);
    assert.match(out, /solved in 5 actions against par 5/);
    assert.match(out, /1\/1 trajectories verified/);
    assert.match(out, /human-baseline report — 1\/1 trajectories verified/);
    assert.match(out, /sokoban\/one-box/);
    assert.match(out, /actions\/par/);
  });

  it('replays stage D (Go): one verified episode per GNU Go tier', { timeout: 600000 }, (t) => {
    // Skip the way release.sh itself skips (command -v gnugo), and return so
    // the test body actually stops — a bare t.skip() marks the result but the
    // remaining statements still run.
    if (!hasGnugo()) {
      return t.skip('no gnugo binary on PATH — release.sh skips stage D the same way');
    }
    const out = runStage('D');
    assert.match(out, /journey D: PASS/);
    for (const tier of ['ladder-1', 'ladder-2', 'ladder-3', 'ladder-4']) {
      assert.match(out, new RegExp(`go/${tier}`), `stage D must play ${tier}`);
    }
    const verifies = out.match(/1\/1 trajectories verified/g) ?? [];
    assert.ok(verifies.length >= 4, `expected >=4 verify lines, got ${verifies.length}`);
  });

  it('hasGnugo resolves gnugo from PATH, not from fixed install paths', () => {
    // A fake gnugo that lives only on a synthetic PATH must be found — the
    // two fixed install-path checks the old gate used would miss it and skip
    // a journey release.sh would have run.
    const fakeBin = path.join(tmpdir(), `gauntlet-hasgnugo-${process.pid}-${Date.now()}`);
    mkdirSync(fakeBin, { recursive: true });
    const fake = path.join(fakeBin, 'gnugo');
    writeFileSync(fake, '#!/bin/sh\necho "GNU Go 3.8 fake"\nexit 0\n');
    chmodSync(fake, 0o755);
    try {
      assert.equal(hasGnugo({ PATH: fakeBin }), true, 'a PATH-resolvable gnugo must be found');
      assert.equal(hasGnugo({ PATH: fakeBin + path.delimiter + process.env.PATH }), true);
      const emptyBin = path.join(tmpdir(), `gauntlet-nognugo-${process.pid}-${Date.now()}`);
      mkdirSync(emptyBin, { recursive: true });
      try {
        assert.equal(hasGnugo({ PATH: emptyBin }), false, 'no gnugo on PATH must not be found');
      } finally {
        rmSync(emptyBin, { recursive: true, force: true });
      }
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
