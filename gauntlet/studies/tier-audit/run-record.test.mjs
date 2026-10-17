/**
 * The luck-dominated flag and the run-record integrity checks, pinned
 * against the COMMITTED audit data: the full interval-overlap predicate
 * must leave the four currently flagged rows flagged and every other row
 * unflagged (the one-sided predicate it replaces agreed with full overlap
 * on all 54 rows with both intervals — this test keeps that true), and the
 * committed run.json records must satisfy the manifest/agent identity the
 * verifier now checks (Codex #4301264696).
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manifestSha256 } from '../../runs/plan.js';
import { intervalsOverlap } from './lib.mjs';
import { runRecordFailures, tierSuite } from './audit-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('intervalsOverlap requires both bounds, not just one endpoint inside the other', () => {
  // [0, 1] low bound under [2, 3] high bound: the one-sided check flagged
  // this pair "luck-dominated"; full overlap refuses.
  assert.equal(intervalsOverlap([0, 1], [2, 3]), false);
  assert.equal(intervalsOverlap([-3, -2], [0, 1]), false);
  assert.equal(intervalsOverlap([-0.2, 0.4], [-0.1, 0.3]), true);
  assert.equal(intervalsOverlap([-1, 0], [0, 1]), true);
});

test('the full overlap predicate leaves every committed luck-dominated flag unchanged', async () => {
  const tiers = JSON.parse(await readFile(join(here, 'tiers.json'), 'utf8'));
  let bothIntervals = 0;
  for (const row of tiers.rows) {
    const cells = row.cells ?? {};
    const expert = cells['dial-0']?.['rhae-v1']?.ci95;
    const random = cells['dial-1']?.['rhae-v1']?.ci95;
    const flags = new Set(row.flags ?? []);
    if (expert && random) {
      bothIntervals += 1;
      const flagged = flags.has('luck-dominated');
      assert.equal(
        intervalsOverlap(expert, random),
        flagged,
        `${row.game}/${row.tier}: overlap=${intervalsOverlap(expert, random)} but flag=${flagged}`
      );
    } else {
      assert.equal(flags.has('luck-dominated'), false, `${row.game}/${row.tier} flagged without both intervals`);
    }
  }
  assert.ok(bothIntervals >= 50, `expected the full suite of paired tiers, saw ${bothIntervals}`);
});

test('committed run.json records satisfy the manifest and agent identity checks', async () => {
  // One committed bundle per check shape: a no-skill cell (id verbatim) and
  // dial cells whose ids embed per-game expert ids with the p encoding.
  const samples = [
    ['2048', 't1024', 'copy-example'],
    ['2048', 't1024', 'dial-0'],
    ['chess', 'sand', 'dial-05'],
    ['go', 'ladder-1', 'dial-1'],
    ['sokoban', 'one-box', 'dial-05'],
  ];
  for (const [gameId, tierId, cell] of samples) {
    const run = JSON.parse(
      await readFile(join(here, 'bundles', gameId, tierId, cell, 'run.json'), 'utf8')
    );
    const { suite } = tierSuite(gameId, tierId);
    const expected = manifestSha256(suite);
    assert.deepEqual(
      runRecordFailures(run, cell, expected),
      [],
      `${gameId}/${tierId}/${cell}: committed record must pass its own cell's checks`
    );
  }
});

test('runRecordFailures catches foreign manifests and foreign agents', () => {
  const good = {
    suite: { id: 'tier-audit-2048-t1024', manifestSha256: 'a'.repeat(64) },
    agent: { id: 'dial-engine-p0', track: 'baseline' },
  };
  assert.deepEqual(runRecordFailures(good, 'dial-0', 'a'.repeat(64)), []);
  assert.deepEqual(runRecordFailures(good, 'copy-example', 'b'.repeat(64)), [
    `run.json suite manifest ${'a'.repeat(12)} != expected ${'b'.repeat(12)}`,
    'run.json agent id dial-engine-p0 does not match the copy-example cell',
  ]);
  const swapped = { ...good, agent: { id: 'dial-2048-engine-d2-p100' } };
  assert.deepEqual(
    runRecordFailures(swapped, 'dial-0', 'a'.repeat(64)),
    ['run.json agent id dial-2048-engine-d2-p100 does not match the dial-0 cell'],
    'a p100 (random) record pasted into a dial-0 (expert) cell is foreign'
  );
});
