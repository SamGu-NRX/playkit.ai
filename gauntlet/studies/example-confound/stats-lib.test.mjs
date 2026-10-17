/**
 * Unit tests for the example-confound statistics helpers (`stats-lib.mjs`).
 *
 * Pins the PR #104 review fixes: known-prefix arm parsing (the old regex
 * misparsed the connect4 control), per-tier floor selection, and the H2
 * tie-corrected Spearman over the three per-model means.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armFromSuiteId, floorFor, pairBySeed, tieCorrectedSpearman } from './stats-lib.mjs';

const ARMS = ['corrected-official', 'corrected-assisted', 'corrected-7b', 'connect4-neutral'];

// The real committed suite ids.
const IDS = {
  official: 'gauntlet-public-example-confound-corrected-official-mastermind-mini-8',
  assisted: 'gauntlet-public-example-confound-corrected-assisted-mastermind-mini-8',
  sevenB: 'gauntlet-public-example-confound-corrected-7b-mastermind-mini-8',
  connect4: 'gauntlet-public-example-confound-connect4-neutral-connect4-ladder-1-12',
};

test('arm parsing reads every committed suite id, including the connect4 control', () => {
  assert.equal(armFromSuiteId(IDS.official, ARMS), 'corrected-official');
  assert.equal(armFromSuiteId(IDS.assisted, ARMS), 'corrected-assisted');
  assert.equal(armFromSuiteId(IDS.sevenB, ARMS), 'corrected-7b');
  // The old regex returned 'connect4-neutral-connect4' here.
  assert.equal(armFromSuiteId(IDS.connect4, ARMS), 'connect4-neutral');
});

test('arm parsing returns null for foreign ids and unknown arms', () => {
  assert.equal(armFromSuiteId('gauntlet-public-separation-pilot-smallest-8', ARMS), null);
  assert.equal(armFromSuiteId('gauntlet-public-example-confound-mystery-arm-mastermind-mini-8', ARMS), null);
  assert.equal(armFromSuiteId(IDS.connect4, ['corrected-official']), null);
});

test('floor selection follows the run tier, never a hardcoded tier', () => {
  const floors = { mastermindMini: { mean: 0.0298 }, connect4Ladder1: { mean: 0.416667 } };
  assert.equal(floorFor(floors, 'mastermind', 'mini'), floors.mastermindMini);
  assert.equal(floorFor(floors, 'connect4', 'ladder-1'), floors.connect4Ladder1);
  assert.equal(floorFor(floors, 'connect4', 'ladder-0'), null);
  assert.equal(floorFor(floors, 'mastermind', 'wide'), null);
  assert.equal(floorFor({ connect4Ladder1: null }, 'connect4', 'ladder-1'), null);
});

test('tie-corrected Spearman: monotone orders give +-1', () => {
  const sizes = [0.5, 1.5, 7];
  const up = [0.1, 0.5, 0.9].map((y, i) => ({ x: sizes[i], y }));
  const down = [0.9, 0.5, 0.1].map((y, i) => ({ x: sizes[i], y }));
  const { rho: upRho } = tieCorrectedSpearman(up);
  const { rho: downRho } = tieCorrectedSpearman(down);
  // Pearson-on-ranks is the tie-corrected form; float rounding keeps it just
  // off the exact ±1 the no-tie closed form would give.
  assert.ok(Math.abs(upRho - 1) < 1e-12, `rho ${upRho}`);
  assert.ok(Math.abs(downRho + 1) < 1e-12, `rho ${downRho}`);
});
test('tie-corrected Spearman: tied means get mid-ranks (the actual H2 outcome)', () => {
  // 0.5B and 1.5B tie at 0.75, 7B lower at 0.667 - REPORT's connect4 finding.
  const points = [
    { x: 0.5, y: 0.75 },
    { x: 1.5, y: 0.75 },
    { x: 7, y: 0.667 },
  ];
  const { rho, tiedX } = tieCorrectedSpearman(points);
  assert.equal(tiedX, false);
  // tiedY means ALL y ranks identical (zero variance), not merely "has ties";
  // two tied means keep y variance, so the correlation stays defined.
  assert.equal(tieCorrectedSpearman(points).tiedY, false);
  // Mid-ranks: x [1,2,3]; y [2.5,2.5,1] - the two small models tie at the TOP
  // (0.75) and the 7B sits below (0.667), so the rank correlation is negative:
  // Pearson = -1.5/sqrt(2*1.5).
  assert.ok(Math.abs(rho + 1.5 / Math.sqrt(3)) < 1e-12, `rho ${rho}`);
});

test('tie-corrected Spearman: undefined when a side is all ties or too short', () => {
  assert.equal(tieCorrectedSpearman([]).rho, null);
  assert.equal(tieCorrectedSpearman([{ x: 1, y: 2 }]).rho, null);
  const flat = [
    { x: 0.5, y: 0.75 },
    { x: 1.5, y: 0.75 },
    { x: 7, y: 0.75 },
  ];
  const { rho, tiedY } = tieCorrectedSpearman(flat);
  assert.equal(rho, null);
  assert.equal(tiedY, true);
});

test('pairBySeed intersects seeds and diffs b - a, sorted', () => {
  const a = [
    { seed: 'public/0', score: 0.5 },
    { seed: 'public/1', score: 0.25 },
    { seed: 'public/7', score: 1 },
  ];
  const b = [
    { seed: 'public/0', score: 0.75 },
    { seed: 'public/1', score: 0.25 },
    { seed: 'public/2', score: 9 },
  ];
  assert.deepEqual(pairBySeed(a, b), [
    { seed: 'public/0', diff: 0.25 },
    { seed: 'public/1', diff: 0 },
  ]);
  assert.deepEqual(pairBySeed(b, a), [
    { seed: 'public/0', diff: -0.25 },
    { seed: 'public/1', diff: 0 },
  ]);
});
