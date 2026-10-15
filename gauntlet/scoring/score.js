/**
 * Scoring for PlayKit Gauntlet: one entry's trajectories against a suite
 * manifest, following the design-doc rules verbatim.
 *
 * - Episode score e. Outcome tier: `e = outcome.normalized[agentSeat]`.
 *   Efficiency tier: `e = solved ? min(cap, (par / agentActions)^2) : 0`,
 *   where `agentActions` counts every attempt including invalid ones, and
 *   `cap` is 1.0 for `parKind: "optimal"` and 1.15 for `"reference"`
 *   (ARC-AGI-3's RHAE squares the ratio and caps at 1.15).
 * - Tier score T. Mean of e over the tier's seeds; on an efficiency tier
 *   `T = min(solvedFraction, mean e)`.
 * - Game score G. `sum(rank_t * T_t) / sum(rank_t)` over the game's tiers.
 * - Benchmark score B. Unweighted mean of G over games with
 *   `spec.benchmark === true`.
 * - Uncertainty. Percentile bootstrap 95% intervals from 10,000 seeded
 *   resamples of episodes within each tier, carried to G and B by resampling
 *   every tier together (one joint resample per draw preserves within-entry
 *   tier correlation). The resampler is the core RNG, seeded per entry, so
 *   the same entry against the same suite always yields the same intervals.
 * - Ranking eligibility. An entry is ranked only if it covers every game,
 *   tier and seed in the manifest, every trajectory passes
 *   `verifyTrajectory`, and none is a dry run. Cost is reported next to the
 *   score: the sum of agent-step `usage.costUsd`, or "unknown" if any agent
 *   step's cost is null.
 *
 * Inputs that cannot be scored honestly are refused loudly: every refusal
 * throws a `GauntletRefusalError` whose message names the file and the step.
 * Incomplete or dry-run entries are NOT refusals — they are scored over what
 * they cover and reported unranked with a reason.
 *
 * Node-only via `suite.js` (eval seeds); pure otherwise. No `node:*` here.
 *
 * @module
 */

import { verifyTrajectory } from '../core/trajectory.js';
import { streamFromSeed } from '../core/rng.js';
import { SUITE_FORMAT } from './suite.js';

/** @import { Game, Outcome, Trajectory, Usage } from '../core/types.js' */
/** @import { SuiteManifest, SuiteGame, SuiteTier } from './suite.js' */

/**
 * Draws per bootstrap. 10,000, per the design doc.
 *
 * @type {number}
 */
export const BOOTSTRAP_DRAWS = 10_000;

/** Cap on efficiency tiers whose par is a proven optimum. */
export const EFFICIENCY_CAP_OPTIMAL = 1.0;

/** Cap on efficiency tiers whose par is a reference run (RHAE's cap). */
export const EFFICIENCY_CAP_REFERENCE = 1.15;

/**
 * A refusal: this input cannot be scored honestly. The message names the
 * file and the step that refused it.
 */
export class GauntletRefusalError extends Error {
  /**
   * @param {string} file Basename of the refusing file, e.g. "score.js".
   * @param {string} step The check that refused, e.g. "duplicate-episodes".
   * @param {string} message Human-readable detail.
   */
  constructor(file, step, message) {
    super(`[gauntlet/scoring/${file}] ${step}: ${message}`);
    this.name = 'GauntletRefusalError';
    /** @type {string} */
    this.file = `gauntlet/scoring/${file}`;
    /** @type {string} */
    this.step = step;
  }
}

/**
 * @param {string} step
 * @param {string} message
 * @returns {never}
 */
function refuse(step, message) {
  throw new GauntletRefusalError('score.js', step, message);
}

/**
 * One agent's submission.
 *
 * @typedef {object} ScoreEntry
 * @property {{ id: string, track: string, model?: string, provider?: string }} agent
 * @property {Trajectory[]} trajectories
 * @property {string} [saltCommitment] The salt commitment the entry claims it
 *   was run under; must match the suite's when present.
 */

/**
 * A point estimate with a percentile-bootstrap 95% interval.
 *
 * @typedef {object} ScoreWithCI
 * @property {number | null} value
 * @property {[number, number] | null} ci95
 */

/**
 * Per-tier score block.
 *
 * @typedef {object} TierScore
 * @property {ScoreWithCI} score
 * @property {number} episodes Number of trajectories covered.
 * @property {number | null} solvedFraction Solved fraction on efficiency
 *   tiers; null on outcome tiers.
 */

/**
 * Per-game score block.
 *
 * @typedef {object} GameScore
 * @property {ScoreWithCI} score
 * @property {Record<string, TierScore>} tiers
 */

/**
 * The scored result for one entry.
 *
 * @typedef {object} EntryScore
 * @property {{ id: string, track: string, model?: string, provider?: string }} agent
 * @property {boolean} ranked
 * @property {string | null} unrankedReason
 * @property {ScoreWithCI | null} benchmarkScore Null when any benchmark game
 *   is incompletely covered.
 * @property {number | 'unknown'} costUsd
 * @property {number | 'unknown'} costPerEpisodeUsd
 * @property {number} episodes
 * @property {number} invalidActionRate
 * @property {number} meanAgentActions
 * @property {Record<string, GameScore>} games
 */

/**
 * @typedef {object} ScoreOptions
 * @property {{ id: string, track: string, model?: string, provider?: string }} [agent]
 *   The submitting agent. Defaults to the first trajectory's agent record;
 *   every trajectory must then agree with it.
 * @property {string} [saltCommitment] The entry's claimed salt commitment.
 */

/**
 * Accept games as an array, a Map keyed by game id, or a plain record.
 *
 * @param {unknown} games
 * @param {SuiteManifest} suite
 * @returns {Map<string, Game<*>>}
 */
function toGameMap(games, suite) {
  /** @type {Map<string, Game<*>>} */
  let map;
  if (Array.isArray(games)) {
    map = new Map(games.map((g) => [g?.spec?.id, /** @type {Game<*>} */ (g)]));
  } else if (games instanceof Map) {
    map = /** @type {Map<string, Game<*>>} */ (games);
  } else if (games && typeof games === 'object') {
    map = new Map(Object.entries(/** @type {Record<string, Game<*>>} */ (games)));
  } else {
    map = new Map();
  }
  for (const sg of suite.games) {
    const game = map.get(sg.id);
    if (!game || !game.spec) {
      refuse(
        'games-lookup',
        `suite game "${sg.id}" has no implementation in the games argument; scoring needs the game to verify trajectories and read spec.benchmark`
      );
    }
    if (game.spec.version !== sg.version) {
      refuse(
        'games-lookup',
        `suite lists "${sg.id}" version ${sg.version} but the provided game implementation is version ${game.spec.version}`
      );
    }
  }
  return map;
}

/**
 * @param {Trajectory} trajectory
 * @returns {number | null} Sum of agent-step costs; null when any is unknown.
 */
function trajectoryCost(trajectory) {
  let sum = 0;
  for (const step of trajectory.steps) {
    if (step.by !== 'agent') continue;
    const usage = /** @type {Usage | null} */ (step.usage);
    if (!usage || typeof usage.costUsd !== 'number' || !Number.isFinite(usage.costUsd)) {
      return null;
    }
    sum += usage.costUsd;
  }
  return sum;
}

/**
 * Episode score e and its solved flag, from one verified trajectory.
 *
 * @param {SuiteTier} tier
 * @param {Trajectory} trajectory
 * @returns {{ e: number, solved: boolean }}
 */
function episodeScore(tier, trajectory) {
  const outcome = /** @type {Outcome | null} */ (trajectory.end.outcome);
  const seat = trajectory.agent.seat;
  if (tier.scoring === 'outcome') {
    const normalized = outcome?.normalized;
    if (!Array.isArray(normalized) || typeof normalized[seat] !== 'number' || !Number.isFinite(normalized[seat])) {
      refuse(
        'episode-score',
        `trajectory ${trajectory.game.id}/${trajectory.tier}/${trajectory.seed} ended without a finite normalized[${seat}] on an outcome tier`
      );
    }
    return { e: /** @type {number} */ (normalized[seat]), solved: false };
  }

  // Efficiency tier.
  const solved = outcome?.solved === true;
  if (!solved) {
    return { e: 0, solved: false };
  }
  const par = outcome?.par;
  if (typeof par !== 'number' || !Number.isFinite(par) || par <= 0) {
    refuse(
      'efficiency-par',
      `trajectory ${trajectory.game.id}/${trajectory.tier}/${trajectory.seed} claims solved but carries par ${JSON.stringify(par)}; cannot score honestly`
    );
  }
  const agentActions = trajectory.end.agentActions;
  if (!Number.isInteger(agentActions) || agentActions <= 0) {
    refuse(
      'efficiency-par',
      `trajectory ${trajectory.game.id}/${trajectory.tier}/${trajectory.seed} claims solved with agentActions ${JSON.stringify(agentActions)}; cannot score honestly`
    );
  }
  const cap = tier.parKind === 'optimal' ? EFFICIENCY_CAP_OPTIMAL : EFFICIENCY_CAP_REFERENCE;
  return { e: Math.min(cap, (par / agentActions) ** 2), solved: true };
}

/**
 * Percentile of a sorted numeric array, with linear interpolation.
 *
 * @param {number[]} sorted Ascending, non-empty.
 * @param {number} q In [0, 1].
 * @returns {number}
 */
function percentile(sorted, q) {
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * @param {number[]} values Raw draw values.
 * @returns {[number, number] | null} 2.5th and 97.5th percentiles, or null
 *   when there are no finite draws.
 */
function ci95(values) {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  return [percentile(finite, 0.025), percentile(finite, 0.975)];
}

/**
 * @param {number | null} value
 * @param {[number, number] | null} interval
 * @returns {ScoreWithCI}
 */
function withCI(value, interval) {
  return { value, ci95: interval };
}

/**
 * Round for output: keeps JSON free of float noise without hiding signal.
 *
 * @param {number | null} v
 * @returns {number | null}
 */
function round6(v) {
  return v === null ? null : Math.round(v * 1e6) / 1e6;
}

/**
 * @param {[number, number] | null} interval
 * @returns {[number, number] | null}
 */
function roundCI(interval) {
  return interval
    ? [/** @type {number} */ (round6(interval[0])), /** @type {number} */ (round6(interval[1]))]
    : null;
}

/**
 * Score one entry against a suite.
 *
 * @param {SuiteManifest} suite
 * @param {Trajectory[]} trajectories The entry's recorded episodes.
 * @param {Game<*>[] | Map<string, Game<*>> | Record<string, Game<*>>} games
 *   Implementations for every suite game — needed to verify trajectories and
 *   to read `spec.benchmark`.
 * @param {ScoreOptions} [options]
 * @returns {Promise<EntryScore>}
 */
export async function score(suite, trajectories, games, options = {}) {
  if (!suite || suite.format !== SUITE_FORMAT) {
    refuse('suite-format', `expected a ${SUITE_FORMAT} manifest, got ${JSON.stringify(suite && /** @type {*} */ (suite).format)}`);
  }
  if (!Array.isArray(trajectories)) {
    refuse('trajectories', 'trajectories must be an array');
  }
  const gameMap = toGameMap(games, suite);

  const agent = options.agent ?? trajectories[0]?.agent ?? null;
  if (!agent || typeof agent.id !== 'string' || agent.id.length === 0) {
    refuse('agent-identity', 'no agent given and no trajectory to derive one from');
  }

  /** @type {Map<string, SuiteGame>} */
  const suiteGames = new Map(suite.games.map((g) => [g.id, g]));

  //
  // Refusal checks. Order: membership, identity, uniformity, duplicates,
  // verification.
  //

  /** @type {Map<string, Trajectory>} */
  const byKey = new Map();
  for (const trajectory of trajectories) {
    const key = `${trajectory.game.id}/${trajectory.tier}/${trajectory.seed}`;
    const suiteGame = suiteGames.get(trajectory.game.id);
    if (!suiteGame) {
      refuse(
        'suite-membership',
        `trajectory for game "${trajectory.game.id}" (${key}) is not in the suite`
      );
    }
    const suiteTier = suiteGame.tiers.find((t) => t.id === trajectory.tier);
    if (!suiteTier) {
      refuse(
        'suite-membership',
        `trajectory for tier "${trajectory.tier}" (${key}) is not in the suite; game "${suiteGame.id}" has tiers ${suiteGame.tiers.map((t) => t.id).join(', ')}`
      );
    }
    if (!suiteTier.seeds.includes(trajectory.seed)) {
      refuse(
        'suite-membership',
        `trajectory seed "${trajectory.seed}" is not in the suite's seed list for ${suiteGame.id}/${suiteTier.id}; the manifest defines which episodes count`
      );
    }
    if (trajectory.game.version !== suiteGame.version) {
      refuse(
        'game-version-uniformity',
        `trajectory ${key} records game version ${trajectory.game.version} but the suite pins ${suiteGame.version}; mixed game versions within one entry cannot be scored`
      );
    }
    if (trajectory.agent.id !== agent.id) {
      refuse(
        'agent-identity',
        `trajectory ${key} is by agent "${trajectory.agent.id}" but the entry is "${agent.id}"`
      );
    }
    if (trajectory.agent.track !== agent.track) {
      refuse(
        'agent-identity',
        `trajectory ${key} has track "${trajectory.agent.track}" but the entry agent is track "${agent.track}"`
      );
    }
    if (trajectory.split !== suite.split) {
      refuse(
        'split-uniformity',
        `trajectory ${key} is from the "${trajectory.split}" split but the suite scores the "${suite.split}" split; mixed splits within one entry cannot be scored`
      );
    }
    if (options.saltCommitment !== undefined && options.saltCommitment !== suite.saltCommitment) {
      refuse(
        'salt-commitment',
        `entry claims salt commitment ${JSON.stringify(options.saltCommitment)} but the suite's is ${JSON.stringify(suite.saltCommitment)}; mixed salt commitments within one entry cannot be scored`
      );
    }
    if (byKey.has(key)) {
      refuse('duplicate-episodes', `entry has two trajectories for ${key}`);
    }
    byKey.set(key, trajectory);
  }

  for (const [key, trajectory] of byKey) {
    const game = /** @type {Game<*>} */ (gameMap.get(trajectory.game.id));
    const verdict = await verifyTrajectory(game, trajectory);
    if (!verdict.ok) {
      refuse(
        'trajectory-verification',
        `trajectory ${key} fails verifyTrajectory (step ${verdict.step}): ${verdict.reason}`
      );
    }
  }

  //
  // Episode scores and per-entry stats.
  //

  /** @type {Map<string, { e: number[], solved: boolean[] }>} */
  const tierData = new Map();
  let totalCost = 0;
  let costKnown = true;
  let agentSteps = 0;
  let invalidAgentSteps = 0;
  let sumAgentActions = 0;

  for (const [key, trajectory] of byKey) {
    const suiteGame = /** @type {SuiteGame} */ (suiteGames.get(trajectory.game.id));
    const suiteTier = /** @type {SuiteTier} */ (suiteGame.tiers.find((t) => t.id === trajectory.tier));
    const { e, solved } = episodeScore(suiteTier, trajectory);
    const dataKey = `${suiteGame.id}|${suiteTier.id}`;
    let data = tierData.get(dataKey);
    if (!data) {
      data = { e: [], solved: [] };
      tierData.set(dataKey, data);
    }
    data.e.push(e);
    data.solved.push(solved);

    const cost = trajectoryCost(trajectory);
    if (cost === null) {
      costKnown = false;
    } else {
      totalCost += cost;
    }
    for (const step of trajectory.steps) {
      if (step.by !== 'agent') continue;
      agentSteps++;
      if (step.invalid) invalidAgentSteps++;
    }
    sumAgentActions += trajectory.end.agentActions;
  }

  //
  // Point estimates: tier means (with the solvedFraction cap), game
  // rank-weighted means, benchmark unweighted mean.
  //

  /** @type {Map<string, number | null>} */
  const tierPoint = new Map();
  /** @type {Map<string, number | null>} */
  const tierSolvedFraction = new Map();
  for (const sg of suite.games) {
    for (const st of sg.tiers) {
      const data = tierData.get(`${sg.id}|${st.id}`);
      if (!data || data.e.length === 0) {
        tierPoint.set(`${sg.id}|${st.id}`, null);
        tierSolvedFraction.set(`${sg.id}|${st.id}`, null);
        continue;
      }
      const n = data.e.length;
      const mean = data.e.reduce((a, b) => a + b, 0) / n;
      if (st.scoring === 'efficiency') {
        const solvedFraction = data.solved.filter(Boolean).length / n;
        tierPoint.set(`${sg.id}|${st.id}`, Math.min(solvedFraction, mean));
        tierSolvedFraction.set(`${sg.id}|${st.id}`, solvedFraction);
      } else {
        tierPoint.set(`${sg.id}|${st.id}`, mean);
        tierSolvedFraction.set(`${sg.id}|${st.id}`, null);
      }
    }
  }

  /** @type {Map<string, number | null>} */
  const gamePoint = new Map();
  for (const sg of suite.games) {
    let sumRankT = 0;
    let sumRank = 0;
    let ok = true;
    for (const st of sg.tiers) {
      const t = tierPoint.get(`${sg.id}|${st.id}`);
      if (t === null || t === undefined) {
        ok = false;
        continue;
      }
      sumRankT += st.rank * t;
      sumRank += st.rank;
    }
    gamePoint.set(sg.id, ok && sumRank > 0 ? sumRankT / sumRank : null);
  }

  const benchmarkIds = suite.games.filter((sg) => {
    const game = /** @type {Game<*>} */ (gameMap.get(sg.id));
    return game.spec.benchmark === true;
  }).map((sg) => sg.id);
  if (benchmarkIds.length === 0) {
    refuse('benchmark-games', 'the suite has no games with spec.benchmark true; a benchmark score would be undefined');
  }
  const benchmarkParts = benchmarkIds.map((id) => gamePoint.get(id));
  const benchmarkPoint =
    benchmarkParts.every((v) => typeof v === 'number')
      ? benchmarkParts.reduce((a, b) => /** @type {number} */ (a) + /** @type {number} */ (b), 0) /
        benchmarkParts.length
      : null;

  //
  // Bootstrap: one joint resample per draw. Within each tier, resample its
  // covered episodes with replacement; recompute T, then G, then B from the
  // same draw. Seeded from the core RNG per entry, so identical inputs give
  // identical intervals.
  //

  /** @type {Array<{ gameId: string, tierId: string, tier: SuiteTier, data: { e: number[], solved: boolean[] } | undefined }>} */
  const flatTiers = [];
  for (const sg of suite.games) {
    for (const st of sg.tiers) {
      flatTiers.push({
        gameId: sg.id,
        tierId: st.id,
        tier: st,
        data: tierData.get(`${sg.id}|${st.id}`),
      });
    }
  }
  // Indices into `gameDraws` (one slot per suite game) of the benchmark
  // games — not tier indices; the B aggregation reads game draws.
  const benchmarkIndices = suite.games
    .map((sg, i) => ({ sg, i }))
    .filter(({ sg }) => {
      const game = /** @type {Game<*>} */ (gameMap.get(sg.id));
      return game.spec.benchmark === true;
    })
    .map(({ i }) => i);
  const gameIndex = new Map(suite.games.map((sg, i) => [sg.id, i]));
  const tierIndex = new Map(flatTiers.map((ft, i) => [`${ft.gameId}|${ft.tierId}`, i]));

  const tierDraws = flatTiers.map(() => new Float64Array(BOOTSTRAP_DRAWS).fill(NaN));
  const gameDraws = suite.games.map(() => new Float64Array(BOOTSTRAP_DRAWS).fill(NaN));
  const benchmarkDraws = new Float64Array(BOOTSTRAP_DRAWS).fill(NaN);

  const rng = streamFromSeed(`bootstrap/${suite.id}/${agent.id}/${suite.split}`);
  for (let b = 0; b < BOOTSTRAP_DRAWS; b++) {
    for (let ti = 0; ti < flatTiers.length; ti++) {
      const { gameId, tier, data } = flatTiers[ti];
      if (!data || data.e.length === 0) continue;
      const n = data.e.length;
      let sum = 0;
      let solvedCount = 0;
      for (let i = 0; i < n; i++) {
        const idx = Math.min(n - 1, Math.floor(rng.nextFloat() * n));
        sum += data.e[idx];
        if (data.solved[idx]) solvedCount++;
      }
      const mean = sum / n;
      const t = tier.scoring === 'efficiency' ? Math.min(solvedCount / n, mean) : mean;
      tierDraws[ti][b] = t;
    }
    for (let gi = 0; gi < suite.games.length; gi++) {
      const sg = suite.games[gi];
      let sumRankT = 0;
      let sumRank = 0;
      let ok = true;
      for (const st of sg.tiers) {
        const ti = /** @type {number} */ (tierIndex.get(`${sg.id}|${st.id}`));
        const draw = tierDraws[ti][b];
        if (!Number.isFinite(draw)) {
          ok = false;
          continue;
        }
        sumRankT += st.rank * draw;
        sumRank += st.rank;
      }
      if (ok && sumRank > 0) gameDraws[gi][b] = sumRankT / sumRank;
    }
    let bSum = 0;
    let bOk = true;
    for (const gi of benchmarkIndices) {
      const draw = gameDraws[gi][b];
      if (!Number.isFinite(draw)) {
        bOk = false;
        break;
      }
      bSum += draw;
    }
    if (bOk && benchmarkIndices.length > 0) benchmarkDraws[b] = bSum / benchmarkIndices.length;
  }

  //
  // Coverage and ranking.
  //

  /** @type {string[]} */
  const missing = [];
  for (const sg of suite.games) {
    for (const st of sg.tiers) {
      for (const seed of st.seeds) {
        if (!byKey.has(`${sg.id}/${st.id}/${seed}`)) missing.push(`${sg.id}/${st.id}/${seed}`);
      }
    }
  }
  /** @type {string[]} */
  const dryRunKeys = [];
  for (const [key, trajectory] of byKey) {
    if (trajectory.agent.dryRun === true) dryRunKeys.push(key);
  }

  const ranked = missing.length === 0 && dryRunKeys.length === 0;
  /**
   * @param {string[]} list
   * @returns {string}
   */
  const describe = (list) =>
    list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} (+${list.length - 3} more)`;
  /** @type {string | null} */
  let unrankedReason = null;
  if (dryRunKeys.length > 0) {
    unrankedReason = `dry-run trajectory: ${describe(dryRunKeys)}`;
  } else if (missing.length > 0) {
    unrankedReason = `missing episodes: ${describe(missing)}`;
  }

  //
  // Output assembly.
  //

  /** @type {Record<string, GameScore>} */
  const gamesOut = {};
  for (const sg of suite.games) {
    /** @type {Record<string, TierScore>} */
    const tiersOut = {};
    for (const st of sg.tiers) {
      const data = tierData.get(`${sg.id}|${st.id}`);
      const ti = /** @type {number} */ (tierIndex.get(`${sg.id}|${st.id}`));
      tiersOut[st.id] = {
        score: withCI(round6(tierPoint.get(`${sg.id}|${st.id}`) ?? null), roundCI(ci95([...tierDraws[ti]]))),
        episodes: data ? data.e.length : 0,
        solvedFraction: round6(/** @type {number | null} */ (tierSolvedFraction.get(`${sg.id}|${st.id}`))),
      };
    }
    const gi = /** @type {number} */ (gameIndex.get(sg.id));
    gamesOut[sg.id] = {
      score: withCI(round6(gamePoint.get(sg.id) ?? null), roundCI(ci95([...gameDraws[gi]]))),
      tiers: tiersOut,
    };
  }

  const episodes = byKey.size;
  /** @type {EntryScore} */
  const result = {
    agent: {
      id: agent.id,
      track: agent.track,
    },
    ranked,
    unrankedReason,
    benchmarkScore: benchmarkPoint === null ? null : withCI(round6(benchmarkPoint), roundCI(ci95([...benchmarkDraws]))),
    costUsd: costKnown ? /** @type {number} */ (round6(totalCost)) : 'unknown',
    costPerEpisodeUsd:
      costKnown && episodes > 0 ? /** @type {number} */ (round6(totalCost / episodes)) : 'unknown',
    episodes,
    invalidActionRate:
      agentSteps === 0 ? 0 : /** @type {number} */ (round6(invalidAgentSteps / agentSteps)),
    meanAgentActions: episodes === 0 ? 0 : /** @type {number} */ (round6(sumAgentActions / episodes)),
    games: gamesOut,
  };
  if (agent.model !== undefined) result.agent.model = agent.model;
  if (agent.provider !== undefined) result.agent.provider = agent.provider;
  return result;
}
