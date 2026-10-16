/**
 * Bundle verification tests: run a real fixture suite into a temp directory,
 * then verify the bundle as a third party would — happy path, tampered
 * trajectory, manifest-hash mismatch, missing episode, a stray
 * trajectory-format file, and page sessions (`gauntlet page` output), both
 * beside trajectories and as a standalone bundle. Page-session cases replay a
 * recorded real bridge-log fixture, so they stay offline.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSuite } from '../scoring/suite.js';
import { takeOrPass } from '../scoring/fixtures.js';
import { TRAJECTORY_FORMAT } from '../core/trajectory.js';

import { runSuite } from './run.js';
import { planJobs } from './plan.js';
import { trajectoryPath } from './fsutil.js';
import { verifyBundle } from './bundle.js';

/** @import { Agent } from '../core/types.js' */

const SUITE = buildSuite([takeOrPass], { split: 'public' });

/** A deterministic one-call agent that always takes.
 *
 * @returns {(job: *) => Agent}
 */
function takeFactory() {
  return () => /** @type {Agent} */ ({
    id: 'bundler',
    track: 'community',
    async act() {
      return { text: 'take', usage: { inputTokens: 10, outputTokens: 1, costUsd: 0.001 } };
    },
  });
}

/** @param {string} label */
async function tempDir(label) {
  return mkdtemp(path.join(tmpdir(), `gauntlet-bundle-${label}-`));
}

test('a complete run verifies as a bundle and re-scores ranked', async () => {
  const outDir = await tempDir('happy');
  try {
    const result = await runSuite({ suite: SUITE, games: [takeOrPass], agentFactory: takeFactory(), outDir });
    assert.equal(result.stopped, null);

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.ok, true);
    assert.equal(bundle.manifestHash.ok, true);
    assert.equal(bundle.manifestHash.recorded, bundle.manifestHash.actual);
    assert.deepEqual(bundle.stray, []);
    assert.equal(bundle.scoreError, null);
    assert.ok(bundle.score, 'scoring should not refuse a complete bundle');
    assert.equal(bundle.score.ranked, true);
    assert.equal(bundle.score.unrankedReason, null);
    assert.equal(bundle.score.episodes, 2);
    // Take-or-pass is a benchmark game and 'take' scores its top normalized
    // value, so the benchmark score is exactly 1.
    assert.equal(bundle.score.benchmarkScore.value, 1);
    assert.equal(bundle.score.games['take-or-pass'].score.value, 1);
    // Cost comes from the trajectory usage records, not from run.json alone.
    assert.ok(Math.abs(bundle.score.costUsd - 0.002) < 1e-9);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a tampered trajectory fails verification and the recomputed score refuses', async () => {
  const outDir = await tempDir('tamper');
  try {
    await runSuite({ suite: SUITE, games: [takeOrPass], agentFactory: takeFactory(), outDir });
    const jobs = planJobs(SUITE);
    const victim = trajectoryPath(outDir, jobs[0]);
    const trajectory = JSON.parse(await readFile(victim, 'utf8'));
    trajectory.steps[0].action = 'zzz';
    await writeFile(victim, JSON.stringify(trajectory, null, 2));

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.ok, false);
    const verdict = bundle.trajectories.find((v) => v.key === jobs[0].key);
    if (!verdict) assert.fail('the tampered episode has a verdict');
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reason && verdict.reason.length > 0);
    // Scoring refuses on the failed verification rather than scoring a lie.
    assert.equal(bundle.score, null);
    assert.match(String(bundle.scoreError), /fails verifyTrajectory/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a manifest-hash mismatch fails the bundle without touching trajectory verdicts', async () => {
  const outDir = await tempDir('hash');
  try {
    await runSuite({ suite: SUITE, games: [takeOrPass], agentFactory: takeFactory(), outDir });
    const runPath = path.join(outDir, 'run.json');
    const run = JSON.parse(await readFile(runPath, 'utf8'));
    run.suite.manifestSha256 = '0'.repeat(64);
    await writeFile(runPath, JSON.stringify(run, null, 2));

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.manifestHash.ok, false);
    assert.equal(bundle.ok, false);
    // The trajectories themselves still verify — the hash is the problem.
    assert.equal(bundle.scoreError, null);
    assert.ok(bundle.score);
    assert.equal(bundle.score.ranked, true);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a missing episode file is unranked, not refused', async () => {
  const outDir = await tempDir('missing');
  try {
    await runSuite({ suite: SUITE, games: [takeOrPass], agentFactory: takeFactory(), outDir });
    const jobs = planJobs(SUITE);
    await rm(trajectoryPath(outDir, jobs[1]));

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.ok, false);
    const verdict = bundle.trajectories.find((v) => v.key === jobs[1].key);
    if (!verdict) assert.fail('the missing episode has a verdict');
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.reason), /missing/);
    assert.ok(bundle.score);
    assert.equal(bundle.score.ranked, false);
    assert.match(String(bundle.score.unrankedReason), /missing episodes/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a stray trajectory-format file that no job owns fails the bundle', async () => {
  const outDir = await tempDir('stray');
  try {
    await runSuite({ suite: SUITE, games: [takeOrPass], agentFactory: takeFactory(), outDir });
    const strayPath = path.join(outDir, 'take-or-pass', 'main', 'zzz.json');
    await writeFile(
      strayPath,
      JSON.stringify({ format: TRAJECTORY_FORMAT, note: 'not a planned episode' })
    );

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.deepEqual(bundle.stray, ['take-or-pass/main/zzz.json']);
    assert.equal(bundle.ok, false);
    // Planned episodes still verify and score.
    assert.ok(bundle.score);
    assert.equal(bundle.score.ranked, true);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('verifyBundle refuses a directory with no suite.json', async () => {
  const outDir = await tempDir('empty');
  try {
    await assert.rejects(verifyBundle(outDir, [takeOrPass]), /no readable suite\.json/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

// Page sessions (`gauntlet page` output) — verified from the recorded
// model-session fixture, a real bridge log, so these cases stay offline.

const FIXTURE_LOG = fileURLToPath(new URL('../bridge/browser/fixtures/model-session-2048.json', import.meta.url));

/** @param {string} label */
async function tempPageDir(label) {
  return mkdtemp(path.join(tmpdir(), `gauntlet-bundle-page-${label}-`));
}

/** Writes page/<seed>.json plus page/run.json (the `gauntlet page`
 * provenance record, which is not itself a session log).
 *
 * @param {string} outDir
 * @param {((log: any) => void) | undefined} [tamper] Receives the parsed log
 *   before it is written.
 */
async function writePageSession(outDir, tamper) {
  await mkdir(path.join(outDir, 'page'), { recursive: true });
  const log = JSON.parse(await readFile(FIXTURE_LOG, 'utf8'));
  if (tamper) tamper(log);
  await writeFile(path.join(outDir, 'page', '11111.json'), JSON.stringify(log, null, 2) + '\n');
  await writeFile(
    path.join(outDir, 'page', 'run.json'),
    JSON.stringify({
      format: 'playkit-gauntlet-page-run/1',
      agent: { spec: 'model:openai-chat/stub', id: log.agent.id, track: log.agent.track },
      seed: 11111,
      logFile: 'page/11111.json',
      verify: { ok: true },
    }) + '\n'
  );
}

test('page sessions in a run bundle verify alongside trajectories without affecting scoring', async () => {
  const outDir = await tempPageDir('mixed');
  try {
    await runSuite({ suite: SUITE, games: [takeOrPass], agentFactory: takeFactory(), outDir });
    await writePageSession(outDir);

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.pageOnly, false);
    assert.equal(bundle.pageSessions.length, 1, 'page/run.json is provenance, not a session log');
    assert.equal(bundle.pageSessions[0].file, 'page/11111.json');
    assert.equal(bundle.pageSessions[0].ok, true);
    assert.equal(bundle.pageSessions[0].steps, 150);
    assert.equal(bundle.ok, true);
    // Scoring is trajectory business: page sessions ride along, un-scored.
    assert.ok(bundle.score);
    assert.equal(bundle.score.ranked, true);
    assert.equal(bundle.score.episodes, 2);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a standalone page-session bundle verifies with no suite manifest at all', async () => {
  const outDir = await tempPageDir('standalone');
  try {
    await writePageSession(outDir);

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.pageOnly, true);
    assert.equal(bundle.pageSessions.length, 1);
    assert.equal(bundle.pageSessions[0].ok, true);
    assert.equal(bundle.ok, true);
    assert.equal(bundle.run, null);
    assert.deepEqual(bundle.stray, []);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('a tampered page session fails verification at the offending step', async () => {
  const outDir = await tempPageDir('tamper');
  try {
    await writePageSession(outDir, (log) => {
      // Flip one boardBefore cell of the first step: the replay starts from
      // the log's own start board and must refuse the mismatch at step 0.
      log.steps[0].boardBefore[0][0] = log.steps[0].boardBefore[0][0] === 0 ? 2 : 0;
    });

    const bundle = await verifyBundle(outDir, [takeOrPass]);
    assert.equal(bundle.ok, false);
    assert.equal(bundle.pageSessions.length, 1);
    const verdict = bundle.pageSessions[0];
    assert.equal(verdict.ok, false);
    assert.match(String(verdict.reason), /verifyBridgeLog \(step 0\)/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
