/**
 * Isolated tests for the Elo fitting module: exact closed-form answers,
 * synthetic ratings recovered within tolerance, and the named error for
 * all-wins input (which has no finite maximum). Tests that run real chess
 * episodes exercise `rateAgent` on the built-in greedy baseline; those need
 * no Stockfish binary (the paper rung is a built-in engine).
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EloFitError,
  expectedScore,
  fitRatings,
  twoPlayerClosedForm,
  bootstrapRatings,
  rateAgent,
  rungForTrajectory,
} from './elo.js';
import { nextFloat, rngFromSeed } from '../core/rng.js';
import { chess } from '../games/chess/index.js';
import { createGreedyBaselineAgent } from '../games/chess/baselines.js';
import { runEpisode } from '../core/runner.js';

test('expected score matches the Elo curve', () => {
  assert.equal(expectedScore(1000, 1000), 0.5);
  // +100 Elo is the textbook 0.64 expected score (exactly 0.64006...).
  assert.ok(Math.abs(expectedScore(1100, 1000) - 0.64) < 1e-3);
  assert.ok(Math.abs(expectedScore(1000, 1100) - 0.36) < 1e-3);
});

test('two-player closed form: the fit reproduces 400*log10(s/(n-s)) exactly', () => {
  const n = 30;
  const score = 21;
  const expected = 400 * Math.log10(score / (n - score));
  const games = [];
  for (let i = 0; i < score; i++) games.push({ a: 'A', b: 'B', score: 1 });
  for (let i = 0; i < n - score; i++) games.push({ a: 'A', b: 'B', score: 0 });
  const fit = fitRatings(games, { anchorPlayer: 'B', anchorRating: 1000 });
  assert.ok(Math.abs(fit.ratings.A - fit.ratings.B - expected) < 1e-6);
  assert.equal(fit.ratings.B, 1000);
  // And the helper itself agrees.
  assert.ok(Math.abs(twoPlayerClosedForm(score, n) - expected) < 1e-9);
});

test('two wins and a draw give the closed-form 400*log10(5) edge', () => {
  // 2 wins + 1 draw = 2.5 of 3 -> s/(n-s) = 5 -> +400 log10(5) ~ 279.6.
  const games = [
    { a: 'A', b: 'B', score: 1 },
    { a: 'A', b: 'B', score: 0.5 },
    { a: 'A', b: 'B', score: 1 },
  ];
  const fit = fitRatings(games, { anchorPlayer: 'B', anchorRating: 1500 });
  assert.ok(Math.abs(fit.ratings.A - 1500 - 400 * Math.log10(5)) < 1e-6);
});

test('a win, a draw and a loss is exactly an even match', () => {
  // 1 + 0.5 + 0 = 1.5 of 3 -> p* = 1/2 -> zero difference, and the fit
  // finds it (not a divergence).
  const games = [
    { a: 'A', b: 'B', score: 1 },
    { a: 'A', b: 'B', score: 0.5 },
    { a: 'A', b: 'B', score: 0 },
  ];
  const fit = fitRatings(games, { anchorPlayer: 'B', anchorRating: 1500 });
  assert.ok(Math.abs(fit.ratings.A - 1500) < 1e-6);
});

test('recovers synthetic ratings within tolerance and anchors the declared rung', () => {
  /** @type {Record<string, number>} */
  const truth = { P0: 1000, P1: 1120, P2: 1230, P3: 1400 };
  const ids = Object.keys(truth);
  let state = rngFromSeed('rating/elo.test/synthetic');
  const games = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const p = expectedScore(truth[a], truth[b]);
      for (let g = 0; g < 200; g++) {
        // Pure Bernoulli sampling: a wins with probability exactly the Elo
        // expected score p (draws are covered exactly by the closed-form
        // tests above, and Bernoulli keeps the sampling variance minimal).
        const draw = nextFloat(state);
        state = draw.state;
        games.push({ a, b, score: draw.value < p ? 1 : 0 });
      }
    }
  }
  const fit = fitRatings(games, { anchorPlayer: 'P0', anchorRating: 1000 });
  for (const id of ids) {
    assert.ok(
      Math.abs(fit.ratings[id] - truth[id]) < 80,
      `${id}: fitted ${fit.ratings[id].toFixed(1)} vs truth ${truth[id]}`
    );
  }
  assert.equal(fit.ratings.P0, 1000);

  // Bootstrap intervals on the same data: each interval should cover its
  // true rating, and the anchor has zero width.
  const boot = bootstrapRatings(games, {
    anchorPlayer: 'P0',
    anchorRating: 1000,
    replicates: 400,
    seed: 'rating/elo.test/bootstrap',
  });
  for (const id of ids) {
    const interval = boot.intervals[id];
    assert.ok(interval.low <= truth[id] && truth[id] <= interval.high, `${id} interval covers truth`);
  }
  assert.equal(boot.intervals.P0.low, 1000);
  assert.equal(boot.intervals.P0.high, 1000);
  assert.ok(boot.divergentReplicates >= 0);
});

test('all-wins input throws the named error: no finite maximum', () => {
  const games = Array.from({ length: 10 }, () => ({ a: 'A', b: 'B', score: 1 }));
  assert.throws(
    () => fitRatings(games, { anchorPlayer: 'B', anchorRating: 1000 }),
    (err) => {
      assert.ok(err instanceof EloFitError);
      assert.equal(err.code, 'DIVERGENT');
      assert.match(err.message, /no finite maximum/);
      return true;
    }
  );
  assert.throws(
    () => twoPlayerClosedForm(10, 10),
    (err) => err instanceof EloFitError && err.code === 'DIVERGENT'
  );
});

test('a player absent from the anchor graph is reported as unidentified', () => {
  const games = [
    { a: 'A', b: 'B', score: 1 },
    { a: 'A', b: 'B', score: 0 },
    { a: 'A', b: 'B', score: 0.5 },
  ];
  assert.throws(
    () => fitRatings(games, { anchorPlayer: 'C', anchorRating: 1000 }),
    (err) => err instanceof EloFitError && err.code === 'UNIDENTIFIED'
  );
});

test('a disconnected pair of players is unidentified, not silently shifted', () => {
  // A-B results plus C-D results, anchored at A: C and D float freely.
  const games = [
    { a: 'A', b: 'B', score: 1 },
    { a: 'A', b: 'B', score: 0 },
    { a: 'C', b: 'D', score: 0.5 },
    { a: 'C', b: 'D', score: 0.5 },
  ];
  assert.throws(
    () => fitRatings(games, { anchorPlayer: 'A', anchorRating: 1000 }),
    (err) => err instanceof EloFitError && err.code === 'UNIDENTIFIED'
  );
});

test('rungForTrajectory names the rung by game id and tier', () => {
  assert.equal(
    rungForTrajectory({ game: { id: 'chess' }, tier: 'paper' }),
    'chess-paper'
  );
  assert.equal(
    rungForTrajectory({ game: { id: 'chess-stockfish' }, tier: 'sf-10k' }),
    'chess-stockfish-sf-10k'
  );
});

test('rateAgent recovers the closed-form rating against fixed rungs', () => {
  /** @type {import('./elo.js').RatingLadder} */
  const ladder = {
    ratings: { 'chess-paper': 1000, 'chess-wood': 1085 },
    anchorRung: 'chess-paper',
  };
  // 3 wins, 1 draw, 1 loss vs paper; 2 draws vs wood.
  /** @param {string} tier @param {number} seat @param {number} score */
  const make = (tier, seat, score) => ({
    game: { id: 'chess' },
    tier,
    agent: { seat },
    end: { outcome: { normalized: seat === 0 ? [score, 1 - score] : [1 - score, score] } },
  });
  const trajectories = [
    make('paper', 0, 1),
    make('paper', 1, 1),
    make('paper', 0, 1),
    make('paper', 1, 0.5),
    make('paper', 0, 0),
    make('wood', 0, 0.5),
    make('wood', 1, 0.5),
  ];
  const rating = rateAgent(trajectories, ladder, { replicates: 400 });
  // Single-parameter MLE: score equation sum(s_i - E(r, R_i)) = 0.
  const total = trajectories.reduce(
    (acc, t) => acc + t.end.outcome.normalized[t.agent.seat],
    0
  );
  // Bisection ground truth.
  /** @param {number} r @returns {number} */
  const f = (r) =>
    trajectories.reduce(
      (acc, t) =>
        acc +
        (t.end.outcome.normalized[t.agent.seat] -
          expectedScore(r, ladder.ratings[rungForTrajectory(t)])),
      0
    );
  let lo = -2000;
  let hi = 2000;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  const value = rating.rating;
  assert.ok(typeof value === 'number', 'mixed score must give a finite rating');
  assert.ok(Math.abs(value - (lo + hi) / 2) < 1e-6);
  // A bootstrap replicate can be all-wins (unbounded above) or all-losses
  // (unbounded below); null bounds mean exactly that.
  assert.ok(
    (rating.low === null || rating.low < value) &&
      (rating.high === null || value < rating.high),
    `interval should bracket the point estimate: [${rating.low}, ${rating.high}] vs ${value}`
  );
  assert.equal(rating.games, trajectories.length);
  assert.equal(rating.scores['chess-paper'], total - 1); // 2 draws vs wood.
});

test('rateAgent reports the divergence direction for an agent with no points', () => {
  const ladder = {
    ratings: { 'chess-paper': 1000 },
    anchorRung: 'chess-paper',
  };
  const trajectories = [
    { game: { id: 'chess' }, tier: 'paper', agent: { seat: 0 }, end: { outcome: { normalized: [0, 1] } } },
    { game: { id: 'chess' }, tier: 'paper', agent: { seat: 1 }, end: { outcome: { normalized: [1, 0] } } },
  ];
  const rating = rateAgent(trajectories, ladder, { replicates: 50 });
  assert.equal(rating.rating, null);
  assert.equal(rating.direction, 'loses-everything');
  assert.equal(rating.low, null); // unbounded below
  assert.equal(rating.high, null);
});

test('rateAgent on the built-in greedy baseline against the paper rung', async () => {
  // Real episodes through the runner; no Stockfish needed (paper is a
  // built-in engine tier). The greedy baseline is weak: PR #30 calibration
  // measured ~0 score for it on nearly every chess tier, so the test only
  // asserts internal consistency between the raw score and the rating.
  const tier = chess.spec.tiers.find((t) => t.id === 'paper');
  /** @type {any[]} */
  const trajectories = [];
  for (let index = 0; index < 3; index++) {
    const seed = `chess/paper/public/${index}`;
    const trajectory = await runEpisode({
      game: chess,
      tierId: 'paper',
      seed,
      agent: createGreedyBaselineAgent({
        id: 'rating-greedy-probe',
        episodeSeed: seed,
      }),
      maxConsecutiveInvalid: 2,
    });
    trajectories.push(trajectory);
  }
  const ladder = {
    ratings: { 'chess-paper': 1000 },
    anchorRung: 'chess-paper',
  };
  const rating = rateAgent(trajectories, ladder, { replicates: 400 });
  const totalScore = trajectories.reduce(
    (acc, t) => acc + t.end.outcome.normalized[t.agent.seat],
    0
  );
  assert.equal(rating.games, 3);
  assert.equal(rating.scores['chess-paper'], totalScore);
  if (totalScore <= 0) {
    assert.equal(rating.direction, 'loses-everything');
    assert.equal(rating.rating, null);
  } else if (totalScore >= 3) {
    assert.equal(rating.direction, 'wins-everything');
    assert.equal(rating.rating, null);
  } else {
    assert.equal(rating.direction, null);
    const value = rating.rating;
    assert.ok(typeof value === 'number', 'finite score must give a finite rating');
    assert.ok(Math.abs(value - 1000 - 400 * Math.log10(totalScore / (3 - totalScore))) < 0.01);
    const low = rating.low;
    const high = rating.high;
    assert.ok(low !== null && low <= value, 'lower bound below the point estimate');
    assert.ok(high !== null && value <= high, 'upper bound above the point estimate');
  }
});
