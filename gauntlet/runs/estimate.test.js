/**
 * Estimate tests, against the bundled fixture games and the real engine game.
 * The engine-probe basis is checked against an independently replayed
 * baseline (the same engine, measured directly via the core runner), the par
 * basis against `countdownStart`-derived pars, and the none basis against
 * explicit unknowns. Temp directories only.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { tictactoe } from '../games/tictactoe/index.js';
import { countdown, countdownStart, takeOrPass } from '../scoring/fixtures.js';
import { buildSuite } from '../scoring/suite.js';
import { runEpisode } from '../core/runner.js';

import { manifestSha256 } from './plan.js';
import { estimateSuite, estimateToMarkdown, resolveBaseline, writeEstimate } from './estimate.js';

const PRICES = {
  'acme/alpha': { inputPerMTok: 3, outputPerMTok: 15, source: 'test', checked: '2026-10-15' },
};

test('engine-probe basis: tictactoe, low = an independently replayed baseline mean', async () => {
  const suite = buildSuite([tictactoe], { split: 'public' });
  const estimate = await estimateSuite({ suite, games: [tictactoe] });

  const tier = tictactoe.spec.tiers.find((t) => t.id === 'perfect-opponent');
  assert.ok(tier, 'tictactoe has the perfect-opponent tier');
  assert.equal(estimate.jobs.length, 8);

  // Independent measurement: replay the engine baseline directly through the
  // core runner on the same two seeds the estimate probes.
  const probeSeeds = suite.games[0].tiers[0].seeds.slice(0, 2);
  assert.equal(probeSeeds.length, 2);
  let sum = 0;
  for (const seed of probeSeeds) {
    const seat = tictactoe.agentSeat(tier, seed);
    const baseline = tictactoe.opponent(tier, seed, seat);
    const trajectory = await runEpisode({ game: tictactoe, tierId: tier.id, seed, agent: baseline });
    sum += trajectory.end.agentActions;
  }
  const mean = sum / probeSeeds.length;

  for (const job of estimate.jobs) {
    assert.equal(job.basis, 'engine-probe');
    assert.ok(Math.abs(/** @type {number} */ (job.callsLow) - mean) < 1e-9, `callsLow ${job.callsLow} vs measured ${mean}`);
    assert.equal(job.callsHigh, tier.maxActions);
    // No prices given: every USD figure stays unknown rather than guessed.
    assert.equal(job.usdLow, null);
    assert.equal(job.usdHigh, null);
    assert.match(/** @type {string} */ (job.note), /engine baseline/);
  }
  assert.equal(estimate.suite.manifestSha256, manifestSha256(suite));
  assert.equal(estimate.totals.callsHigh, 8 * tier.maxActions);
  assert.equal(estimate.totals.callsLow, 8 * mean);
  assert.equal(estimate.totals.usdLow, null);
});

test('par basis: countdown, low = the per-seed par from state.par', async () => {
  const suite = buildSuite([countdown], { split: 'public' });
  const estimate = await estimateSuite({ suite, games: [countdown] });

  assert.equal(estimate.jobs.length, 8);
  for (const job of estimate.jobs) {
    assert.equal(job.basis, 'par');
    const start = countdownStart(job.seed);
    const par = job.tierId === 'optimal-par' ? Math.ceil(start / 2) : start;
    assert.equal(job.callsLow, par);
    assert.equal(job.callsHigh, 60);
    assert.match(/** @type {string} */ (job.note), /par/);
  }
  assert.equal(estimate.totals.usdLow, null);
  assert.equal(estimate.totals.callsHigh, 8 * 60);
});

test('none basis: take-or-pass reports explicit unknowns', async () => {
  const suite = buildSuite([takeOrPass], { split: 'public' });
  const estimate = await estimateSuite({ suite, games: [takeOrPass] });

  assert.equal(estimate.jobs.length, 2);
  for (const job of estimate.jobs) {
    assert.equal(job.basis, 'none');
    assert.equal(job.callsLow, null);
    assert.equal(job.callsHigh, 5);
    assert.equal(job.note, null);
  }
  assert.equal(estimate.totals.callsLow, null);
  assert.equal(estimate.totals.usdHigh, null);

  // Markdown renders the unknowns as em dashes, not invented numbers.
  const md = estimateToMarkdown(estimate);
  assert.match(md, /# Gauntlet run estimate/);
  assert.match(md, /—/);
  assert.match(md, /Estimate, not a measurement/);
});

test('pricing: a usable entry prices low and high; a wrong key stays unpriced', async () => {
  const suite = buildSuite([countdown], { split: 'public' });
  const estimate = await estimateSuite({
    suite,
    games: [countdown],
    prices: PRICES,
    pricingKey: 'acme/alpha',
  });
  assert.equal(estimate.pricing.priced, true);
  assert.equal(estimate.pricing.key, 'acme/alpha');
  for (const job of estimate.jobs) {
    assert.ok(job.usdLow !== null && job.usdLow > 0, `usdLow ${job.usdLow} should price the par calls`);
    assert.ok(job.usdHigh !== null && job.usdHigh > 0);
  }
  assert.ok(estimate.totals.usdLow !== null && estimate.totals.usdLow > 0);
  assert.ok(estimate.totals.usdHigh !== null && estimate.totals.usdHigh > 0);

  const wrong = await estimateSuite({
    suite,
    games: [countdown],
    prices: PRICES,
    pricingKey: 'acme/beta',
  });
  assert.equal(wrong.pricing.priced, false);
  assert.equal(wrong.pricing.key, null);
  assert.equal(wrong.totals.usdLow, null);
  assert.equal(wrong.totals.usdHigh, null);
});

test('resolveBaseline: hook beats engine opponent beats state.par beats none', () => {
  // Countdown has one seat, no hook: par from the reset state.
  const countdownTier = countdown.spec.tiers[0];
  const countdownSeed = 'countdown/reference-par/public/0';
  const par = resolveBaseline(countdown, countdownTier, countdownSeed);
  assert.equal(par.kind, 'par');
  assert.equal(/** @type {{ kind: 'par', par: number }} */ (par).par, countdownStart(countdownSeed));

  // A two-seat game without a hook: the engine opponent stands in.
  const tictactoeTier = tictactoe.spec.tiers[0];
  const tictactoeSeed = 'tictactoe/perfect-opponent/public/0';
  const engine = resolveBaseline(tictactoe, tictactoeTier, tictactoeSeed);
  assert.equal(engine.kind, 'agent');

  // An explicit hook wins over the engine opponent.
  const hooked = {
    ...tictactoe,
    baselineAgent: () => ({ id: 'hook', track: 'baseline', act: async () => ({ text: 'a1' }) }),
  };
  const hookedResolved = resolveBaseline(hooked, tictactoeTier, tictactoeSeed);
  assert.equal(hookedResolved.kind, 'agent');
  assert.equal(/** @type {{ kind: 'agent', agent: { id: string } }} */ (hookedResolved).agent.id, 'hook');

  // One seat, no hook, no par: none.
  const takeOrPassTier = takeOrPass.spec.tiers[0];
  const takeOrPassSeed = 'take-or-pass/main/public/0';
  assert.equal(resolveBaseline(takeOrPass, takeOrPassTier, takeOrPassSeed).kind, 'none');
});

test('estimateSuite refuses a non-manifest suite', async () => {
  await assert.rejects(
    estimateSuite({ suite: /** @type {any} */ ({ format: 'not-a-suite' }), games: [] }),
    /playkit-gauntlet-suite\/1/
  );
});

test('writeEstimate writes estimate.json and estimate.md that round-trip', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gauntlet-estimate-'));
  try {
    const suite = buildSuite([takeOrPass], { split: 'public' });
    const estimate = await estimateSuite({ suite, games: [takeOrPass] });
    const { jsonPath, mdPath } = await writeEstimate(dir, estimate);

    const roundTrip = JSON.parse(await readFile(jsonPath, 'utf8'));
    assert.equal(roundTrip.format, 'playkit-gauntlet-estimate/1');
    assert.equal(roundTrip.kind, 'estimate');
    assert.equal(roundTrip.suite.manifestSha256, manifestSha256(suite));
    assert.match(String(roundTrip.generatedAt), /^20\d\d-/);
    assert.equal(roundTrip.totals.jobs, 2);

    const md = await readFile(mdPath, 'utf8');
    assert.match(md, /Manifest sha256 `[0-9a-f]{64}`/);
    assert.match(md, /\| \*\*Total\*\* \|/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
