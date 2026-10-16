/**
 * Maximum-likelihood Elo ratings for the Gauntlet chess ladder.
 *
 * Model: Bradley-Terry extended with draws counted as half points. Each
 * result is one Bernoulli trial whose success probability is the Elo
 * expected score of the pairing,
 *
 *     p = 1 / (1 + 10^((Rb - Ra) / 400)),
 *
 * and a game contributes score s in {0, 1/2, 1} from player a's point of
 * view. The maximum-likelihood ratings maximise
 *
 *     sum_i  s_i log p_i + (1 - s_i) log (1 - p_i),
 *
 * subject to one rung's rating being pinned (the anchor); without an anchor
 * the likelihood is invariant under a common shift, so no fit exists. The
 * fit is a standard logistic-regression IRLS (Newton) iteration on the free
 * ratings; the two-player case has the closed form
 *
 *     Ra - Rb = 400 log10(s / (n - s))    for 0 < s < n,
 *
 * and degenerates when s = 0 or s = n: the likelihood has no finite maximum
 * (the winner's rating diverges to +infinity). All-wins input is reported as
 * the named `EloFitError` with code `DIVERGENT`, never as a number.
 *
 * Uncertainty: nonparametric bootstrap over games — resample the result
 * list with replacement, refit, and take the 2.5/97.5 percentiles per
 * player. Replicates that diverge (a resample can be all-wins even when the
 * data are not) are re-drawn a bounded number of times and otherwise left
 * out; the count is reported.
 *
 * `rateAgent` turns an agent's recorded chess and chess-stockfish
 * trajectories into a rating and interval with every rung rating held
 * fixed, so agents never move the ladder.
 *
 * No `node:*` imports; browser-loadable like `gauntlet/core`.
 *
 * @module
 */

import { nextInt, rngFromSeed } from '../core/rng.js';

/** @import { RngState } from '../core/rng.js' */

/**
 * Named fitting failure. `code` is one of:
 *  - `DIVERGENT`: the likelihood has no finite maximum — some player (or
 *    group of players) won or lost every game, so their rating tends to
 *    plus/minus infinity. This is the all-wins case.
 *  - `UNIDENTIFIED`: the results do not connect every player to the anchor,
 *    so some rating combination leaves the likelihood unchanged.
 */
export class EloFitError extends Error {
  /**
   * @param {'DIVERGENT' | 'UNIDENTIFIED'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'EloFitError';
    this.code = code;
  }
}

/**
 * One game result from `a`'s perspective.
 *
 * @typedef {object} GameResult
 * @property {string} a
 * @property {string} b
 * @property {number} score 0, 0.5 or 1 from a's perspective.
 */

/**
 * Fit options.
 *
 * @typedef {object} FitOptions
 * @property {string} anchorPlayer The player whose rating is declared.
 * @property {number} [anchorRating] Default 1000.
 * @property {number} [maxIterations] Newton iterations. Default 300.
 * @property {number} [tolerance] Convergence tolerance on gradient inf-norm.
 *   Default 1e-10.
 */

/**
 * Validate a result list shape.
 *
 * @param {readonly GameResult[]} games
 * @param {string} anchorPlayer
 * @returns {{ players: string[], nGames: number }}
 */
function validateGames(games, anchorPlayer) {
  if (!Array.isArray(games) || games.length === 0) {
    throw new EloFitError(
      'DIVERGENT',
      'no games to fit: an empty result list has no finite maximum-likelihood rating'
    );
  }
  /** @type {Set<string>} */
  const players = new Set();
  for (const [index, game] of games.entries()) {
    if (typeof game.a !== 'string' || typeof game.b !== 'string') {
      throw new TypeError(`games[${index}]: a and b must be player ids`);
    }
    if (game.a === game.b) {
      throw new TypeError(`games[${index}]: a player cannot play itself`);
    }
    if (
      typeof game.score !== 'number' ||
      !(game.score >= 0 && game.score <= 1)
    ) {
      throw new TypeError(
        `games[${index}]: score must be a number in [0, 1], got ${JSON.stringify(game.score)}`
      );
    }
    players.add(game.a);
    players.add(game.b);
  }
  if (!players.has(anchorPlayer)) {
    throw new EloFitError(
      'UNIDENTIFIED',
      `anchor player "${anchorPlayer}" appears in no game; the results do not connect to the anchor`
    );
  }
  return { players: [...players], nGames: games.length };
}

/**
 * Elo expected score of a against b.
 *
 * @param {number} ra
 * @param {number} rb
 * @returns {number}
 */
export function expectedScore(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

/**
 * The two-player closed form: the MLE rating difference for n games with a
 * total score s (from a's perspective) is 400*log10(s / (n - s)).
 *
 * @param {number} score Total score of player a across the games.
 * @param {number} n Number of games.
 * @returns {number} Ra - Rb in Elo points.
 */
export function twoPlayerClosedForm(score, n) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError(`n must be a positive integer, got ${n}`);
  }
  if (score <= 0 || score >= n) {
    throw new EloFitError(
      'DIVERGENT',
      `no finite maximum-likelihood rating: total score ${score} of ${n} games is all-wins or all-losses, and the likelihood has no finite maximum`
    );
  }
  return 400 * Math.log10(score / (n - score));
}

/**
 * Solve a small dense symmetric positive-definite system (X^T W X) dx = rhs
 * by Gaussian elimination with partial pivoting. Throws EloFitError when a
 * pivot is numerically singular (an unidentifiable direction).
 *
 * @param {number[][]} matrix
 * @param {number[]} rhs
 * @param {number} singularTolerance
 * @returns {number[]}
 */
function solveSymmetric(matrix, rhs, singularTolerance) {
  const n = rhs.length;
  /** @type {number[][]} */
  const m = matrix.map((row) => [...row]);
  const y = [...rhs];
  for (let col = 0; col < n; col++) {
    // Partial pivot.
    let best = col;
    let bestAbs = Math.abs(m[col][col]);
    for (let row = col + 1; row < n; row++) {
      const abs = Math.abs(m[row][col]);
      if (abs > bestAbs) {
        best = row;
        bestAbs = abs;
      }
    }
    if (!(bestAbs > singularTolerance)) {
      throw new EloFitError(
        'UNIDENTIFIED',
        'the result matrix is singular: some rating direction is unidentified (disconnected from the anchor or all scores constant along it)'
      );
    }
    if (best !== col) {
      [m[col], m[best]] = [m[best], m[col]];
      [y[col], y[best]] = [y[best], y[col]];
    }
    const pivot = m[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = m[row][col] / pivot;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) m[row][k] -= factor * m[col][k];
      y[row] -= factor * y[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let acc = y[row];
    for (let k = row + 1; k < n; k++) acc -= m[row][k] * x[k];
    x[row] = acc / m[row][row];
  }
  return x;
}

/**
 * @typedef {object} FitResult
 * @property {Record<string, number>} ratings Player id -> Elo rating. The
 *   anchor is exactly `anchorRating`.
 * @property {number} iterations Newton iterations used.
 * @property {number} gradientInfNorm Final gradient inf-norm.
 */

/**
 * Maximum-likelihood ratings for a result list. See the module doc for the
 * model. Throws `EloFitError` (code `DIVERGENT`) for input with no finite
 * maximum — including the all-wins case — and (code `UNIDENTIFIED`) when the
 * games do not pin every player to the anchor.
 *
 * @param {readonly GameResult[]} games
 * @param {FitOptions} options
 * @returns {FitResult}
 */
export function fitRatings(games, options) {
  const { anchorPlayer } = options;
  const anchorRating = options.anchorRating ?? 1000;
  const maxIterations = options.maxIterations ?? 300;
  const tolerance = options.tolerance ?? 1e-10;
  const { players, nGames } = validateGames(games, anchorPlayer);

  // Design in natural-logit units: x = rating * ln(10) / 400, so
  // p = 1 / (1 + exp(xb - xa)).
  const LOGIT_SCALE = Math.LN10 / 400;
  const free = players.filter((p) => p !== anchorPlayer);
  const indexOf = new Map(players.map((p, i) => [p, i]));
  const freeIndex = new Map(free.map((p, i) => [p, i]));

  /** @type {number[]} x vector over `players`, natural-logit units. */
  const x = players.map(() => 0);
  const anchorIndex = /** @type {number} */ (indexOf.get(anchorPlayer));
  x[anchorIndex] = anchorRating * LOGIT_SCALE;

  /** Per game: the player indexes of a and b (validated to exist). */
  const sign = /** @type {Array<[number, number]>} */ (
    games.map((g) => [indexOf.get(g.a), indexOf.get(g.b)])
  );

  // Divergence guard matches the ±40 logit clamp in logLikelihood: beyond
  // 40 logit units (~6900 Elo) the likelihood is flat, so a direction that
  // still improves it is the all-wins / all-losses signature. Real ladders
  // with several near-sweep pairs chain large gaps (a 200-game run with
  // 0/40, 1/40, 2/40 pair scores places rungs ~2400 Elo apart), so the limit
  // must sit well above any legitimate solution.
  const DIVERGENCE_LIMIT = 40;
  const MAX_STEP = 2; // logit units per iteration (~347 Elo); damped below.

  /**
   * Log-likelihood at a candidate x (natural units).
   * @param {number[]} candidate
   * @returns {number}
   */
  function logLikelihood(candidate) {
    let ll = 0;
    for (let i = 0; i < nGames; i++) {
      const [ia, ib] = sign[i];
      const eta = Math.max(-40, Math.min(40, candidate[ib] - candidate[ia]));
      const p = 1 / (1 + Math.exp(eta));
      const s = games[i].score;
      ll += s * Math.log(p) + (1 - s) * Math.log(1 - p);
    }
    return ll;
  }

  let iterations = 0;
  let gradInfNorm = Number.POSITIVE_INFINITY;
  let infoTrace = Number.NaN;
  let currentLl = logLikelihood(x);

  for (iterations = 1; iterations <= maxIterations; iterations++) {
    // Gradient and Gauss-Newton (Fisher) information over free coordinates.
    const nf = free.length;
    if (nf === 0) break;
    const grad = new Array(nf).fill(0);
    const info = Array.from({ length: nf }, () => new Array(nf).fill(0));
    for (let i = 0; i < nGames; i++) {
      const [ia, ib] = sign[i];
      const eta = x[ib] - x[ia];
      const p = 1 / (1 + Math.exp(eta));
      const s = games[i].score;
      const w = p * (1 - p);
      const ja = freeIndex.get(players[ia]);
      const jb = freeIndex.get(players[ib]);
      if (ja !== undefined) grad[ja] += s - p;
      if (jb !== undefined) grad[jb] -= s - p;
      for (let r = 0; r < nf; r++) {
        const vr = (r === ja ? 1 : 0) - (r === jb ? 1 : 0);
        if (vr === 0) continue;
        for (let c = 0; c < nf; c++) {
          const vc = (c === ja ? 1 : 0) - (c === jb ? 1 : 0);
          if (vc === 0) continue;
          info[r][c] += w * vr * vc;
        }
      }
    }
    gradInfNorm = Math.max(...grad.map((g) => Math.abs(g)));
    infoTrace = info.reduce((acc, row, r) => acc + row[r], 0);
    if (gradInfNorm < tolerance) break;

    const rawStep = solveSymmetric(info, grad, 1e-12);
    // Damped Newton: cap the raw step (the Fisher information is near zero
    // at a cold start, so the raw step can be hundreds of Elo), then
    // back-track on the log-likelihood so every accepted step improves it.
    let scale = Math.min(
      1,
      MAX_STEP / Math.max(...rawStep.map((v) => Math.abs(v)), MAX_STEP)
    );
    let accepted = false;
    for (let backtrack = 0; backtrack < 60; backtrack++) {
      const trial = [...x];
      for (let r = 0; r < nf; r++) {
        trial[players.indexOf(free[r])] += scale * rawStep[r];
      }
      const trialLl = logLikelihood(trial);
      const escapes =
        Math.max(...trial.map((v) => Math.abs(v))) >= DIVERGENCE_LIMIT;
      if (escapes && trialLl > currentLl) {
        // The iteration is running away while the likelihood keeps
        // improving: the MLE is at infinity (all-wins / all-losses shape),
        // not a finite rating.
        throw new EloFitError(
          'DIVERGENT',
          'no finite maximum-likelihood rating: the likelihood keeps improving along a diverging direction (typically a player or connected group that won or lost every game — the all-wins case)'
        );
      }
      if (trialLl > currentLl) {
        for (let r = 0; r < nf; r++) {
          x[players.indexOf(free[r])] = trial[players.indexOf(free[r])];
        }
        currentLl = trialLl;
        accepted = true;
        break;
      }
      scale /= 2;
    }
    if (!accepted) {
      // No step along the Newton direction improves the likelihood: either
      // converged to numerical precision or the MLE is at infinity.
      if (gradInfNorm > 1e-4) {
        throw new EloFitError(
          'DIVERGENT',
          'no finite maximum-likelihood rating: the likelihood keeps improving along a diverging direction (typically a player or connected group that won or lost every game — the all-wins case)'
        );
      }
      break;
    }
  }

  if (iterations > maxIterations && gradInfNorm >= tolerance) {
    throw new EloFitError(
      'DIVERGENT',
      `no finite maximum-likelihood rating found within ${maxIterations} Newton iterations (gradient inf-norm ${gradInfNorm.toExponential(2)})`
    );
  }

  // A converged fit must not be curvature-free. At a saturated point
  // (typically a player or connected group that won or lost every game)
  // the sigmoid underflows in float64 before the ±40 clamp is reached:
  // the gradient reads zero and the information matrix is numerically
  // zero, so the loop reports convergence even though the MLE is at
  // infinity. A genuine interior optimum keeps O(1) curvature per game,
  // so a near-zero information trace is the all-wins signature.
  if (free.length > 0 && infoTrace < 1e-8 && gradInfNorm < tolerance) {
    throw new EloFitError(
      'DIVERGENT',
      'no finite maximum-likelihood rating: the likelihood is numerically flat at the solution — the information matrix is zero, so the optimum lies at infinity (typically a player or connected group that won or lost every game — the all-wins case)'
    );
  }

  // A converged fit must not sit at the clamp boundary: at ±40 logit units
  // the sigmoid saturates to float64 precision, the gradient underflows to
  // zero, and the loop reports convergence — but the likelihood is flat
  // there precisely because the MLE is at infinity (the all-wins shape).
  // Legitimate ratings are nowhere near ±40 logits.
  if (Math.max(...x.map((v) => Math.abs(v))) >= DIVERGENCE_LIMIT) {
    throw new EloFitError(
      'DIVERGENT',
      'no finite maximum-likelihood rating: the fit reached the ±40 logit saturation boundary where the likelihood is flat (typically a player or connected group that won or lost every game — the all-wins case)'
    );
  }

  /** @type {Record<string, number>} */
  const ratings = {};
  for (const player of players) {
    ratings[player] = x[/** @type {number} */ (indexOf.get(player))] / LOGIT_SCALE;
  }
  ratings[anchorPlayer] = anchorRating;
  return { ratings, iterations, gradientInfNorm: gradInfNorm };
}

/**
 * Bootstrap options.
 *
 * @typedef {object} BootstrapOptions
 * @property {string} anchorPlayer
 * @property {number} [anchorRating] Default 1000.
 * @property {number} [replicates] Default 2000.
 * @property {string} [seed] RNG seed text for reproducible resampling.
 * @property {number} [maxRedraws] Bounded re-draws of a diverging replicate.
 *   Default 4.
 */

/**
 * @typedef {object} BootstrapResult
 * @property {Record<string, { low: number, high: number, mean: number }>} intervals
 *   Percentile 95% interval per player (anchor has zero width).
 * @property {number} replicates Replicates actually fitted.
 * @property {number} divergentReplicates Replicates discarded as divergent
 *   after their bounded re-draws.
 */

/**
 * Nonparametric bootstrap 95% intervals, resampling games with replacement
 * and refitting each replicate. Deterministic for a given seed.
 *
 * @param {readonly GameResult[]} games
 * @param {BootstrapOptions & Pick<FitOptions, 'maxIterations' | 'tolerance'>} options
 * @returns {BootstrapResult}
 */
export function bootstrapRatings(games, options) {
  const { anchorPlayer } = options;
  const anchorRating = options.anchorRating ?? 1000;
  const replicates = options.replicates ?? 2000;
  const maxRedraws = options.maxRedraws ?? 4;
  const seed = options.seed ?? 'gauntlet/rating/bootstrap';
  const { players } = validateGames(games, anchorPlayer);
  const nGames = games.length;

  /** @type {Record<string, number[]>} */
  const samples = {};
  for (const player of players) samples[player] = [];
  let fitted = 0;
  let divergent = 0;
  for (let r = 0; r < replicates; r++) {
    /** @type {GameResult[]} */
    let resample = [];
    let ok = false;
    for (let attempt = 0; attempt <= maxRedraws && !ok; attempt++) {
      let rngState = rngFromSeed(`${seed}/${r}/${attempt}`);
      resample = games.map(() => {
        const draw = nextInt(rngState, 0, nGames - 1);
        rngState = draw.state;
        return games[draw.value];
      });
      try {
        const fit = fitRatings(resample, {
          anchorPlayer,
          anchorRating,
          maxIterations: options.maxIterations,
          tolerance: options.tolerance,
        });
        for (const player of players) samples[player].push(fit.ratings[player]);
        fitted++;
        ok = true;
      } catch (err) {
        if (!(err instanceof EloFitError)) throw err;
        // Divergent resample: re-draw, then count it and move on.
      }
    }
    if (!ok) divergent++;
  }

  /** @type {Record<string, { low: number, high: number, mean: number }>} */
  const intervals = {};
  for (const player of players) {
    if (player === anchorPlayer) {
      intervals[player] = { low: anchorRating, high: anchorRating, mean: anchorRating };
      continue;
    }
    const xs = samples[player].sort((a, b) => a - b);
    const low = xs[Math.floor(0.025 * (xs.length - 1))];
    const high = xs[Math.ceil(0.975 * (xs.length - 1))];
    const mean = xs.reduce((acc, v) => acc + v, 0) / Math.max(1, xs.length);
    intervals[player] = { low, high, mean };
  }
  return { intervals, replicates: fitted, divergentReplicates: divergent };
}

/**
 * A fitted ladder: rung ratings on the Elo scale, with the anchor rung
 * declared. Produced by the ladder run (see `ladder.js`) or assembled by
 * hand from `LADDER-RATINGS.md`.
 *
 * @typedef {object} RatingLadder
 * @property {Record<string, number>} ratings Rung id -> fixed Elo rating.
 * @property {string} anchorRung The rung whose rating is declared.
 */

/**
 * Map a trajectory to its ladder rung: the opponent the trajectory was
 * played against is identified by the game id plus tier id, e.g.
 * `chess-paper`, `chess-stockfish-sf-10k`.
 *
 * @param {{ game: { id: string }, tier: string }} trajectory
 * @returns {string}
 */
export function rungForTrajectory(trajectory) {
  return `${trajectory.game.id}-${trajectory.tier}`;
}

/**
 * Pre-filter trajectories to those whose rung has a fitted ladder rating:
 * `rateAgent` refuses a single unknown rung, and real run directories mix
 * in non-chess games and chess tiers above the fitted ladder. The skipped
 * rungs are reported so callers can say what was left out and why.
 *
 * @param {readonly AgentTrajectory[]} trajectories
 * @param {RatingLadder} ladder
 * @returns {{ known: AgentTrajectory[], skippedRungs: string[] }} `known` in
 *   input order; `skippedRungs` the unique unknown rung ids, first-seen
 *   order.
 */
export function selectLadderKnown(trajectories, ladder) {
  /** @type {AgentTrajectory[]} */
  const known = [];
  /** @type {Set<string>} */
  const skipped = new Set();
  for (const trajectory of trajectories) {
    const rung = rungForTrajectory(trajectory);
    if (typeof ladder.ratings[rung] === 'number') known.push(trajectory);
    else skipped.add(rung);
  }
  return { known, skippedRungs: [...skipped] };
}

/**
 * A minimal trajectory slice `rateAgent` needs. Structurally compatible
 * with the runner's recorded trajectories.
 *
 * @typedef {object} AgentTrajectory
 * @property {{ id: string }} game
 * @property {string} tier
 * @property {{ id?: string, seat: number }} agent Seat the agent played;
 *   runner-recorded trajectories also carry the agent id (rateAgent reads
 *   only the seat).
 * @property {{ outcome: { normalized: number[] } | null }} end
 */

/**
 * @typedef {object} AgentRating
 * @property {number | null} rating Elo rating, or null when divergent (then
 *   `direction` says which way the likelihood diverges).
 * @property {number | null} low Bootstrap 95% lower bound (null when
 *   unbounded below).
 * @property {number | null} high Bootstrap 95% upper bound (null when
 *   unbounded above).
 * @property {'wins-everything' | 'loses-everything' | null} direction
 * @property {number} games Number of trajectories used.
 * @property {Record<string, number>} scores Per-rung game count and score.
 */

/**
 * Rate one agent from its chess and chess-stockfish trajectories, holding
 * every rung rating in `ladder` fixed. Draws count as half a point. An
 * agent that won or lost every game has no finite maximum-likelihood
 * rating; that is reported as `rating: null` with the divergence direction
 * instead of a misleading finite number.
 *
 * The 95% interval bootstraps over the agent's trajectories (rung ratings
 * stay fixed; only the agent's single parameter is refit). Replicates that
 * diverge contribute an unbounded end.
 *
 * @param {readonly AgentTrajectory[]} trajectories
 * @param {RatingLadder} ladder
 * @param {{ replicates?: number, seed?: string }} [options]
 * @returns {AgentRating}
 */
export function rateAgent(trajectories, ladder, options = {}) {
  const replicates = options.replicates ?? 2000;
  const seed = options.seed ?? 'gauntlet/rating/agent';
  const games = trajectories.map((t) => {
    const rung = rungForTrajectory(t);
    const rating = ladder.ratings[rung];
    if (typeof rating !== 'number') {
      throw new Error(
        `rateAgent: ladder has no rating for rung "${rung}" (trajectory game ${t.game.id}, tier ${t.tier})`
      );
    }
    const seat = t.agent?.seat;
    const normalized = t.end?.outcome?.normalized;
    if (
      !Number.isInteger(seat) ||
      !Array.isArray(normalized) ||
      normalized.length < seat + 1
    ) {
      throw new Error(
        `rateAgent: trajectory ${t.game.id}/${t.tier} has no finished outcome for agent seat ${JSON.stringify(seat)}`
      );
    }
    const score = normalized[seat];
    if (!Number.isFinite(score)) {
      throw new Error(
        `rateAgent: trajectory ${t.game.id}/${t.tier} has a non-finite score ${score} at seat ${seat}`
      );
    }
    return { rung, rating, score };
  });
  if (games.length === 0) {
    throw new EloFitError('DIVERGENT', 'no trajectories to rate: an agent with no games has no finite rating');
  }

  /** @type {Record<string, number>} */
  const scores = {};
  for (const game of games) {
    scores[game.rung] = (scores[game.rung] ?? 0) + game.score;
  }
  const totalScore = games.reduce((acc, g) => acc + g.score, 0);
  const n = games.length;

  /**
   * @param {number} rating Agent rating hypothesis.
   * @returns {number} sum(s_i - p_i); positive -> increase rating.
   */
  function gradient(rating) {
    return games.reduce(
      (acc, g) => acc + (g.score - expectedScore(rating, g.rating)),
      0
    );
  }

  /**
   * Scalar MLE by bisection on the monotone score equation.
   * @returns {number}
   */
  function solveScalar() {
    if (totalScore <= 0 || totalScore >= n) {
      throw new EloFitError('DIVERGENT', 'all-wins or all-losses input');
    }
    let lo = -2400;
    let hi = 2400;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (gradient(mid) > 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** @returns {{ rating: number | null, direction: AgentRating['direction'] }} */
  function pointEstimate() {
    try {
      return { rating: solveScalar(), direction: null };
    } catch (err) {
      if (!(err instanceof EloFitError)) throw err;
      return {
        rating: null,
        direction: totalScore >= n ? 'wins-everything' : 'loses-everything',
      };
    }
  }

  const point = pointEstimate();
  if (point.direction !== null) {
    // An agent with every win or every loss has no finite
    // maximum-likelihood rating and no bounded interval; bootstrap
    // percentiles would just echo the divergence.
    return {
      rating: null,
      low: null,
      high: null,
      direction: point.direction,
      games: n,
      scores,
    };
  }

  // Bootstrap over the agent's games, rung ratings fixed.
  const { players: rungsPlayed } = (() => {
    const seen = new Set(games.map((g) => g.rung));
    return { players: [...seen] };
  })();
  /** @type {Record<string, number[]>} */
  const perRungIndex = {};
  for (const rung of rungsPlayed) {
    perRungIndex[rung] = [];
  }
  games.forEach((g, i) => perRungIndex[g.rung].push(i));
  const lows = [];
  const highs = [];
  for (let r = 0; r < replicates; r++) {
    const state = rngFromSeed(`${seed}/${r}`);
    /** @type {number[]} */
    const drawnScores = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const source = nextInt(state, 0, n - 1).value;
      drawnScores[source] += 1;
    }
    // Aggregate drawn scores per rung.
    const replicateTotal = games.reduce(
      (acc, g, i) => acc + drawnScores[i] * g.score,
      0
    );
    const replicateCount = drawnScores.reduce((acc, c) => acc + c, 0);
    if (replicateTotal <= 0) {
      lows.push(Number.NEGATIVE_INFINITY);
      highs.push(Number.NEGATIVE_INFINITY);
      continue;
    }
    if (replicateTotal >= replicateCount) {
      lows.push(Number.POSITIVE_INFINITY);
      highs.push(Number.POSITIVE_INFINITY);
      continue;
    }
    // Solve the aggregated score equation across the rungs played.
    let lo = -2400;
    let hi = 2400;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      const grad = rungsPlayed.reduce((acc, rung) => {
        const rating = ladder.ratings[rung];
        const count = perRungIndex[rung].reduce(
          (acc2, idx) => acc2 + drawnScores[idx],
          0
        );
        const scoreSum = perRungIndex[rung].reduce(
          (acc2, idx) => acc2 + drawnScores[idx] * games[idx].score,
          0
        );
        return acc + (scoreSum - count * expectedScore(mid, rating));
      }, 0);
      if (grad > 0) lo = mid;
      else hi = mid;
    }
    const estimate = (lo + hi) / 2;
    lows.push(estimate);
    highs.push(estimate);
  }
  lows.sort((a, b) => a - b);
  highs.sort((a, b) => a - b);
  const low = lows[Math.floor(0.025 * (lows.length - 1))];
  const high = highs[Math.ceil(0.975 * (highs.length - 1))];

  return {
    rating: point.rating,
    low: Number.isFinite(low) ? low : null,
    high: Number.isFinite(high) ? high : null,
    direction: point.direction,
    games: n,
    scores,
  };
}
