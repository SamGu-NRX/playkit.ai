/**
 * Unit tests for the extracted analysis core (`analysis-lib.mjs`).
 *
 * The two properties pinned here are preregistered (PREREGISTRATION.md):
 *
 * 1. One resampling stream per comparison, keyed by the comparison key ALONE —
 *    the analyzer used to append `/reading` and `/profile` to the seed, so
 *    cross-profile CI differences carried independent resampling noise instead
 *    of being re-readings of the same resamples. The stream must not depend on
 *    the profile (Codex #4301264693).
 * 2. Label-swap exactness: the same comparison key with negated per-episode
 *    diffs negates D and BOTH interval bounds exactly — no re-resampling.
 *
 * Plus: the out-of-suite filter the score() mirror must apply (the analyzer
 * documented out-of-suite episodes as ignored but fed them to the mirror,
 * Codex #4301264694), and the invalid-adjusted reading arithmetic.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOTSTRAP_DRAWS,
  cell,
  compare,
  episodeScore,
  readEpisode,
  suiteKeysOf,
  summarize,
  verdict,
} from './analysis-lib.mjs';

/** A synthetic suite: two efficiency tiers and one outcome tier. */
const suite = {
  id: 'unit',
  games: [
    { id: 'g1', tiers: [{ id: 't1', scoring: 'efficiency', seeds: ['s1', 's2'] }, { id: 't2', scoring: 'efficiency', seeds: ['s1', 's2'] }] },
    { id: 'g2', tiers: [{ id: 't1', scoring: 'outcome', seeds: ['s1'] }] },
  ],
};

function bundleFrom(scores, efficiencyActions = {}) {
  const byKey = new Map();
  const ends = new Map();
  for (const [key, value] of Object.entries(scores)) {
    // A minimal trajectory-like record; compare() only reads end.outcome /
    // agent.seat / game/tier/seed through episodeScore. efficiencyActions
    // marks episodes as SOLVED efficiency episodes with the given
    // agentActions, so episodeScore yields (par/agentActions)^2 instead of
    // 0 — any fixture that must produce a nonzero statistic needs this; an
    // all-unsolved fixture makes every diff 0 and both intervals [0, 0],
    // which passes stream-keying pins vacuously (greptile r4305289845).
    const [game, tier, seed] = key.split('/');
    const actions = efficiencyActions[key];
    const solvedEfficiency = Number.isInteger(actions) && actions > 0;
    byKey.set(key, {
      game: { id: game, version: '9.9.9' },
      tier,
      seed,
      agent: { seat: 0 },
      end: {
        outcome: { normalized: [value], solved: solvedEfficiency, par: 1 },
        agentActions: solvedEfficiency ? actions : 3,
        invalidActions: 0,
      },
    });
    ends.set(key, { invalidActions: 0, agentActions: solvedEfficiency ? actions : 3 });
  }
  return { byKey, ends };
}

test('the bootstrap stream is keyed by the comparison key alone — profiles share one stream', () => {
  // Solved efficiency episodes with distinct action counts: the score
  // (par/agentActions)^2 is nonzero and seed-dependent, so the diffs are not
  // all zero and the interval is not [0, 0]. FOUR seeds per tier with
  // mixed-sign diffs put the interval endpoints INSIDE the resample
  // distribution: the extreme atom of an n-seed resample carries (1/n)^n
  // mass, so with n = 3 the 2.5%/97.5% endpoints still pin to the extreme
  // atoms (3.7% > 2.5%) and every stream yields the same interval — the pin
  // would pass vacuously. At n = 4 (0.4% mass) the endpoints move when the
  // stream moves. Nondegeneracy is asserted FIRST — an all-zero fixture
  // passes everything against even a profile-dependent stream, the exact
  // defect this pin exists for (greptile r4305289845).
  const suite4 = {
    id: 'unit-4seed',
    games: [
      { id: 'g1', tiers: [
        { id: 't1', scoring: 'efficiency', seeds: ['s1', 's2', 's3', 's4'] },
        { id: 't2', scoring: 'efficiency', seeds: ['s1', 's2', 's3', 's4'] },
      ] },
    ],
  };
  const a = bundleFrom(
    { 'g1/t1/s1': 1, 'g1/t1/s2': 0.4, 'g1/t1/s3': 0.9, 'g1/t1/s4': 0.6, 'g1/t2/s1': 0.8, 'g1/t2/s2': 0.2, 'g1/t2/s3': 0.5, 'g1/t2/s4': 0.7 },
    { 'g1/t1/s1': 1, 'g1/t1/s2': 2, 'g1/t1/s3': 4, 'g1/t1/s4': 3, 'g1/t2/s1': 1, 'g1/t2/s2': 3, 'g1/t2/s3': 2, 'g1/t2/s4': 5 }
  );
  const b = bundleFrom(
    { 'g1/t1/s1': 0.2, 'g1/t1/s2': 0.1, 'g1/t1/s3': 0.3, 'g1/t1/s4': 0.5, 'g1/t2/s1': 0.1, 'g1/t2/s2': 0.3, 'g1/t2/s3': 0.2, 'g1/t2/s4': 0.4 },
    { 'g1/t1/s1': 2, 'g1/t1/s2': 3, 'g1/t1/s3': 2, 'g1/t1/s4': 4, 'g1/t2/s1': 4, 'g1/t2/s2': 2, 'g1/t2/s3': 2, 'g1/t2/s4': 3 }
  );
  // The same pair on two profiles: efficiency tiers score identically under
  // every profile, so the STATISTIC is identical and so must the interval be.
  const rhae = compare(a, b, suite4, 'rhae-v1', undefined, 'a~vs~b', 'raw');
  const squared = compare(a, b, suite4, 'squared-outcome', undefined, 'a~vs~b', 'raw');
  assert.notEqual(rhae.D, 0, 'the fixture must produce a nonzero statistic');
  assert.notEqual(rhae.ci[0], rhae.ci[1], 'the fixture must produce a nondegenerate interval');
  assert.equal(rhae.D, squared.D);
  assert.deepEqual(rhae.ci, squared.ci);
});

test('the bootstrap stream does not depend on the reading', () => {
  const diffs = { 'g1/t1': [0.5, -0.2, 0.9, 0.1], 'g1/t2': [0.3, 0.7] };
  const raw = summarize(diffs, [], 'a~vs~b', 'rhae-v1', 0);
  const adjusted = summarize(diffs, [], 'a~vs~b', 'rhae-v1', 1);
  assert.deepEqual(raw.ci, adjusted.ci);
  assert.ok(raw.ci[0] !== raw.ci[1], 'a nondegenerate interval must not collapse');
  assert.equal(raw.sharedTiers, 2);
});

test('label swap negates D and both interval bounds exactly', () => {
  const diffs = { 'g1/t1': [0.5, -0.2, 0.9, 0.1], 'g1/t2': [0.3, 0.7, -1.0] };
  const forward = summarize(diffs, [], 'a~vs~b', 'rhae-v1', 1);
  const swapped = summarize({ 'g1/t1': diffs['g1/t1'].map((x) => -x), 'g1/t2': diffs['g1/t2'].map((x) => -x) }, [], 'a~vs~b', 'rhae-v1', 1);
  assert.equal(swapped.D, -forward.D);
  assert.deepEqual(swapped.ci, [-forward.ci[1], -forward.ci[0]]);
  assert.equal(swapped.signAgree, forward.signAgree);
});

test('compare() honors the shared stream through the full comparison path', () => {
  const a = bundleFrom({ 'g1/t1/s1': 1, 'g1/t1/s2': 0.6, 'g2/t1/s1': 1 });
  const b = bundleFrom({ 'g1/t1/s1': 0.1, 'g1/t1/s2': 0.2, 'g2/t1/s1': 0 });
  const one = compare(a, b, suite, 'rhae-v1', undefined, 'x~vs~y', 'raw');
  const two = compare(a, b, suite, 'rhae-v1', undefined, 'x~vs~y', 'invalid-adjusted');
  // invalid-adjusted coincides here (agentActions 3, invalidActions 0) — with
  // one stream the readings must agree EXACTLY, not merely approximately.
  assert.deepEqual(one.ci, two.ci);
  assert.equal(one.D, two.D);
});

test('suiteKeysOf covers exactly the suite episodes — the mirror-feed filter', () => {
  const keys = suiteKeysOf(suite);
  assert.ok(keys.has('g1/t1/s1'));
  assert.ok(keys.has('g2/t1/s1'));
  for (const foreign of ['g3/t9/s1', 'g1/t9/s1', 'g2/t1/s2', 'g1/t1/s3']) {
    assert.equal(keys.has(foreign), false, `${foreign} is outside the suite`);
  }
});

test('compare() drops tiers without shared seeds instead of fabricating data', () => {
  const a = bundleFrom({ 'g1/t1/s1': 1, 'g1/t1/s2': 1 });
  const b = bundleFrom({ 'g1/t1/s3': 0, 'g1/t1/s4': 1 });
  const r = compare(a, b, suite, 'rhae-v1', undefined, 'a~vs~b', 'raw');
  assert.equal(r.sharedTiers, 0);
  assert.deepEqual(r.ci, null);
  assert.equal(verdict(r), 'NO_DATA');
});

test('the invalid-adjusted reading prices invalid actions and floors at agentActions=0', () => {
  assert.equal(readEpisode({ e: 1, invalidActions: 0, agentActions: 3 }, 'outcome', 'invalid-adjusted'), 1);
  assert.ok(Math.abs(readEpisode({ e: 1, invalidActions: 1, agentActions: 4 }, 'outcome', 'invalid-adjusted') - 0.75) < 1e-12);
  assert.equal(readEpisode({ e: 1, invalidActions: 2, agentActions: 0 }, 'outcome', 'invalid-adjusted'), 0);
  // raw is untouched; efficiency tiers coincide by construction.
  assert.equal(readEpisode({ e: 0.5, invalidActions: 3, agentActions: 3 }, 'outcome', 'raw'), 0.5);
  assert.equal(readEpisode({ e: 0.5, invalidActions: 3, agentActions: 3 }, 'efficiency', 'invalid-adjusted'), 0.5);
});

test('episodeScore throws on a solved efficiency trajectory without a usable par', () => {
  const tier = { id: 't1', scoring: 'efficiency', parKind: 'reference', seeds: [] };
  const trajectory = {
    game: { id: 'g1', version: '9.9.9' },
    tier: 't1',
    seed: 's1',
    agent: { seat: 0 },
    end: { agentActions: 3, invalidActions: 0, outcome: { solved: true } },
  };
  assert.throws(() => episodeScore(tier, trajectory, 'rhae-v1', undefined), /claims solved with par/);
  const capped = { ...trajectory, end: { agentActions: 2, invalidActions: 0, outcome: { solved: true, par: 1 } } };
  assert.equal(episodeScore(tier, capped, 'rhae-v1', undefined).e, 0.25);
});

test('the cell output carries the verdict, rounded D, and rounded interval', () => {
  const diffs = { 'g1/t1': Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? 1 : -0.1)) };
  const r = summarize(diffs, [], 'a~vs~b', 'rhae-v1', 1);
  const c = cell(r);
  assert.equal(c.D, Math.round(r.D * 1e6) / 1e6);
  assert.deepEqual(c.ci95, [Math.round(r.ci[0] * 1e6) / 1e6, Math.round(r.ci[1] * 1e6) / 1e6]);
  assert.ok(['SEPARATED', 'NOT_SEPARATED'].includes(c.verdict));
  assert.equal(BOOTSTRAP_DRAWS, 10_000);
});
