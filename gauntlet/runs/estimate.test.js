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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { tictactoe } from '../games/tictactoe/index.js';
import { countdown, countdownStart, takeOrPass } from '../scoring/fixtures.js';
import { buildSuite } from '../scoring/suite.js';
import { runEpisode } from '../core/runner.js';

import { manifestSha256 } from './plan.js';
import { runSuite } from './run.js';
import {
  COMPARE_FORMAT,
  compareRunAgainstEstimate,
  comparisonToMarkdown,
  estimateSuite,
  estimateToMarkdown,
  resolveBaseline,
  writeEstimate,
} from './estimate.js';
import { ESTIMATE_FIT } from './estimate-fit/params.js';

const PRICES = {
  'acme/alpha': { inputPerMTok: 3, outputPerMTok: 15, source: 'test', checked: '2026-10-15' },
};

test('engine-probe basis: tictactoe, low = an independently replayed baseline mean', async () => {
  const suite = buildSuite([tictactoe], { split: 'public' });
  // fit:false — tictactoe/perfect-opponent has fitted parameters from real
  // runs, so the default estimate would use them; this test pins the probe
  // machinery that remains the fallback for unfitted tiers.
  const estimate = await estimateSuite({ suite, games: [tictactoe], fit: false });

  assert.equal(estimate.jobs.length, 40);

  // Independent measurement: for every tier, replay that tier's own engine
  // baseline through the core runner on the same two seeds the probe uses.
  const tierMeans = new Map();
  for (const st of suite.games[0].tiers) {
    const tier = /** @type {*} */ (tictactoe.spec.tiers.find((t) => t.id === st.id));
    assert.ok(tier, `tictactoe has the ${st.id} tier`);
    const probeSeeds = st.seeds.slice(0, 2);
    assert.equal(probeSeeds.length, 2);
    let sum = 0;
    for (const seed of probeSeeds) {
      const seat = tictactoe.agentSeat(tier, seed);
      const baseline = tictactoe.opponent(tier, seed, seat);
      const trajectory = await runEpisode({ game: tictactoe, tierId: tier.id, seed, agent: baseline });
      sum += trajectory.end.agentActions;
    }
    tierMeans.set(st.id, sum / probeSeeds.length);
  }

  let lowSum = 0;
  let highSum = 0;
  for (const job of estimate.jobs) {
    assert.equal(job.basis, 'engine-probe');
    const mean = /** @type {number} */ (tierMeans.get(job.tierId));
    assert.ok(Math.abs(/** @type {number} */ (job.callsLow) - mean) < 1e-9, `callsLow ${job.callsLow} vs measured ${mean} on ${job.tierId}`);
    const tier = /** @type {*} */ (tictactoe.spec.tiers.find((t) => t.id === job.tierId));
    assert.equal(job.callsHigh, tier.maxActions);
    // No prices given: every USD figure stays unknown rather than guessed.
    assert.equal(job.usdLow, null);
    assert.equal(job.usdHigh, null);
    assert.match(/** @type {string} */ (job.note), /engine baseline/);
    lowSum += /** @type {number} */ (job.callsLow);
    highSum += /** @type {number} */ (job.callsHigh);
  }
  assert.equal(estimate.suite.manifestSha256, manifestSha256(suite));
  assert.equal(estimate.totals.callsHigh, highSum);
  assert.equal(estimate.totals.callsLow, lowSum);
  assert.equal(estimate.totals.usdLow, null);
});

test('model-fit basis: tictactoe uses the fitted parameters from committed runs', async () => {
  const fitTier = ESTIMATE_FIT.tiers['tictactoe/perfect-opponent'];
  assert.ok(fitTier, 'the committed fit covers tictactoe/perfect-opponent');

  const suite = buildSuite([tictactoe], { split: 'public' });
  const estimate = await estimateSuite({ suite, games: [tictactoe] });

  const tier = tictactoe.spec.tiers.find((t) => t.id === 'perfect-opponent');
  assert.ok(tier);
  // The committed fit covers tictactoe/perfect-opponent only; the other
  // tictactoe tiers fall back to the engine-probe basis.
  const fittedJobs = estimate.jobs.filter((j) => j.tierId === 'perfect-opponent');
  for (const job of estimate.jobs.filter((j) => j.tierId !== 'perfect-opponent')) {
    assert.equal(job.basis, 'engine-probe');
  }
  for (const job of fittedJobs) {
    assert.equal(job.basis, 'model-fit');
    // Low = the fitted mean agent actions per episode, exactly as fitted.
    assert.equal(job.callsLow, fitTier.callsExpected);
    // High stays the tier budget, fitted or not.
    assert.equal(job.callsHigh, tier.maxActions);
    assert.match(/** @type {string} */ (job.note), /fitted mean agent actions/);
    assert.match(/** @type {string} */ (job.note), /maxActions/);
  }
  // Fit provenance is carried on the estimate.
  assert.ok(estimate.fit, 'fit provenance present when a job used the fit');
  assert.equal(/** @type {*} */ (estimate.fit).format, ESTIMATE_FIT.format);
  assert.ok(/** @type {*} */ (estimate.fit).tiers >= 1);
  assert.ok(Array.isArray(/** @type {*} */ (estimate.fit).sources));
  assert.match(estimate.note, /runs\/estimate-fit\/fit-report\.md/);

  // Markdown renders the fitted note and stays labeled as an estimate.
  const md = estimateToMarkdown(estimate);
  assert.match(md, /Estimate, not a measurement/);
  assert.match(md, /fitted mean agent actions/);
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
  assert.equal(estimate.totals.callsLow, 0);
  assert.equal(estimate.totals.usdHigh, null); // no prices given at all
  // The one game without a basis is named, not silently dropped.
  assert.deepEqual(estimate.totals.noLowBasis, ['take-or-pass']);

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

test('totals: sum every game with a basis and name the games without one', async () => {
  const suite = buildSuite([countdown, takeOrPass], { split: 'public' });
  const estimate = await estimateSuite({
    suite,
    games: [countdown, takeOrPass],
    prices: PRICES,
    pricingKey: 'acme/alpha',
  });

  const countdownRow = estimate.games.find((g) => g.gameId === 'countdown');
  assert.ok(countdownRow, 'the suite plans countdown');
  assert.ok(countdownRow.usdLow !== null && countdownRow.usdHigh !== null, 'countdown is priced');

  // Totals never null out because take-or-pass lacks a basis: they sum the
  // games that have one and name the games that do not.
  assert.equal(estimate.totals.callsLow, countdownRow.callsLow);
  assert.equal(estimate.totals.usdLow, countdownRow.usdLow);
  assert.equal(estimate.totals.usdHigh, countdownRow.usdHigh);
  assert.deepEqual(estimate.totals.noLowBasis, ['take-or-pass']);
  assert.deepEqual(estimate.totals.noTokenBasis, ['take-or-pass']);

  // Markdown: the exclusions are named next to the totals row, and each
  // tier's basis is shown at a glance.
  const md = estimateToMarkdown(estimate);
  assert.match(
    md,
    /Totals sum every game that has a basis — no low basis: take-or-pass; no token basis \(USD unknown\): take-or-pass\./
  );
  assert.match(md, /\| countdown\/[a-z-]+ \| par \|/);
  assert.match(md, /\| take-or-pass\/[a-z-]+ \| none \|/);
  assert.match(md, /Unestimated tiers \(no fitted or par basis\): take-or-pass\//);
});

test('noProbes: no baseline episodes — fit where fitted, par where not, unestimated with neither', async () => {
  const suite = buildSuite([tictactoe, countdown, takeOrPass], { split: 'public' });
  const estimate = await estimateSuite({
    suite,
    games: [tictactoe, countdown, takeOrPass],
    noProbes: true,
  });

  /** @param {string} id */
  const byGame = (id) => estimate.jobs.filter((j) => j.gameId === id);
  // Fitted tier: the fit supplies the low side exactly as with probes. The
  // committed fit covers tictactoe/perfect-opponent only.
  const fitTier = ESTIMATE_FIT.tiers['tictactoe/perfect-opponent'];
  assert.ok(fitTier, 'the committed fit covers tictactoe/perfect-opponent');
  for (const job of byGame('tictactoe').filter((j) => j.tierId === 'perfect-opponent')) {
    assert.equal(job.basis, 'model-fit');
    assert.equal(job.callsLow, fitTier.callsExpected);
    assert.ok(job.tokens, 'a fitted job carries the fitted token figures');
  }
  // Par tier: the tier's par stands in for the unplayed probe episodes, and
  // the token basis still renders from the initial official turn.
  for (const job of byGame('countdown')) {
    assert.equal(job.basis, 'par');
    assert.match(/** @type {string} */ (job.note), /--no-probes/);
    assert.ok(job.tokens, 'a par job carries the initial-turn token figures');
  }
  // Neither: explicitly unestimated, never probed, never guessed.
  for (const job of byGame('take-or-pass')) {
    assert.equal(job.basis, 'none');
    assert.equal(job.callsLow, null);
    assert.match(/** @type {string} */ (job.note), /unestimated/);
    assert.equal(job.tokens, null);
  }

  // The tier basis table answers, per planned tier, what its low side is.
  assert.ok(estimate.tiers.some((t) => t.gameId === 'tictactoe' && t.basis === 'model-fit'));
  assert.ok(estimate.tiers.some((t) => t.gameId === 'countdown' && t.basis === 'par'));
  assert.ok(estimate.tiers.some((t) => t.gameId === 'take-or-pass' && t.basis === 'none'));

  // Totals sum what has a basis and name the rest; the note explains the mode.
  // Under noProbes, tictactoe's unfitted tiers and take-or-pass have no
  // no-probe basis, so both games are named (the fitted tier still
  // contributes its figures).
  assert.deepEqual(estimate.totals.noLowBasis, ['tictactoe', 'take-or-pass']);
  assert.equal(estimate.totals.callsLow, estimate.games.reduce((a, g) => a + (g.callsLow ?? 0), 0));
  assert.match(estimate.note, /--no-probes/);
});

/** A priced stand-in agent: first legal action, fixed usage and cost.
 *
 * @returns {(job: *) => import('../core/types.js').Agent}
 */
function fakePricedFactory() {
  return () => /** @type {import('../core/types.js').Agent} */ ({
    id: 'fake-priced',
    track: 'community',
    async act(ctx) {
      return {
        text: /** @type {string[]} */ (ctx.legalActions)[0],
        usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.001 },
      };
    },
  });
}

test('compareRunAgainstEstimate: actual calls/tokens/spend vs the estimate, per game and in total', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gauntlet-estimate-compare-'));
  try {
    const suite = buildSuite([takeOrPass, countdown], { split: 'public' });
    const games = [takeOrPass, countdown];
    const outDir = path.join(dir, 'run');
    await runSuite({ suite, games, agentFactory: fakePricedFactory(), outDir });

    const estimate = await estimateSuite({ suite, games });
    const comparison = await compareRunAgainstEstimate(estimate, outDir);

    assert.equal(comparison.format, COMPARE_FORMAT);
    assert.equal(comparison.kind, 'estimate-vs-actual');
    // Every planned episode has a trajectory, and all were played.
    const planned = suite.games.reduce((a, g) => a + g.tiers.reduce((b, t) => b + t.seeds.length, 0), 0);
    assert.equal(comparison.episodes, planned);
    assert.equal(comparison.unplayedEpisodes, 0);

    // Actuals mirror run.json's whole-bundle total block by construction:
    // both sum the same trajectories.
    const run = JSON.parse(await readFile(path.join(outDir, 'run.json'), 'utf8'));
    assert.equal(comparison.totals.figures.actual.calls, run.total.calls);
    assert.equal(comparison.totals.figures.actual.tokensIn, run.total.tokens.input);
    assert.ok(Math.abs(comparison.totals.figures.actual.spendUsd - run.total.spendUsd) < 1e-9);

    // take-or-pass has no low basis: its low ratio is null, never 0 — a
    // missing basis must not masquerade as a 0% error. Its worst-case
    // (maxActions) basis still produces a positive ratio.
    const top = comparison.games.find((g) => g.gameId === 'take-or-pass');
    assert.ok(top, 'take-or-pass is compared');
    assert.equal(top.figures.ratio.callsLow, null);
    assert.ok(top.figures.ratio.callsHigh !== null);
    assert.ok(top.figures.ratio.callsHigh > 0);
    // countdown has a par low basis: the actual lands at a finite multiple.
    const cd = comparison.games.find((g) => g.gameId === 'countdown');
    assert.ok(cd && cd.figures.ratio.callsLow !== null && cd.figures.ratio.callsLow > 0);
    // No prices on the estimate: USD ratios stay null while the actual spend
    // (from the trajectories' own costs) is still shown.
    assert.equal(top.figures.ratio.usdLow, null);
    assert.ok(top.figures.actual.spendUsd > 0);

    const md = comparisonToMarkdown(comparison);
    assert.match(md, /# Estimate vs actual/);
    assert.match(md, /Actual, not an estimate/);
    assert.match(md, /—/); // missing ratios render as em dashes, not zeros
    // The within-2x question is answered per game; a game with no low basis
    // stays null (an em dash) rather than masquerading as a hit or a miss.
    assert.match(md, /\| Calls vs expected \|/);
    assert.equal(top.callsVerdict, null);
    assert.ok(
      ['within-2x', 'over-2x', 'under-2x'].includes(/** @type {*} */ (cd.callsVerdict)),
      `countdown verdict ${cd.callsVerdict} should be a concrete verdict`
    );
    assert.ok(
      ['within-2x', 'over-2x', 'under-2x'].includes(/** @type {*} */ (comparison.totals.callsVerdict))
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('comparisonToMarkdown: the Calls vs expected column answers the within-2x question', () => {
  /** @param {string} gameId @param {'within-2x' | 'over-2x' | 'under-2x' | null} v @returns {*} */
  const row = (gameId, v) => ({
    gameId,
    episodes: 1,
    unknownCostSteps: 0,
    callsVerdict: v,
    figures: {
      actual: { calls: 10, tokensIn: 100, tokensOut: 10, spendUsd: 0.01 },
      estimated: {
        callsLow: v === 'over-2x' ? 2 : v === 'under-2x' ? 20 : v === 'within-2x' ? 10 : null,
        callsHigh: 100,
        tokensInLow: null,
        tokensOutLow: null,
        tokensInHigh: null,
        tokensOutHigh: null,
        usdLow: null,
        usdHigh: null,
      },
      ratio: {
        callsLow: v === 'over-2x' ? 5 : v === 'under-2x' ? 0.5 : v === 'within-2x' ? 1 : null,
        callsHigh: 0.1,
        tokensInLow: null,
        tokensOutLow: null,
        tokensInHigh: null,
        tokensOutHigh: null,
        usdLow: null,
        usdHigh: null,
      },
    },
  });
  const md = comparisonToMarkdown({
    format: COMPARE_FORMAT,
    kind: 'estimate-vs-actual',
    runDir: '/tmp/fake-bundle',
    episodes: 4,
    unplayedEpisodes: 0,
    games: [
      row('sokoban', 'over-2x'),
      row('tictactoe', 'within-2x'),
      row('minesweeper', 'under-2x'),
      row('take-or-pass', null),
    ],
    totals: {
      episodes: 4,
      unknownCostSteps: 0,
      unplayedEpisodes: 0,
      callsVerdict: 'within-2x',
      figures: {
        actual: { calls: 40, tokensIn: 400, tokensOut: 40, spendUsd: 0.04 },
        estimated: {
          callsLow: 32,
          callsHigh: 400,
          tokensInLow: null,
          tokensOutLow: null,
          tokensInHigh: null,
          tokensOutHigh: null,
          usdLow: null,
          usdHigh: null,
        },
        ratio: {
          callsLow: 1.25,
          callsHigh: 0.1,
          tokensInLow: null,
          tokensOutLow: null,
          tokensInHigh: null,
          tokensOutHigh: null,
          usdLow: null,
          usdHigh: null,
        },
      },
    },
  });

  assert.match(md, /\| Game \| Calls \| Calls vs expected \| Tokens in \| Tokens out \| USD \|/);
  assert.match(md, /\| within 2× \|/);
  // Over and under are named, not collapsed into one "no": they mean opposite
  // failures (the model ran past the budget vs stopped far short of it).
  assert.match(md, /\| over 2× \|/);
  assert.match(md, /\| under 2× \|/);
  assert.match(md, /Calls beyond 2× of expected: sokoban \(over\), minesweeper \(under\)\./);
  assert.match(md, /runs\/estimate-fit\/fit-report\.md/);
});

test('compareRunAgainstEstimate refuses a bundle whose suite manifest differs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gauntlet-estimate-compare-'));
  try {
    const suite = buildSuite([takeOrPass], { split: 'public' });
    const outDir = path.join(dir, 'run');
    await runSuite({ suite, games: [takeOrPass], agentFactory: fakePricedFactory(), outDir });

    const run = JSON.parse(await readFile(path.join(outDir, 'run.json'), 'utf8'));
    run.suite.manifestSha256 = '0'.repeat(64);
    await writeFile(path.join(outDir, 'run.json'), JSON.stringify(run, null, 2) + '\n');

    const estimate = await estimateSuite({ suite, games: [takeOrPass] });
    await assert.rejects(
      () => compareRunAgainstEstimate(estimate, outDir),
      /does not match the estimate's/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('compareRunAgainstEstimate: a partial-run bundle carries no verdicts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gauntlet-estimate-partial-'));
  try {
    const suite = buildSuite([takeOrPass, countdown], { split: 'public' });
    const games = [takeOrPass, countdown];
    const outDir = path.join(dir, 'run');
    // A tight dollar cap stops the run partway: episodes stay unplayed, the
    // actuals are partial-run figures.
    await runSuite({ suite, games, agentFactory: fakePricedFactory(), outDir, maxUsd: 0.005 });

    const estimate = await estimateSuite({ suite, games });
    const comparison = await compareRunAgainstEstimate(estimate, outDir);

    assert.ok(comparison.unplayedEpisodes > 0, 'the cap stopped the run partway');
    const planned = suite.games.reduce((a, g) => a + g.tiers.reduce((b, t) => b + t.seeds.length, 0), 0);
    assert.ok(comparison.unplayedEpisodes < planned, 'some episodes did play');
    // Every game short of its planned episodes carries no verdict — a cap-stop
    // must not read as "under-2x" — and neither does the total.
    for (const row of comparison.games) {
      assert.ok(Number.isInteger(row.expectedEpisodes) && row.expectedEpisodes > 0);
      if (row.episodes < row.expectedEpisodes) {
        assert.equal(row.callsVerdict, null, `${row.gameId} issued a verdict on a partial run`);
      }
    }
    assert.equal(comparison.totals.callsVerdict, null);
    const md = comparisonToMarkdown(comparison);
    assert.match(md, /no within-2x verdict/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
