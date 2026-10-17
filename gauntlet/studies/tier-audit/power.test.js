import test from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapCi95, mean, powerAtN, sampleSd, seedsNeeded } from './lib.mjs';

test('zero-variance gap resolves at the minimum seed count', () => {
  const diffs = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
  const result = seedsNeeded(diffs, 'test/zero-variance');
  assert.equal(result.needed, 2);
  assert.equal(result.powerAt12, 1);
});

test('identical distributions never resolve within the cap', () => {
  const result = seedsNeeded([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'test/identical');
  assert.equal(result.needed, null);
  assert.equal(result.powerAt12, 0);
});

test('seed requirement is deterministic for the same inputs and seed', () => {
  const diffs = [0.4, -0.1, 0.7, 0.2, 0.9, 0.1, 0.5, -0.2, 0.6, 0.3, 0.8, 0.0];
  const a = seedsNeeded(diffs, 'test/determinism');
  const b = seedsNeeded(diffs, 'test/determinism');
  assert.deepEqual(a, b);
});

test('power rises with seed count and saturates below one for noisy gaps', () => {
  const diffs = [0.3, -0.05, 0.6, 0.15, 0.8, 0.0, 0.45, -0.1, 0.55, 0.25, 0.7, 0.05];
  const low = powerAtN(4, diffs, 'test/monotonic');
  const high = powerAtN(48, diffs, 'test/monotonic');
  assert.ok(high >= low, `power should not fall as n grows: ${low} -> ${high}`);
  assert.ok(powerAtN(48, diffs, 'test/monotonic') >= 0.8);
});

test('bootstrap CI of a constant sample is a point interval', () => {
  assert.deepEqual(bootstrapCi95([0.7, 0.7, 0.7, 0.7], 'test/ci-constant'), [0.7, 0.7]);
});

test('bootstrap CI is deterministic and brackets the mean', () => {
  const values = [0.2, 0.9, 0.4, 0.1, 0.8, 0.5, 0.3, 0.6];
  const a = bootstrapCi95(values, 'test/ci-determinism');
  const b = bootstrapCi95(values, 'test/ci-determinism');
  assert.deepEqual(a, b);
  const m = mean(values);
  assert.ok(a[0] <= m && m <= a[1]);
});

test('sampleSd is zero for a constant sample and defined for n = 2', () => {
  assert.equal(sampleSd([1, 1, 1, 1]), 0);
  assert.equal(sampleSd([1]), 0);
  assert.equal(sampleSd([0, 2]), Math.SQRT2);
});
