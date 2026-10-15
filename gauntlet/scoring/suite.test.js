/**
 * Tests for the suite manifest builder (scoring/suite.js).
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSuite, SUITE_FORMAT } from './suite.js';
import { publicSeed } from '../core/seeds.js';
import { evalSeed, saltCommitment } from '../core/seeds-node.js';
import { countdown, takeOrPass } from './fixtures.js';

/** @import { Game } from '../core/types.js' */

test('public suite: format, shape, and public seed strings', () => {
  const suite = buildSuite([countdown, takeOrPass], { split: 'public' });
  assert.equal(suite.format, SUITE_FORMAT);
  assert.equal(suite.id, 'playkit-gauntlet-public');
  assert.equal(suite.split, 'public');
  assert.equal(suite.saltCommitment, null);
  assert.equal(suite.games.length, 2);

  const [countdownEntry, topEntry] = suite.games;
  assert.equal(countdownEntry.id, 'countdown');
  assert.equal(countdownEntry.version, '1.0.0');
  assert.deepEqual(countdownEntry.requires, []);
  assert.equal(countdownEntry.tiers.length, 2);
  const [reference, optimal] = countdownEntry.tiers;
  assert.deepEqual(
    { id: reference.id, rank: reference.rank, scoring: reference.scoring, parKind: reference.parKind },
    { id: 'reference-par', rank: 1, scoring: 'efficiency', parKind: 'reference' }
  );
  assert.equal(reference.seeds.length, 4);
  assert.deepEqual(
    reference.seeds,
    [0, 1, 2, 3].map((i) => publicSeed('countdown', 'reference-par', i))
  );
  assert.deepEqual(
    { id: optimal.id, rank: optimal.rank, scoring: optimal.scoring, parKind: optimal.parKind },
    { id: 'optimal-par', rank: 2, scoring: 'efficiency', parKind: 'optimal' }
  );
  assert.deepEqual(topEntry.tiers[0], {
    id: 'main',
    rank: 1,
    scoring: 'outcome',
    seeds: [
      publicSeed('take-or-pass', 'main', 0),
      publicSeed('take-or-pass', 'main', 1),
    ],
  });
  // Outcome tiers carry no parKind.
  assert.equal(topEntry.tiers[0].parKind, undefined);
});

test('public suite honors a custom id', () => {
  const suite = buildSuite([countdown], { split: 'public', id: 'gauntlet-smoke-2026-10' });
  assert.equal(suite.id, 'gauntlet-smoke-2026-10');
});

test('eval suite: salted seeds and the salt commitment, without storing the salt', () => {
  const suite = buildSuite([countdown], { split: 'eval', salt: 'not-the-real-salt' });
  assert.equal(suite.split, 'eval');
  assert.equal(suite.saltCommitment, saltCommitment('not-the-real-salt'));
  assert.match(suite.saltCommitment, /^[0-9a-f]{64}$/);

  const tier = suite.games[0].tiers[0];
  assert.equal(tier.seeds.length, 4);
  assert.deepEqual(
    tier.seeds,
    [0, 1, 2, 3].map((i) => evalSeed('countdown', tier.id, i, 'not-the-real-salt'))
  );
  for (const seed of tier.seeds) {
    assert.match(seed, /^countdown\/reference-par\/eval\/[0-9a-f]{16}$/);
  }
  // Eval seeds differ from public seeds.
  assert.notDeepEqual(tier.seeds, [0, 1, 2, 3].map((i) => publicSeed('countdown', tier.id, i)));
});

test('eval split without a salt is refused', () => {
  assert.throws(() => buildSuite([countdown], { split: 'eval' }), /suite\.js.*salt/);
});

test('public split with a salt is refused', () => {
  assert.throws(
    () => buildSuite([countdown], { split: 'public', salt: 'oops' }),
    /suite\.js.*salt/
  );
});

test('unknown split is refused', () => {
  assert.throws(
    () =>
      buildSuite([countdown], { split: /** @type {*} */ ('semi-private') }),
    /suite\.js.*split/
  );
});

test('duplicate game ids are refused', () => {
  assert.throws(() => buildSuite([countdown, countdown], { split: 'public' }), /duplicate game id/);
});

test('non-consecutive tier ranks are refused', () => {
  /** @type {*} */
  const badRanks = {
    spec: {
      ...countdown.spec,
      id: 'bad-ranks',
      tiers: [
        { ...countdown.spec.tiers[0], id: 'a', rank: 1 },
        { ...countdown.spec.tiers[0], id: 'b', rank: 3 },
      ],
    },
  };
  assert.throws(() => buildSuite([badRanks], { split: 'public' }), /tier-ranks.*rank 3/);
});

test('zero public seeds are refused', () => {
  /** @type {*} */
  const noSeeds = {
    spec: {
      ...countdown.spec,
      id: 'no-seeds',
      tiers: [{ ...countdown.spec.tiers[0], publicSeeds: 0 }],
    },
  };
  assert.throws(() => buildSuite([noSeeds], { split: 'public' }), /tier-seeds/);
});

test('efficiency tier without parKind is refused', () => {
  /** @type {*} */
  const noParKind = {
    spec: {
      ...countdown.spec,
      id: 'no-par-kind',
      tiers: [{ ...countdown.spec.tiers[0], parKind: /** @type {*} */ (undefined) }],
    },
  };
  assert.throws(() => buildSuite([noParKind], { split: 'public' }), /parKind/);
});

test('take-or-pass builds a clean single-tier public suite', () => {
  const suite = buildSuite([takeOrPass], { split: 'public' });
  assert.equal(suite.games[0].id, 'take-or-pass');
  assert.equal(suite.games[0].tiers[0].seeds.length, 2);
});
