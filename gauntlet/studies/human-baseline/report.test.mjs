/**
 * Tests for the human-baseline report generator (`report.mjs`), run as a
 * subprocess the way a person runs it.
 *
 * The pinned behavior: a verifier verdict AND a verifier exception both land
 * in the report's failure rows — a malformed trajectory must never crash the
 * whole report. `verifyTrajectory` returns failed verdicts for known-bad
 * inputs (wrong version, unknown tier, bad seat) but can THROW on shapes
 * those guards do not reach (e.g. `steps: null` explodes on
 * `trajectory.steps.length`); report.mjs used to await it unguarded, so one
 * such file took down the run with an unhandled rejection (review finding on
 * PR #98).
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGame } from '../../games/index.js';

const here = dirname(fileURLToPath(import.meta.url));

test('a verifier exception is a failure row, not a crashed report', () => {
  const game = getGame('tictactoe');
  const seat = game.agentSeat(game.spec.tiers[0], 0);
  const dir = mkdtempSync(join(tmpdir(), 'human-baseline-report-'));
  try {
    // Passes the format pre-check and all verdict guards, then throws inside
    // the step loop because steps is null.
    writeFileSync(
      join(dir, 'throws.json'),
      JSON.stringify({
        format: 'playkit-gauntlet-trajectory/1',
        game: { id: 'tictactoe', version: game.spec.version },
        tier: game.spec.tiers[0].id,
        seed: 0,
        agent: { id: 'human', seat },
        end: { agentActions: 0, invalidActions: 0 },
        steps: null,
      })
    );
    // A failed VERDICT (not an exception): version the registry no longer has.
    writeFileSync(
      join(dir, 'mismatched.json'),
      JSON.stringify({
        format: 'playkit-gauntlet-trajectory/1',
        game: { id: 'tictactoe', version: '9.9.9' },
        tier: game.spec.tiers[0].id,
        seed: 0,
        agent: { id: 'human', seat },
        end: { agentActions: 0, invalidActions: 0 },
        steps: [],
      })
    );
    const run = spawnSync(process.execPath, [join(here, 'report.mjs'), dir, '--json'], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 1, `exit 1 with failures, got ${run.status}: ${run.stderr}`);
    const report = JSON.parse(run.stdout);
    assert.equal(report.trajectories.total, 2);
    assert.equal(report.trajectories.failed, 2);
    assert.equal(report.trajectories.verified, 0);
    assert.deepEqual(report.tiers, []);
    const threw = report.failures.find((/** @type {{ reason: string }} */ f) => f.file.endsWith('throws.json'));
    assert.match(threw.reason, /^verifier threw: /);
    const mismatch = report.failures.find((/** @type {{ reason: string }} */ f) => f.file.endsWith('mismatched.json'));
    assert.match(mismatch.reason, /^replay verification failed at step -1: trajectory recorded game version 9\.9\.9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-trajectory JSON fails before the verifier, exactly as before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'human-baseline-report-'));
  try {
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ hello: 'world' }));
    const run = spawnSync(process.execPath, [join(here, 'report.mjs'), dir, '--json'], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 1);
    const report = JSON.parse(run.stdout);
    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0].reason, /not a playkit-gauntlet-trajectory\/1 file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
