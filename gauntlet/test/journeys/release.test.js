import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const release = path.join(here, '..', '..', 'journeys', 'release', 'release.sh');

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
    if (!existsSync('/usr/bin/gnugo') && !existsSync('/usr/games/gnugo')) {
      t.skip();
    }
    const out = runStage('D');
    assert.match(out, /journey D: PASS/);
    for (const tier of ['ladder-1', 'ladder-2', 'ladder-3', 'ladder-4']) {
      assert.match(out, new RegExp(`go/${tier}`), `stage D must play ${tier}`);
    }
    const verifies = out.match(/1\/1 trajectories verified/g) ?? [];
    assert.ok(verifies.length >= 4, `expected >=4 verify lines, got ${verifies.length}`);
  });
});
