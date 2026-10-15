/**
 * Tests for scoring rules (scoring/score.js). Every trajectory is produced by
 * the real runner against the real tic-tac-toe game and two fixture games
 * with hand-computable pars and payouts. No network, no paid APIs.
 *
 * @module
 */

/** @import { Agent } from '../core/types.js' */

import test from 'node:test';
import assert from 'node:assert/strict';

import { score, GauntletRefusalError } from './score.js';
import { buildSuite } from './suite.js';
import tictactoe from '../games/tictactoe/index.js';
import { createRandomAgent } from '../agents/random.js';
import {
  countdown,
  countdownStart,
  takeOrPass,
  makeSlotGame,
  scriptedAgent,
  runSuite,
} from './fixtures.js';

/** @import { Game, Trajectory } from '../core/types.js' */

const GAMES = [countdown, takeOrPass, tictactoe];
const SUITE = buildSuite(GAMES, { split: 'public', id: 'scoring-test-suite' });

/**
 * @param {number} actual
 * @param {number} expected
 * @param {string} label
 */
function assertClose(actual, expected, label) {
  // Outputs are rounded to 6 decimals, so 1e-6 is the honest tolerance.
  const diff = Math.abs(actual - expected);
  assert.ok(diff < 1e-6, `${label}: got ${actual}, want ${expected} (diff ${diff})`);
}

/**
 * Round to the score output's precision.
 *
 * @param {number} v
 * @returns {number}
 */
function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

/** All-solve agent for one episode: plain "dec" on countdown, "take" elsewhere. */
/**
 * @param {string} gameId
 * @param {string} _tierId
 * @param {string} _seed
 * @returns {Agent}
 */
const decAgent = (gameId, _tierId, _seed) =>
  gameId === 'countdown' ? scriptedAgent(['dec'], { id: 'agent-dec' }) : scriptedAgent(['take'], { id: 'agent-dec' });

test('full-dec entry: outcome, tier, rank weighting and benchmark scores by hand', async () => {
  const trajectories = await runSuite(SUITE, GAMES, decAgent);
  const result = await score(SUITE, trajectories, GAMES, { agent: { id: 'agent-dec', track: 'community' } });

  assert.equal(result.ranked, true);
  assert.equal(result.unrankedReason, null);
  assert.equal(result.episodes, 18);

  // Reference tier: par = start, agentActions = start -> e = 1 every seed.
  const reference = result.games.countdown.tiers['reference-par'];
  assertClose(/** @type {number} */ (reference.score.value), 1, 'countdown reference tier');
  assert.equal(reference.episodes, 4);
  assertClose(/** @type {number} */ (reference.solvedFraction), 1, 'reference solvedFraction');

  // Optimal tier: par = ceil(start/2), agentActions = start.
  const optimal = result.games.countdown.tiers['optimal-par'];
  const expectedOptimal =
    SUITE.games
      .find((g) => g.id === 'countdown')
      ?.tiers.find((t) => t.id === 'optimal-par')
      ?.seeds.map((seed) => (Math.ceil(countdownStart(seed) / 2) / countdownStart(seed)) ** 2) ?? [];
  assertClose(
    /** @type {number} */ (optimal.score.value),
    expectedOptimal.reduce((a, b) => a + b, 0) / expectedOptimal.length,
    'countdown optimal tier mean'
  );

  // Game score: rank-weighted (1*T_ref + 2*T_opt) / 3.
  const expectedG =
    (1 * /** @type {number} */ (reference.score.value) +
      2 * /** @type {number} */ (optimal.score.value)) /
    3;
  assertClose(/** @type {number} */ (result.games.countdown.score.value), expectedG, 'countdown G');

  // take-or-pass: e = normalized[0] = 1 on both seeds; single tier -> G = T.
  assertClose(/** @type {number} */ (result.games['take-or-pass'].score.value), 1, 'take-or-pass G');
  // Outcome tiers report no solvedFraction.
  assert.equal(result.games['take-or-pass'].tiers.main.solvedFraction, null);

  // Tic-tac-toe is benchmark: false: scored per tier from the recorded
  // outcomes, but excluded from B.
  const tictactoeTrajs = trajectories.filter((t) => t.game.id === 'tictactoe');
  assert.equal(tictactoeTrajs.length, 8);
  const expectedTT =
    tictactoeTrajs.reduce((sum, t) => sum + /** @type {number} */ (t.end.outcome?.normalized[t.agent.seat]), 0) /
    tictactoeTrajs.length;
  assertClose(
    /** @type {number} */ (result.games.tictactoe.tiers['perfect-opponent'].score.value),
    expectedTT,
    'tictactoe tier mean of normalized[agentSeat]'
  );

  // B: unweighted mean over benchmark games only.
  assertClose(
    /** @type {number} */ (result.benchmarkScore?.value),
    (expectedG + 1) / 2,
    'benchmark score B'
  );
  assert.ok(result.benchmarkScore?.ci95);
  assert.ok(result.benchmarkScore.ci95[0] <= /** @type {number} */ (result.benchmarkScore.value));
  assert.ok(/** @type {number} */ (result.benchmarkScore.value) <= result.benchmarkScore.ci95[1]);

  // Tier CIs nest the point estimate.
  for (const game of Object.values(result.games)) {
    for (const tier of Object.values(game.tiers)) {
      if (tier.score.value !== null && tier.score.ci95) {
        assert.ok(tier.score.ci95[0] <= tier.score.value + 1e-9);
        assert.ok(tier.score.value <= tier.score.ci95[1] + 1e-9);
      }
    }
  }
});

test('dec2 entry: the 1.15 reference cap and exact hand-computed B', async () => {
  // Community-track-style entry built from 'dec2' (countdown) and 'pass'
  // (take-or-pass), for exact hand-computed numbers.
  const trajectories = await runSuite(
    SUITE,
    GAMES,
    (gameId) => scriptedAgent([gameId === 'countdown' ? 'dec2' : 'pass'], { id: 'agent-dec2' })
  );
  const result = await score(SUITE, trajectories, GAMES, { agent: { id: 'agent-dec2', track: 'community' } });

  // Reference tier: every episode's e caps at 1.15 (the raw mean), but
  // T = min(solvedFraction, mean e) = min(1, 1.15) = 1 — the design's rule
  // that inefficiency cannot outscore solving also bounds perfect play at 1.
  assertClose(
    /** @type {number} */ (result.games.countdown.tiers['reference-par'].score.value),
    1,
    'reference tier T = min(solvedFraction, mean e)'
  );
  // Optimal tier: dec2 meets the optimal par exactly -> e = 1, the 1.0 cap.
  assertClose(
    /** @type {number} */ (result.games.countdown.tiers['optimal-par'].score.value),
    1,
    'optimal tier at 1.0'
  );
  // G = (1*1 + 2*1) / 3; take-or-pass passes for 0.25.
  assertClose(/** @type {number} */ (result.games.countdown.score.value), 1, 'countdown G');
  assertClose(/** @type {number} */ (result.games['take-or-pass'].score.value), 0.25, 'take-or-pass G');
  assertClose(/** @type {number} */ (result.benchmarkScore?.value), (1 + 0.25) / 2, 'B = 0.625');
});

test('efficiency tier: T = min(solvedFraction, mean e) caps unearned mean', async () => {
  // Three seeds solved fast at the 1.15 cap, one never solved (wait forever
  // -> budget-exhausted -> unsolved -> e = 0). Mean e = 0.8625 but only 3 of
  // 4 seeds solved, so T = 0.75, not 0.8625.
  const trajectories = await runSuite(
    SUITE,
    GAMES,
    (gameId, tierId, seed) => {
      if (gameId !== 'countdown') return scriptedAgent(['take'], { id: 'agent-cap' });
      if (tierId === 'reference-par' && seed.endsWith('/3')) {
        return scriptedAgent(['wait'], { id: 'agent-cap' });
      }
      return scriptedAgent(['dec2'], { id: 'agent-cap' });
    }
  );
  const result = await score(SUITE, trajectories, GAMES, { agent: { id: 'agent-cap', track: 'community' } });
  const reference = result.games.countdown.tiers['reference-par'];
  assertClose(/** @type {number} */ (reference.score.value), 0.75, 'T = min(solvedFraction, mean e)');
  assertClose(/** @type {number} */ (reference.solvedFraction), 0.75, 'solvedFraction 3/4');
  // Without the cap the mean of (1.15 + 1.15 + 1.15 + 0) / 4 would be 0.8625.
  assert.ok(/** @type {number} */ (reference.score.value) < 0.8625);
});

test('invalid attempts count in agentActions and shrink the efficiency score', async () => {
  // One bogus reply, then plain decs: agentActions = start + 1, par = start.
  const trajectories = await runSuite(
    buildSuite([countdown], { split: 'public', id: 'invalid-suite' }),
    [countdown],
    () => scriptedAgent(['bogus', 'dec'], { id: 'agent-sloppy' })
  );
  // Only the first reference-par episode, to keep the arithmetic single-seed.
  const firstOnly = trajectories.filter(
    (t) => t.tier === 'reference-par' && t.seed.endsWith('/0')
  );
  const result = await score(
    buildSuite([countdown], { split: 'public', id: 'invalid-suite' }),
    firstOnly,
    [countdown],
    { agent: { id: 'agent-sloppy', track: 'community' } }
  );
  const start = countdownStart(firstOnly[0].seed);
  const tier = result.games.countdown.tiers['reference-par'];
  assertClose(/** @type {number} */ (tier.score.value), (start / (start + 1)) ** 2, 'e with one invalid attempt');
  // Entry is incomplete (3+7 episodes missing) and therefore unranked, but
  // still scored over what it covers.
  assert.equal(result.ranked, false);
  assert.match(/** @type {string} */ (result.unrankedReason), /missing episodes/);
  assertClose(
    /** @type {number} */ (result.invalidActionRate),
    1 / (start + 1),
    'invalid action rate'
  );
});

test('forfeit and budget exhaustion score zero', async () => {
  const suite = buildSuite([takeOrPass], { split: 'public', id: 'fail-suite' });
  const agent = { id: 'agent-fail', track: /** @type {'community'} */ ('community') };

  const forfeitTrajs = await runSuite(suite, [takeOrPass], () =>
    scriptedAgent(['garbage one', 'garbage two', 'garbage three'], { id: 'agent-fail' })
  );
  const forfeitResult = await score(suite, forfeitTrajs, [takeOrPass], { agent });
  assertClose(
    /** @type {number} */ (forfeitResult.games['take-or-pass'].tiers.main.score.value),
    0,
    'forfeit scores 0 on an outcome tier'
  );
  assert.equal(forfeitTrajs.every((t) => t.end.reason === 'forfeit-invalid'), true);

  const budgetTrajs = await runSuite(
    buildSuite([countdown], { split: 'public', id: 'budget-suite' }),
    [countdown],
    () => scriptedAgent(['wait'], { id: 'agent-fail' })
  );
  const budgetResult = await score(
    buildSuite([countdown], { split: 'public', id: 'budget-suite' }),
    budgetTrajs,
    [countdown],
    { agent }
  );
  assert.equal(budgetTrajs.every((t) => t.end.reason === 'budget-exhausted'), true);
  assertClose(
    /** @type {number} */ (budgetResult.games.countdown.tiers['reference-par'].score.value),
    0,
    'budget-exhausted scores 0 on an efficiency tier'
  );
});

test('cost: summed across episodes, unknown when any agent step cost is null', async () => {
  const suite = buildSuite([takeOrPass], { split: 'public', id: 'cost-suite' });
  const usage = { inputTokens: 100, outputTokens: 20, costUsd: 0.01 };

  const known = await runSuite(suite, [takeOrPass], () =>
    scriptedAgent([{ text: 'take', usage }], { id: 'agent-cost' })
  );
  const knownResult = await score(suite, known, [takeOrPass], {
    agent: { id: 'agent-cost', track: 'community' },
  });
  assertClose(/** @type {number} */ (knownResult.costUsd), 0.02, 'cost sums over episodes');
  assertClose(/** @type {number} */ (knownResult.costPerEpisodeUsd), 0.01, 'cost per episode');

  const unknown = await runSuite(suite, [takeOrPass], () =>
    scriptedAgent([
      { text: 'take', usage: { inputTokens: 100, outputTokens: 20, costUsd: null } },
    ], { id: 'agent-cost' })
  );
  const unknownResult = await score(suite, unknown, [takeOrPass], {
    agent: { id: 'agent-cost', track: 'community' },
  });
  assert.equal(unknownResult.costUsd, 'unknown');
  assert.equal(unknownResult.costPerEpisodeUsd, 'unknown');

  // An agent that reports no usage at all has unknown cost.
  const silent = await runSuite(suite, [takeOrPass], () => scriptedAgent(['take'], { id: 'agent-cost' }));
  const silentResult = await score(suite, silent, [takeOrPass], {
    agent: { id: 'agent-cost', track: 'community' },
  });
  assert.equal(silentResult.costUsd, 'unknown');
});

test('dry-run entries are listed but unranked', async () => {
  const trajectories = await runSuite(SUITE, GAMES, (gameId) =>
    scriptedAgent([gameId === 'countdown' ? 'dec' : 'take'], { id: 'agent-dry', dryRun: true })
  );
  assert.equal(trajectories.some((t) => t.agent.dryRun === true), true);
  const result = await score(SUITE, trajectories, GAMES, {
    agent: { id: 'agent-dry', track: 'community' },
  });
  assert.equal(result.ranked, false);
  assert.match(/** @type {string} */ (result.unrankedReason), /dry-run trajectory/);
  // Scores are still computed and reported.
  assert.ok(result.benchmarkScore && result.benchmarkScore.value !== null);
});

test('bootstrap intervals: identical under the same seed, narrower with more episodes', async () => {
  const trajectories = await runSuite(SUITE, GAMES, decAgent);
  const options = { agent: { id: 'agent-dec', track: /** @type {'community'} */ ('community') } };
  const first = await score(SUITE, trajectories, GAMES, options);
  const second = await score(SUITE, trajectories, GAMES, options);
  assert.deepEqual(first.benchmarkScore, second.benchmarkScore);
  assert.deepEqual(first.games.countdown.tiers['reference-par'].score, second.games.countdown.tiers['reference-par'].score);
  assert.deepEqual(first.games.tictactoe.score, second.games.tictactoe.score);

  // Same score distribution, 2 seeds vs 6 seeds: same-ish mean, tighter CI.
  const makeAgent = () => scriptedAgent(['go'], { id: 'slot-agent' });
  const slot2 = buildSuite([makeSlotGame(2)], { split: 'public', id: 'slot-2' });
  const slot6 = buildSuite([makeSlotGame(6)], { split: 'public', id: 'slot-6' });
  const traj2 = await runSuite(slot2, [makeSlotGame(2)], makeAgent);
  const traj6 = await runSuite(slot6, [makeSlotGame(6)], makeAgent);
  const result2 = await score(slot2, traj2, [makeSlotGame(2)], {
    agent: { id: 'slot-agent', track: 'community' },
  });
  const result6 = await score(slot6, traj6, [makeSlotGame(6)], {
    agent: { id: 'slot-agent', track: 'community' },
  });
  const tier2 = result2.games.slot.tiers.main;
  const tier6 = result6.games.slot.tiers.main;
  assertClose(/** @type {number} */ (tier2.score.value), 0.325, 'slot 2-seed mean');
  assertClose(/** @type {number} */ (tier6.score.value), 0.325, 'slot 6-seed mean');
  const width2 = /** @type {[number, number]} */ (tier2.score.ci95);
  const width6 = /** @type {[number, number]} */ (tier6.score.ci95);
  assert.ok(
    width6[1] - width6[0] < width2[1] - width2[0],
    `expected narrower CI with more episodes: 6-seed width ${width6[1] - width6[0]}, 2-seed width ${width2[1] - width2[0]}`
  );
});

//
// Refusals. Each leaves score() with a GauntletRefusalError naming the file
// and the refusing step.
//

test('duplicate episodes are refused', async () => {
  const trajectories = await runSuite(SUITE, GAMES, decAgent);
  await assert.rejects(
    () => score(SUITE, [...trajectories, trajectories[0]], GAMES, { agent: { id: 'agent-dec', track: 'community' } }),
    (err) => {
      assert.ok(err instanceof GauntletRefusalError);
      assert.match(err.message, /\[gauntlet\/scoring\/score\.js\] duplicate-episodes/);
      return true;
    }
  );
});

test('a trajectory whose game is not in the suite is refused', async () => {
  const trajectories = await runSuite(SUITE, GAMES, decAgent);
  const stranger = { ...trajectories[0], game: { ...trajectories[0].game, id: 'not-a-game' } };
  await assert.rejects(
    () => score(SUITE, [...trajectories, stranger], GAMES, { agent: { id: 'agent-dec', track: 'community' } }),
    /score\.js\] suite-membership.*not-a-game/
  );
});

test('a trajectory whose tier is not in the suite is refused', async () => {
  const trajectories = await runSuite(SUITE, GAMES, decAgent);
  const stranger = { ...trajectories[0], tier: 'no-such-tier' };
  await assert.rejects(
    () => score(SUITE, [...trajectories, stranger], GAMES, { agent: { id: 'agent-dec', track: 'community' } }),
    /score\.js\] suite-membership.*no-such-tier/
  );
});

test('a trajectory for a seed outside the manifest is refused', async () => {
  const trajectories = await runSuite(SUITE, GAMES, decAgent);
  const stranger = { ...trajectories[0], seed: `${trajectories[0].game.id}/${trajectories[0].tier}/public/99` };
  await assert.rejects(
    () => score(SUITE, [...trajectories, stranger], GAMES, { agent: { id: 'agent-dec', track: 'community' } }),
    /score\.js\] suite-membership.*seed/
  );
});

test('mixed game versions within one entry are refused', async () => {
  const trajectories = await runSuite(SUITE, GAMES, decAgent);
  const fromTheFuture = { ...trajectories[0], game: { ...trajectories[0].game, version: '9.9.9' } };
  await assert.rejects(
    () => score(SUITE, [...trajectories, fromTheFuture], GAMES, { agent: { id: 'agent-dec', track: 'community' } }),
    /score\.js\] game-version-uniformity.*mixed game versions/
  );
});

test('mixed splits within one entry are refused', async () => {
  const trajectories = await runSuite(SUITE, GAMES, decAgent);
  const fromEval = { ...trajectories[0], split: /** @type {'eval'} */ ('eval') };
  await assert.rejects(
    () => score(SUITE, [...trajectories, fromEval], GAMES, { agent: { id: 'agent-dec', track: 'community' } }),
    /score\.js\] split-uniformity.*mixed splits/
  );
});

test('a salt commitment that does not match the suite is refused', async () => {
  const trajectories = await runSuite(SUITE, GAMES, decAgent);
  await assert.rejects(
    () =>
      score(SUITE, trajectories, GAMES, {
        agent: { id: 'agent-dec', track: 'community' },
        saltCommitment: 'not-the-suite-commitment',
      }),
    /score\.js\] salt-commitment.*mixed salt commitments/
  );
});

test('a trajectory that fails verifyTrajectory is refused, naming the replay failure', async () => {
  const trajectories = await runSuite(SUITE, GAMES, decAgent);
  // Take-or-pass is one step: swapping take -> pass keeps the recorded
  // observation hash but changes the outcome, so replay catches it.
  const tampered = trajectories.map((t) =>
    t.game.id === 'take-or-pass' && t.steps[0].action === 'take'
      ? { ...t, steps: [{ ...t.steps[0], action: 'pass' }] }
      : t
  );
  assert.notDeepEqual(tampered, trajectories);
  await assert.rejects(
    () => score(SUITE, tampered, GAMES, { agent: { id: 'agent-dec', track: 'community' } }),
    (err) => {
      assert.ok(err instanceof GauntletRefusalError);
      assert.match(err.message, /score\.js\] trajectory-verification/);
      assert.match(err.message, /verifyTrajectory \(step \d+\)/);
      return true;
    }
  );
});

test('an efficiency episode claiming solved with par 0 is refused', async () => {
  // A fixture game whose every terminal outcome claims solved with par 0.
  // verifyTrajectory passes (the game really returns that), scoring refuses.
  /** @type {Game<*>} */
  const brokenPar = {
    spec: {
      ...countdown.spec,
      id: 'broken-par',
      tiers: [{ ...countdown.spec.tiers[0], id: 'main', publicSeeds: 1 }],
    },
    reset: () => ({ done: false }),
    toAct: (state) => (state.done ? null : 0),
    observe: () => ({ text: 'go?', data: {} }),
    legalActions: (state) => (state.done ? [] : ['go']),
    parseAction: (_s, _seat, text) =>
      text.trim().toLowerCase() === 'go'
        ? { ok: true, action: 'go' }
        : { ok: false, error: 'no' },
    step: (state) => ({ ...state, done: true }),
    outcome: (state) =>
      state.done
        ? { normalized: [1], raw: null, reason: 'done', solved: true, par: 0 }
        : null,
    truncate: () => ({ normalized: [0], raw: null, reason: 'ran out of budget' }),
  };
  const suite = buildSuite([brokenPar], { split: 'public', id: 'broken-suite' });
  const trajectories = await runSuite(suite, [brokenPar], () => scriptedAgent(['go'], { id: 'agent-broken' }));
  await assert.rejects(
    () => score(suite, trajectories, [brokenPar], { agent: { id: 'agent-broken', track: 'community' } }),
    /score\.js\] efficiency-par.*par 0/
  );
});

test('a suite game missing from the games argument is refused', async () => {
  const trajectories = await runSuite(SUITE, GAMES, decAgent);
  await assert.rejects(
    () => score(SUITE, trajectories, [countdown, takeOrPass], { agent: { id: 'agent-dec', track: 'community' } }),
    /score\.js\] games-lookup.*tictactoe/
  );
});

test('a suite with no benchmark games is refused', async () => {
  /** @type {Game<*>} */
  const nonBenchmark = { ...tictactoe, spec: { ...tictactoe.spec, benchmark: false } };
  const suite = buildSuite([nonBenchmark], { split: 'public', id: 'no-benchmark' });
  const trajectories = await runSuite(suite, [nonBenchmark], (gameId, tierId, seed) =>
    createRandomAgent({ episodeSeed: seed })
  );
  await assert.rejects(
    () => score(suite, trajectories, [nonBenchmark], { agent: { id: 'random', track: 'baseline' } }),
    /score\.js\] benchmark-games/
  );
});
