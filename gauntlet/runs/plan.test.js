/**
 * Plan tests: manifest to episode jobs, stable keys, manifest hashing. Output
 * goes nowhere; no filesystem use.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSuite } from '../scoring/suite.js';
import { countdown, takeOrPass } from '../scoring/fixtures.js';

import { jobKey, manifestSha256, planJobs, normalizeGames } from './plan.js';
import { trajectoryPath } from './fsutil.js';

const SUITE = buildSuite([takeOrPass, countdown], { split: 'public' });

test('planJobs expands a manifest into jobs in manifest order with stable keys', () => {
  const jobs = planJobs(SUITE);
  // take-or-pass: 1 tier x 2 seeds; countdown: 2 tiers x 4 seeds.
  assert.equal(jobs.length, 10);
  assert.equal(jobs[0].key, 'take-or-pass/main/take-or-pass/main/public/0');
  assert.equal(jobs[0].gameId, 'take-or-pass');
  assert.equal(jobs[0].tierId, 'main');
  assert.equal(jobs[0].seed, 'take-or-pass/main/public/0');
  assert.equal(jobs[0].split, 'public');
  // Manifest order: all take-or-pass jobs before any countdown job.
  assert.equal(jobs[2].gameId, 'countdown');
  assert.equal(jobs[2].tierId, 'reference-par');
  assert.ok(jobs.every((j) => j.key === jobKey(j.gameId, j.tierId, j.seed)));
  // Stable across calls.
  assert.deepEqual(planJobs(SUITE), jobs);
});

test('planJobs keeps tier order by rank within a game', () => {
  const jobs = planJobs(SUITE).filter((j) => j.gameId === 'countdown');
  const tiers = [...new Set(jobs.map((j) => j.tierId))];
  assert.deepEqual(tiers, ['reference-par', 'optimal-par']);
});

test('manifestSha256 is stable and moves when the manifest changes', () => {
  const a = manifestSha256(SUITE);
  const b = manifestSha256(buildSuite([takeOrPass, countdown], { split: 'public' }));
  assert.equal(a, b); // identical manifests hash identically
  const other = manifestSha256(buildSuite([countdown, takeOrPass], { split: 'public' }));
  assert.notEqual(a, other); // different games (or order) hash differently
  const evalSplit = manifestSha256(buildSuite([takeOrPass], { split: 'eval', salt: 's3cret' }));
  assert.notEqual(a, evalSplit);
});

test('trajectoryPath nests game/tier/seed under the run directory', () => {
  const [job] = planJobs(SUITE);
  const p = trajectoryPath('/tmp/run', job);
  assert.ok(p.startsWith('/tmp/run/'));
  assert.ok(p.endsWith(`${job.seed}.json`));
  assert.ok(p.includes(`${job.gameId}/${job.tierId}/`));
});

test('normalizeGames accepts arrays, Maps and records, and refuses gaps', () => {
  const games = [takeOrPass, countdown];
  assert.deepEqual(
    [...normalizeGames(games, SUITE).keys()].sort(),
    ['countdown', 'take-or-pass']
  );
  assert.equal(normalizeGames(new Map(games.map((g) => [g.spec.id, g])), SUITE).size, 2);
  assert.equal(
    normalizeGames({ 'take-or-pass': takeOrPass, countdown }, SUITE).size,
    2
  );
  assert.throws(() => normalizeGames([takeOrPass], SUITE), /no implementation/);
  assert.throws(() => normalizeGames([], SUITE), /no implementation/);
});
