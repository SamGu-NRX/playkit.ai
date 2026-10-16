/**
 * Unit: `verify` treats estimate artifacts as metadata. `estimate --out
 * <dir>` writes `estimate.json` and `estimate.md` beside `run.json`; the
 * trajectory verifier must skip both like `run.json` and `suite.json` — they
 * are provenance, not trajectories — while an unrecognized stray `.json`
 * still fails verification.
 *
 * The bundles here run the registered `cube` game, because `verifyPath`
 * replay-verifies trajectories through the registered-game registry; the
 * scoring fixture games are not registered and cannot be replayed.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSuite } from '../scoring/suite.js';
import { scriptedAgent } from '../scoring/fixtures.js';
import { getGame } from '../games/index.js';
import { runSuite } from '../runs/run.js';
import { verifyPath } from './verify.js';

const SUITE = buildSuite([getGame('cube')], { split: 'public' });

/**
 * Run the registered cube game into a run directory with a scripted agent
 * whose reply is not a legal action, so every episode forfeits quickly and
 * the bundle holds replayable trajectories for the verifier.
 *
 * @param {string} dir Run directory.
 */
async function runCubeBundle(dir) {
  const result = await runSuite({
    suite: SUITE,
    games: [getGame('cube')],
    outDir: dir,
    agentFactory: () => scriptedAgent(['x']),
  });
  assert.equal(result.stopped, null);
}

test('verify skips estimate.json and estimate.md as metadata', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-verify-meta-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await runCubeBundle(dir);

  // An estimate artifact need not even be well-formed as a trajectory: it is
  // skipped by name, never parsed as one.
  await writeFile(join(dir, 'estimate.json'), '{\n  "format": "playkit-gauntlet-estimate/1"\n}\n');
  await writeFile(join(dir, 'estimate.md'), '# Estimate\n');

  const report = await verifyPath(dir);
  // The cube suite has 34 public episodes (16 on-ramp seeds on cube-2 plus
  // 3 tiers x 6 seeds on cube-5/7/9).
  assert.deepEqual(report.failures, [], 'no failures on a bundle that also holds an estimate');
  assert.equal(report.ok, 34, 'all trajectories verified');
  assert.equal(report.total, 34, 'the estimate artifacts were not counted as trajectories');
});

test('verify still fails on an unrecognized stray .json beside the estimate', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-verify-meta-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await runCubeBundle(dir);

  await writeFile(join(dir, 'estimate.json'), '{}\n');
  await writeFile(join(dir, 'estimate.md'), '# Estimate\n');
  await writeFile(join(dir, 'stray.json'), '{"not":"a trajectory"}\n');

  const report = await verifyPath(dir);
  assert.equal(report.total, 35, 'the stray file is still collected (34 trajectories + 1 stray)');
  assert.equal(report.ok, 34, 'all trajectories verified');
  assert.equal(report.failures.length, 1, 'exactly the stray file fails');
  assert.match(report.failures[0], /stray\.json/);
});
