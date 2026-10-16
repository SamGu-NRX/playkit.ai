/**
 * Cost estimation for a suite run, produced before any model call is made.
 *
 * The numbers are estimates, never measurements, and are labeled as such in
 * every output. Where the game/tier has fitted parameters
 * (`runs/estimate-fit/params.js`, fitted to committed real-model runs — see
 * `runs/estimate-fit/fit-report.md` for the hold-out error tables), the
 * **model-fit** basis is used:
 *
 * - **low (expected) calls**: the fitted mean agent actions per episode of
 *   the committed runs for that game and tier.
 * - **high (worst-case) calls**: the tier's `maxActions` (every episode runs
 *   out of budget) — the number a dollar cap should be set from, because a
 *   model that flails pins the episode to the budget no matter what the fit
 *   saw.
 * - **tokens per call**: the fitted mean (expected) and observed maximum
 *   (worst) of the runs' recorded provider usage for that tier.
 *
 * Without fitted parameters the old bases apply, unchanged:
 *
 * - **low** calls: the game's engine or greedy baseline plays two of the
 *   tier's seeds and the estimate averages its agent-action counts; where no
 *   baseline exists, the episode's `par` is used instead.
 * - **high** calls: the tier's `maxActions`.
 * - **tokens per call**: the official system prompt plus the real per-turn
 *   user message, rendered with `harness/official.js` along the baseline
 *   episode, at 4 characters per token (input); the baseline's reply text
 *   stands in for the output.
 *
 * With a prices file (`harness/model-agent.js` PriceFile shape, keyed
 * `"<provider>/<model>"`), the estimate prices low and high per game and in
 * total, as JSON and Markdown.
 *
 * With `noProbes`, no baseline episode is played at all: the low side comes
 * from the fitted parameters where a game/tier has them, else the tier's par;
 * a tier with neither is reported as unestimated rather than probed. Totals
 * sum every game that has a basis and name the games without one, so the
 * totals row never nulls out because a single game lacks a basis. After a
 * run, `compareRunAgainstEstimate` reads a run bundle and reports, per game
 * and in total, how the actual calls, tokens and dollars landed against the
 * estimate's low and high figures.
 *
 * Baseline resolution order (unfitted tiers only): an optional
 * `game.baselineAgent(tier, seed)` hook; else the bundled engine every
 * two-seat game must provide (`game.opponent` seated at the agent's seat);
 * else `par` from `tier.params.par` or the game's reset state (`state.par`,
 * the convention the fixture and efficiency games use). A probe failure
 * degrades to the par fallback, and no par means the low estimate is reported
 * as unknown rather than guessed.
 *
 * @module
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { OFFICIAL_SYSTEM_PROMPT, buildOfficialTurnMessage } from '../harness/official.js';
import { runEpisode } from '../core/runner.js';
import { TRAJECTORY_FORMAT } from '../core/trajectory.js';
import { findSuiteTier, SUITE_FORMAT } from '../scoring/suite.js';

import { ESTIMATE_FIT } from './estimate-fit/params.js';
import { manifestSha256, normalizeGames, planJobs } from './plan.js';
import { atomicWriteFile, readJsonFile } from './fsutil.js';

/** @import { Agent, Game, TierSpec } from '../core/types.js' */
/** @import { SuiteManifest } from '../scoring/suite.js' */
/** @import { Job } from './plan.js' */

/**
 * Fitted per-(game, tier) parameters, produced by `runs/estimate-fit/fit.mjs`
 * from committed real-model run data.
 *
 * @typedef {object} EstimateFitTier
 * @property {number} callsExpected Mean agent actions per episode across the
 *   fitted runs.
 * @property {number | null} inExpected Mean recorded input tokens per call.
 * @property {number | null} inWorst Maximum recorded input tokens per call.
 * @property {number | null} outExpected Mean recorded output tokens per call.
 * @property {number | null} outWorst Maximum recorded output tokens per call.
 * @property {number} invalidRate Share of fitted calls that were invalid.
 * @property {boolean} budgetBound True when every fitted episode exhausted
 *   the tier budget (the fitted mean IS the cap).
 * @property {number} episodes Fitted episode count.
 * @property {string[]} models Models the fit saw for this tier.
 * @property {string[]} sources Committed run bundles the fit used.
 * @property {Record<string, number>} endReasons Episode counts by end reason.
 * @property {number | null} [callsCap] The tier's current maxActions (report
 *   only).
 */

/**
 * @typedef {object} EstimateFit
 * @property {string} format
 * @property {string} note
 * @property {Record<string, EstimateFitTier>} tiers Keyed `"<gameId>/<tierId>"`.
 * @property {string[]} sources Committed run bundles the fit was made from.
 */

/** Estimates are labeled with this format so no reader mistakes them for data. */
export const ESTIMATE_FORMAT = 'playkit-gauntlet-estimate/1';

/** Characters per token used for every token figure. */
export const CHARS_PER_TOKEN = 4;

/** Public seeds the baseline probe plays per tier. */
export const PROBE_SEEDS = 2;

/**
 * @param {string} step
 * @param {string} message
 * @returns {never}
 */
function refuse(step, message) {
  throw new Error(`[gauntlet/runs/estimate.js] ${step}: ${message}`);
}

/**
 * Display label for one job. A job key is `<game>/<tier>/<seed>` and the
 * seed itself is `<game>/<tier>/<split>/<i>`, so the raw key repeats the
 * game and tier prefix (`chess/wood/chess/wood/public/0`); wherever a job is
 * shown to a person, show the seed alone. Machine-read fields (`jobs[].key`,
 * run.json's key lists) keep the full stable key.
 *
 * @param {{ key: string, gameId: string, tierId: string, seed: string }} job
 * @returns {string}
 */
function jobDisplayLabel(job) {
  return job.seed.startsWith(`${job.gameId}/${job.tierId}/`) ? job.seed : job.key;
}

/**
 * @typedef {object} TokenStats
 * @property {{ mean: number, max: number }} input Tokens per call, input side.
 * @property {{ mean: number, max: number }} output Tokens per call, output side.
 */

/**
 * @typedef {object} TierProbe
 * @property {'engine-probe' | 'par' | 'none' | 'model-fit'} basis How the low
 *   estimate is derived.
 * @property {number | null} callsPerEpisode Low-call figure per episode
 *   (engine-probe mean or fitted mean); null for the par basis (par is per
 *   seed) and the none basis.
 * @property {TokenStats | null} tokens Tokens per call from the probe.
 * @property {string | null} note Human-readable caveat.
 */

/**
 * @param {number} chars
 * @returns {number}
 */
function toTokens(chars) {
  return chars / CHARS_PER_TOKEN;
}

/**
 * Resolve the stand-in baseline for one episode, in the documented order.
 *
 * @param {Game<*>} game
 * @param {TierSpec} tier
 * @param {string} seed
 * @returns {{ kind: 'agent', agent: Agent } | { kind: 'par', par: number } | { kind: 'none' }}
 */
export function resolveBaseline(game, tier, seed) {
  const hook = /** @type {any} */ (game).baselineAgent;
  if (typeof hook === 'function') {
    const agent = hook(tier, seed);
    if (agent && typeof agent.act === 'function') return { kind: 'agent', agent };
  }
  const seats = game.spec.seats;
  const agentSeat =
    typeof game.agentSeat === 'function' ? game.agentSeat(tier, seed) : 0;
  if (seats > 1 && typeof game.opponent === 'function') {
    const agent = game.opponent(tier, seed, agentSeat);
    if (agent && typeof agent.act === 'function') return { kind: 'agent', agent };
  }
  const paramsPar = /** @type {any} */ (tier.params)?.par;
  if (typeof paramsPar === 'number' && Number.isFinite(paramsPar) && paramsPar > 0) {
    return { kind: 'par', par: paramsPar };
  }
  try {
    const state = /** @type {any} */ (game.reset(tier, seed));
    if (state && typeof state.par === 'number' && Number.isFinite(state.par) && state.par > 0) {
      return { kind: 'par', par: state.par };
    }
  } catch {
    // reset failure falls through to "none"; the estimate reports it
  }
  return { kind: 'none' };
}

/**
 * Render the official message pair for one turn and accumulate characters.
 *
 * @param {import('../core/types.js').TurnContext} ctx
 * @param {string | null} previousReply
 * @returns {{ inputChars: number }}
 */
function officialMessageChars(ctx, previousReply) {
  const message = buildOfficialTurnMessage(ctx, previousReply);
  return { inputChars: OFFICIAL_SYSTEM_PROMPT.length + message.length };
}

/**
 * Play one probe episode with the baseline and measure it.
 *
 * @param {Game<*>} game
 * @param {TierSpec} tier
 * @param {string} seed
 * @param {'public' | 'eval'} split
 * @param {Agent} baseline
 * @returns {Promise<{ agentActions: number, calls: number, inChars: number, outChars: number, maxInChars: number, maxOutChars: number }>}
 */
async function probeEpisode(game, tier, seed, split, baseline) {
  let inChars = 0;
  let outChars = 0;
  let calls = 0;
  let maxInChars = 0;
  let maxOutChars = 0;
  /** @type {string | null} */
  let previousReply = null;
  const probeAgent = /** @type {Agent} */ ({
    id: baseline.id,
    track: baseline.track,
    async act(ctx) {
      const { inputChars } = officialMessageChars(ctx, previousReply);
      inChars += inputChars;
      maxInChars = Math.max(maxInChars, inputChars);
      const reply = await baseline.act(ctx);
      const text = typeof reply?.text === 'string' ? reply.text : '';
      outChars += text.length;
      maxOutChars = Math.max(maxOutChars, text.length);
      previousReply = text.length > 0 ? text : null;
      calls += 1;
      return reply;
    },
  });
  const trajectory = await runEpisode({ game, tierId: tier.id, seed, split, agent: probeAgent });
  return {
    agentActions: trajectory.end.agentActions,
    calls,
    inChars,
    outChars,
    maxInChars,
    maxOutChars,
  };
}

/**
 * Token stats from the initial official turn only — the par basis has no
 * baseline episode to render along.
 *
 * @param {Game<*>} game
 * @param {TierSpec} tier
 * @param {string} seed
 * @param {number} agentSeat
 * @returns {TokenStats}
 */
function initialTurnTokens(game, tier, seed, agentSeat) {
  const state = game.reset(tier, seed);
  const observation = game.observe(state, agentSeat);
  const { inputChars } = officialMessageChars(
    {
      spec: game.spec,
      tier,
      seat: agentSeat,
      turn: 0,
      observation,
      legalActions: null,
      feedback: null,
    },
    null
  );
  const legal = game.legalActions(state, agentSeat);
  const outputChars = legal.length > 0 ? legal[0].length : 0;
  const input = toTokens(inputChars);
  const output = toTokens(outputChars);
  return { input: { mean: input, max: input }, output: { mean: output, max: output } };
}

/**
 * Probe one tier: two baseline episodes where a baseline exists, the par
 * fallback where it does not.
 *
 * @param {Game<*>} game
 * @param {TierSpec} tier
 * @param {string[]} seeds The tier's suite seeds in index order.
 * @param {'public' | 'eval'} split
 * @returns {Promise<TierProbe>}
 */
export async function probeTier(game, tier, seeds, split) {
  const probeSeeds = seeds.slice(0, PROBE_SEEDS);
  /** @type {TierProbe} */
  let fallback = { basis: 'none', callsPerEpisode: null, tokens: null, note: null };
  try {
    const first = resolveBaseline(game, tier, probeSeeds[0] ?? seeds[0]);
    if (first.kind === 'par') {
      const agentSeat =
        typeof game.agentSeat === 'function' ? game.agentSeat(tier, probeSeeds[0] ?? seeds[0]) : 0;
      return {
        basis: 'par',
        callsPerEpisode: null,
        tokens: initialTurnTokens(game, tier, probeSeeds[0] ?? seeds[0], agentSeat),
        note: `low = the episode par (${first.par} on the first probed seed); no baseline agent exists for this game`,
      };
    }
    if (first.kind === 'none') return fallback;
    const probes = [];
    for (const seed of probeSeeds) {
      const resolved = resolveBaseline(game, tier, seed);
      // A seed-dependent hook may refuse a baseline on a particular seed;
      // skip that seed rather than guess at its cost.
      if (resolved.kind !== 'agent') continue;
      probes.push(await probeEpisode(game, tier, seed, split, resolved.agent));
    }
    if (probes.length === 0) {
      return {
        basis: 'none',
        callsPerEpisode: null,
        tokens: null,
        note: 'baseline probe produced no agent calls',
      };
    }
    const totalCalls = probes.reduce((a, p) => a + p.calls, 0);
    if (totalCalls === 0) {
      fallback = {
        basis: 'none',
        callsPerEpisode: null,
        tokens: null,
        note: 'baseline probe produced no agent calls',
      };
      return fallback;
    }
    const agentActions = probes.reduce((a, p) => a + p.agentActions, 0);
    return {
      basis: 'engine-probe',
      callsPerEpisode: agentActions / probes.length,
      tokens: {
        input: {
          mean: toTokens(probes.reduce((a, p) => a + p.inChars, 0)) / totalCalls,
          max: toTokens(Math.max(...probes.map((p) => p.maxInChars))),
        },
        output: {
          mean: toTokens(probes.reduce((a, p) => a + p.outChars, 0)) / totalCalls,
          max: toTokens(Math.max(...probes.map((p) => p.maxOutChars))),
        },
      },
      note: `low = the ${game.spec.id} engine baseline's mean agent actions over ${probes.length} seed(s) of this tier`,
    };
  } catch (err) {
    return {
      basis: 'none',
      callsPerEpisode: null,
      tokens: null,
      note: `baseline probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * A TierProbe for the no-probes estimate: no episode is played. The fit was
 * already checked first, so this resolves the tier's par (tier params, or
 * the reset state's `par`) where one exists and reports the tier as
 * unestimated where it does not — an engine-probe basis needs baseline
 * episodes, which is exactly what a no-probes estimate skips.
 *
 * @param {Game<*>} game
 * @param {TierSpec} tier
 * @param {string} seed The tier's first suite seed, for the token render.
 * @returns {TierProbe}
 */
function parOnlyProbe(game, tier, seed) {
  /** @param {number} par @returns {TierProbe} */
  const parProbe = (par) => ({
    basis: 'par',
    callsPerEpisode: null,
    tokens: initialTurnTokens(
      game,
      tier,
      seed,
      typeof game.agentSeat === 'function' ? game.agentSeat(tier, seed) : 0
    ),
    note: `low = the episode par (${par}); probe episodes skipped (--no-probes)`,
  });
  const paramsPar = /** @type {any} */ (tier.params)?.par;
  if (typeof paramsPar === 'number' && Number.isFinite(paramsPar) && paramsPar > 0) {
    return parProbe(paramsPar);
  }
  try {
    const state = /** @type {any} */ (game.reset(tier, seed));
    if (state && typeof state.par === 'number' && Number.isFinite(state.par) && state.par > 0) {
      return parProbe(state.par);
    }
  } catch {
    // reset failure: the tier stays unestimated
  }
  return {
    basis: 'none',
    callsPerEpisode: null,
    tokens: null,
    note: 'unestimated: no fitted parameters and no par, and probe episodes are skipped (--no-probes)',
  };
}

/**
 * @typedef {object} EstimateOptions
 * @property {SuiteManifest} suite
 * @property {Game<*>[] | Map<string, Game<*>> | Record<string, Game<*>>} games
 * @property {Record<string, *>} [prices] Price file keyed `"<provider>/<model>"`.
 * @property {string} [pricingKey] Which entry to price with, e.g.
 *   `"anthropic/claude-sonnet-4-5"`. Required for any USD figure.
 * @property {boolean} [fit] Use the fitted parameters from committed
 *   real-model runs where a game/tier has them (default true; the
 *   engine-probe/par bases apply where it does not, and `false` disables the
 *   fit entirely).
 * @property {boolean} [noProbes] Skip the baseline probe episodes entirely:
 *   the low side comes from the fit where a game/tier has fitted parameters,
 *   else the tier's par; a tier with neither is unestimated (basis `none`)
 *   rather than probed. Default false. Makes a pre-run estimate practical
 *   where probe episodes would dominate the wall clock.
 * @property {() => number} [now]
 */

/**
 * @typedef {object} EstimateJob
 * @property {string} key
 * @property {string} gameId
 * @property {string} tierId
 * @property {string} seed
 * @property {'engine-probe' | 'par' | 'none' | 'model-fit'} basis
 * @property {number | null} callsLow
 * @property {number} callsHigh
 * @property {number | null} usdLow
 * @property {number | null} usdHigh
 * @property {TokenStats | null} tokens Per-call token figures behind the USD
 *   figures, from the job's basis (fit, probe, or initial-turn render); null
 *   when the tier has no token basis.
 * @property {string | null} note
 */

/**
 * @typedef {object} EstimateGame
 * @property {string} gameId
 * @property {number} jobs
 * @property {number | null} callsLow
 * @property {number} callsHigh
 * @property {number | null} usdLow
 * @property {number | null} usdHigh
 */

/**
 * @typedef {object} Estimate
 * @property {'playkit-gauntlet-estimate/1'} format
 * @property {'estimate'} kind
 * @property {string} note
 * @property {{ id: string, split: string, manifestSha256: string }} suite
 * @property {{ key: string | null, priced: boolean }} pricing
 * @property {{ format: string, tiers: number, sources: string[] } | null} fit
 *   Provenance of the fitted parameters behind any `model-fit` basis jobs;
 *   null when the fit was disabled or covers no job in the suite.
 * @property {string} generatedAt
 * @property {EstimateGame[]} games
 * @property {EstimateJob[]} jobs
 * @property {{ gameId: string, tierId: string, basis: EstimateJob['basis'] }[]} tiers
 *   One entry per game/tier the suite plans, with the basis its jobs used —
 *   the at-a-glance answer to what each tier's low side is made of.
 * @property {{ jobs: number, callsLow: number, callsHigh: number, usdLow: number | null, usdHigh: number | null, noLowBasis: string[], noTokenBasis: string[] }} totals
 *   Totals sum every game that has a basis and never null out because one
 *   game lacks one: callsLow sums the games with a low basis (the games
 *   without one are named in noLowBasis), and the USD figures sum the priced
 *   games with a basis (games without a token basis are named in
 *   noTokenBasis). The USD totals are null only when no prices were given at
 *   all.
 */

/**
 * Sum a nullable field across rows: null when any row is null, so totals
 * never understate an unknown.
 *
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => number | null} get
 * @returns {number | null}
 */
function sumNullable(rows, get) {
  let total = 0;
  for (const row of rows) {
    const v = get(row);
    if (v === null || v === undefined) return null;
    total += v;
  }
  return total;
}

/**
 * A TierProbe built from the fitted parameters for one tier (no local probe
 * episode is played: the fit already carries the runs' measured calls and
 * provider-recorded usage).
 *
 * @param {EstimateFitTier} fitTier
 * @returns {TierProbe}
 */
function fittedProbe(fitTier) {
  const note =
    `expected = the fitted mean agent actions over ${fitTier.episodes} committed real-model ` +
    `episode(s) (models: ${fitTier.models.join(', ')}); worst = the tier's maxActions budget` +
    (fitTier.budgetBound ? ' (every fitted episode exhausted the budget)' : '') +
    '; tokens = fitted means/maxima of the runs\' recorded provider usage';
  return {
    basis: 'model-fit',
    callsPerEpisode: fitTier.callsExpected,
    tokens:
      fitTier.inExpected === null || fitTier.outExpected === null
        ? null
        : {
            input: { mean: fitTier.inExpected, max: fitTier.inWorst ?? fitTier.inExpected },
            output: { mean: fitTier.outExpected, max: fitTier.outWorst ?? fitTier.outExpected },
          },
    note,
  };
}

/**
 * Estimate a whole suite. Tiers with fitted parameters use the fit; the rest
 * are probed (two baseline episodes where a baseline exists, par where not).
 *
 * @param {EstimateOptions} options
 * @returns {Promise<Estimate>}
 */
export async function estimateSuite({
  suite,
  games,
  prices,
  pricingKey,
  fit = true,
  noProbes = false,
  now = Date.now,
}) {
  if (!suite || suite.format !== SUITE_FORMAT) {
    refuse(
      'suite-format',
      `expected a ${SUITE_FORMAT} manifest, got ${JSON.stringify(suite && /** @type {*} */ (suite).format)}`
    );
  }
  const gameMap = normalizeGames(games, suite);
  const jobs = planJobs(suite);

  let priced = false;
  let pIn = Number.NaN;
  let pOut = Number.NaN;
  if (prices && pricingKey) {
    const entry = /** @type {any} */ (prices)[pricingKey];
    if (entry) {
      pIn = Number(entry.inputPerMTok);
      pOut = Number(entry.outputPerMTok);
      if (Number.isFinite(pIn) && Number.isFinite(pOut)) {
        priced = true;
      }
    }
  }

  /** @type {Map<string, TierProbe>} */
  const tierProbes = new Map();
  /** @type {EstimateJob[]} */
  const jobEstimates = [];
  for (const job of jobs) {
    const probeKey = `${job.gameId}|${job.tierId}`;
    let probe = tierProbes.get(probeKey);
    if (!probe) {
      const fitTier = fit ? ESTIMATE_FIT.tiers[`${job.gameId}/${job.tierId}`] : undefined;
      if (fitTier) {
        probe = fittedProbe(fitTier);
      } else {
        const suiteTier = findSuiteTier(suite, job.gameId, job.tierId);
        if (!suiteTier) {
          refuse('suite-tier', `planJobs derived a job for ${job.gameId}/${job.tierId} but the suite has no such tier`);
        }
        const game = /** @type {Game<*>} */ (gameMap.get(job.gameId));
        const tier = /** @type {TierSpec} */ (
          game.spec.tiers.find((t) => t.id === job.tierId)
        );
        probe = noProbes
          ? parOnlyProbe(game, tier, suiteTier.seeds[0])
          : await probeTier(game, tier, suiteTier.seeds, suite.split);
      }
      tierProbes.set(probeKey, probe);
    }

    /** @type {number | null} */
    let callsLow = null;
    /** @type {string | null} */
    let note = probe.note;
    if (probe.basis === 'engine-probe' || probe.basis === 'model-fit') {
      callsLow = probe.callsPerEpisode;
    } else if (probe.basis === 'par') {
      const game = /** @type {Game<*>} */ (gameMap.get(job.gameId));
      const tier = /** @type {TierSpec} */ (game.spec.tiers.find((t) => t.id === job.tierId));
      const resolved = resolveBaseline(game, tier, job.seed);
      if (resolved.kind === 'par') {
        callsLow = resolved.par;
      } else if (resolved.kind === 'agent' && !noProbes) {
        // The tier-level probe said par, but this seed resolves to an agent
        // (seed-dependent hooks); measure it directly rather than guess.
        try {
          const p = await probeEpisode(game, tier, job.seed, suite.split, resolved.agent);
          callsLow = p.agentActions;
        } catch (err) {
          note = `per-seed probe failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else if (resolved.kind === 'agent') {
        // A no-probes estimate cannot measure a seed-dependent baseline
        // agent, so this seed's low side stays unknown rather than guessed.
        note = 'this seed resolves to a baseline agent; probe episodes are skipped (--no-probes), so its low basis is unknown';
      }
    }

    const callsHigh = gameMap.get(job.gameId)?.spec.tiers.find((t) => t.id === job.tierId)?.maxActions ?? 0;

    /** @type {number | null} */
    let usdLow = null;
    /** @type {number | null} */
    let usdHigh = null;
    if (priced && probe.tokens) {
      const perCallLow =
        (probe.tokens.input.mean / 1_000_000) * pIn + (probe.tokens.output.mean / 1_000_000) * pOut;
      const perCallHigh =
        (probe.tokens.input.max / 1_000_000) * pIn + (probe.tokens.output.max / 1_000_000) * pOut;
      if (callsLow !== null) usdLow = callsLow * perCallLow;
      usdHigh = callsHigh * perCallHigh;
    }

    jobEstimates.push({
      key: job.key,
      gameId: job.gameId,
      tierId: job.tierId,
      seed: job.seed,
      basis: probe.basis,
      callsLow,
      callsHigh,
      usdLow,
      usdHigh,
      tokens: probe.tokens,
      note,
    });
  }

  /** @type {EstimateGame[]} */
  const gameEstimates = [];
  for (const gameId of suite.games.map((g) => g.id)) {
    const rows = jobEstimates.filter((j) => j.gameId === gameId);
    gameEstimates.push({
      gameId,
      jobs: rows.length,
      callsLow: sumNullable(rows, (r) => r.callsLow),
      callsHigh: rows.reduce((a, r) => a + r.callsHigh, 0),
      usdLow: sumNullable(rows, (r) => r.usdLow),
      usdHigh: sumNullable(rows, (r) => r.usdHigh),
    });
  }

  return {
    format: ESTIMATE_FORMAT,
    kind: 'estimate',
    note:
      'Estimates, not measurements. Where runs/estimate-fit/params.js has fitted parameters for the ' +
      'game/tier (fitted to committed real-model runs; hold-out error tables in ' +
      'runs/estimate-fit/fit-report.md): low calls = the fitted mean agent actions per episode, high ' +
      "calls = the tier's maxActions budget, tokens per call = the fitted means/maxima of the runs' " +
      'recorded provider usage. Unfitted tiers: low calls = the game engine/greedy baseline\'s mean ' +
      'agent actions on two seeds of the tier, or the episode par where no baseline exists; tokens per ' +
      `call = the official system prompt plus the per-turn official user message (harness/official.js) ` +
      `rendered along the baseline episode at ${CHARS_PER_TOKEN} characters per token. Real runs may cost more.` +
      (noProbes
        ? ' Probe episodes were skipped (--no-probes): the low side comes from the fit where fitted, ' +
          "else the tier's par; tiers with neither are unestimated."
        : ''),
    suite: { id: suite.id, split: suite.split, manifestSha256: manifestSha256(suite) },
    pricing: { key: priced ? /** @type {string} */ (pricingKey) : null, priced },
    fit: jobEstimates.some((j) => j.basis === 'model-fit')
      ? { format: ESTIMATE_FIT.format, tiers: Object.keys(ESTIMATE_FIT.tiers).length, sources: ESTIMATE_FIT.sources }
      : null,
    generatedAt: new Date(now()).toISOString(),
    games: gameEstimates,
    jobs: jobEstimates,
    tiers: [...tierProbes.entries()].map(([key, probe]) => {
      const at = key.indexOf('|');
      return { gameId: key.slice(0, at), tierId: key.slice(at + 1), basis: probe.basis };
    }),
    totals: {
      jobs: jobEstimates.length,
      // Sum every game that has a basis; the games without one are named in
      // noLowBasis/noTokenBasis, so the totals never null out because a
      // single game lacks a basis.
      callsLow: gameEstimates.reduce((a, g) => a + (g.callsLow ?? 0), 0),
      callsHigh: gameEstimates.reduce((a, g) => a + g.callsHigh, 0),
      usdLow: priced ? gameEstimates.reduce((a, g) => a + (g.usdLow ?? 0), 0) : null,
      usdHigh: priced ? gameEstimates.reduce((a, g) => a + (g.usdHigh ?? 0), 0) : null,
      noLowBasis: gameEstimates.filter((g) => g.callsLow === null).map((g) => g.gameId),
      noTokenBasis: priced
        ? gameEstimates.filter((g) => g.usdHigh === null).map((g) => g.gameId)
        : [],
    },
  };
}

/**
 * Render the estimate as a Markdown table.
 *
 * @param {Estimate} estimate
 * @returns {string}
 */
export function estimateToMarkdown(estimate) {
  /** @param {number | null | undefined} v */
  const usd = (v) =>
    v === null || v === undefined ? '—' : `${(Math.round(v * 100) / 100).toFixed(2)}`;
  /** @param {number | null | undefined} v */
  const calls = (v) => (v === null || v === undefined ? '—' : String(Math.ceil(v)));
  /** @type {string[]} */
  const lines = [];
  lines.push(`# Gauntlet run estimate — ${estimate.suite.id} (${estimate.suite.split} split)`);
  lines.push('');
  lines.push(
    `**Estimate, not a measurement.** Manifest sha256 \`${estimate.suite.manifestSha256}\`. ` +
      (estimate.pricing.priced
        ? `Priced with \`${estimate.pricing.key}\` from the provided prices file.`
        : 'No usable prices entry was given, so no USD figures are available.')
  );
  lines.push('');
  lines.push(estimate.note);
  lines.push('');
  lines.push('| Game | Episodes | Calls low | Calls high | USD low | USD high |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const g of estimate.games) {
    lines.push(
      `| ${g.gameId} | ${g.jobs} | ${calls(g.callsLow)} | ${calls(g.callsHigh)} | ${usd(g.usdLow)} | ${usd(g.usdHigh)} |`
    );
  }
  lines.push(
    `| **Total** | **${estimate.totals.jobs}** | **${calls(estimate.totals.callsLow)}** | **${calls(estimate.totals.callsHigh)}** | **${usd(estimate.totals.usdLow)}** | **${usd(estimate.totals.usdHigh)}** |`
  );
  // Totals never null out because one game lacks a basis — they sum every
  // game that has one and name the games that do not.
  const exclusions = [];
  if (estimate.totals.noLowBasis.length > 0) {
    exclusions.push(`no low basis: ${estimate.totals.noLowBasis.join(', ')}`);
  }
  if (estimate.totals.noTokenBasis.length > 0) {
    exclusions.push(`no token basis (USD unknown): ${estimate.totals.noTokenBasis.join(', ')}`);
  }
  if (exclusions.length > 0) {
    lines.push('');
    lines.push(`Totals sum every game that has a basis — ${exclusions.join('; ')}.`);
  }
  if (estimate.tiers.length > 0) {
    lines.push('');
    lines.push('| Tier | Basis |');
    lines.push('|---|---|');
    for (const t of estimate.tiers) {
      lines.push(`| ${t.gameId}/${t.tierId} | ${t.basis} |`);
    }
    const unestimated = estimate.tiers.filter((t) => t.basis === 'none');
    if (unestimated.length > 0) {
      lines.push('');
      lines.push(
        `Unestimated tiers (no fitted or par basis): ${unestimated.map((t) => `${t.gameId}/${t.tierId}`).join(', ')}.`
      );
    }
  }
  const notes = estimate.jobs.filter((j) => j.note);
  if (notes.length > 0) {
    lines.push('');
    for (const n of notes) {
      // The seed already begins `<game>/<tier>/`, so the footnote shows the
      // seed alone instead of repeating the game and tier prefix.
      lines.push(`- \`${jobDisplayLabel(n)}\`: ${n.note}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Write `estimate.json` and `estimate.md` into a directory (atomically).
 *
 * @param {string} outDir
 * @param {Estimate} estimate
 * @returns {Promise<{ jsonPath: string, mdPath: string }>}
 */
export async function writeEstimate(outDir, estimate) {
  const jsonPath = `${outDir.replace(/\/+$/, '')}/estimate.json`;
  const mdPath = `${outDir.replace(/\/+$/, '')}/estimate.md`;
  await atomicWriteFile(jsonPath, JSON.stringify(estimate, null, 2) + '\n');
  await atomicWriteFile(mdPath, estimateToMarkdown(estimate));
  return { jsonPath, mdPath };
}

/**
 * The comparison record format printed by the CLI's `--against <dir>` mode.
 */
export const COMPARE_FORMAT = 'playkit-gauntlet-estimate-compare/1';

/**
 * Whether an actual/expected calls ratio lands within 2x — the acceptance
 * question the packet asks of every game. Null where there is no expected
 * figure (a missing basis is neither a hit nor a miss).
 *
 * @param {number | null} callsLowRatio actual ÷ expected-calls, or null
 * @returns {'within-2x' | 'over-2x' | 'under-2x' | null}
 */
function callsVerdict(callsLowRatio) {
  if (callsLowRatio === null) return null;
  if (callsLowRatio > 2) return 'over-2x';
  if (callsLowRatio < 0.5) return 'under-2x';
  return 'within-2x';
}

/**
 * @typedef {object} ComparisonFigures
 * @property {{ calls: number, tokensIn: number, tokensOut: number, spendUsd: number }} actual
 *   Summed from the run bundle's trajectories (the whole bundle, so a
 *   `--resume` does not hide earlier invocations' episodes).
 * @property {{ callsLow: number | null, callsHigh: number, tokensInLow: number | null, tokensOutLow: number | null, tokensInHigh: number | null, tokensOutHigh: number | null, usdLow: number | null, usdHigh: number | null }} estimated
 *   From the estimate: low = expected (Σ callsLow × mean tokens per call),
 *   high = worst case (Σ callsHigh × max tokens per call). Per game, a tier
 *   without a basis nulls its low-side figure; in total, the games with a
 *   basis are summed and the games without one simply do not contribute.
 * @property {{ callsLow: number | null, callsHigh: number | null, tokensInLow: number | null, tokensOutLow: number | null, tokensInHigh: number | null, tokensOutHigh: number | null, usdLow: number | null, usdHigh: number | null }} ratio
 *   actual ÷ estimated; null where the estimate has no basis (or is 0), so a
 *   missing basis never masquerades as a 0% error.
 */

/**
 * @typedef {object} ComparisonRow
 * @property {string} gameId
 * @property {number} episodes Trajectories summed for this game.
 * @property {number} unknownCostSteps Steps with usage but no finite cost —
 *   the actual spend is understated by them.
 * @property {ComparisonFigures} figures
 * @property {'within-2x' | 'over-2x' | 'under-2x' | null} callsVerdict
 *   Whether the actual calls landed within 2x of the expected (low) figure:
 *   the acceptance question a bare ratio does not answer. Null where the game
 *   has no low basis — a missing basis is neither a hit nor a miss.
 */

/**
 * @typedef {object} EstimateComparison
 * @property {'playkit-gauntlet-estimate-compare/1'} format
 * @property {'estimate-vs-actual'} kind
 * @property {string} runDir
 * @property {number} episodes
 * @property {number} unplayedEpisodes Episodes still unplayed in the bundle:
 *   the actuals are partial-run figures.
 * @property {ComparisonRow[]} games
 * @property {{ episodes: number, unknownCostSteps: number, unplayedEpisodes: number, figures: ComparisonFigures, callsVerdict: 'within-2x' | 'over-2x' | 'under-2x' | null }} totals
 */

/**
 * Compare a built estimate with a finished run bundle: per game and in
 * total, how the run's actual calls, tokens and dollars landed against the
 * estimate's low (expected) and high (worst-case) figures, as ratios of
 * actual to estimated. Actuals are summed from every trajectory in the run
 * directory — the same whole-bundle basis as run.json's `total` block — and
 * the comparison refuses a bundle whose suite manifest hash differs from the
 * estimate's, because comparing costs across different suites would be
 * meaningless.
 *
 * Ported from the #69 journey's `journeys/model/estimate-check.mjs`; this is
 * the library shape the CLI's `--against <dir>` mode calls directly.
 *
 * @param {Estimate} estimate
 * @param {string} runDir
 * @returns {Promise<EstimateComparison>}
 */
export async function compareRunAgainstEstimate(estimate, runDir) {
  const runParsed = await readJsonFile(path.join(runDir, 'run.json'));
  if (!runParsed.ok) {
    refuse('run-dir', `no run.json under ${runDir} (was the run started?)`);
  }
  const run = /** @type {any} */ (runParsed.value);
  const runManifest = run?.suite?.manifestSha256;
  if (runManifest !== estimate.suite.manifestSha256) {
    refuse(
      'manifest',
      `the run bundle's suite manifest does not match the estimate's ` +
        `(run ${runManifest ?? 'unknown'}, estimate ${estimate.suite.manifestSha256})`
    );
  }

  /** @type {Map<string, { episodes: number, calls: number, tokensIn: number, tokensOut: number, spendUsd: number, unknownCostSteps: number }>} */
  const actual = new Map();
  let episodes = 0;
  const unplayedEpisodes = Number(run?.counts?.unplayed ?? 0);
  const stack = [runDir];
  for (;;) {
    const dir = stack.pop();
    if (!dir) break;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      // Top-level records (suite.json, run.json, prices.json) do not parse
      // as trajectories, so the format check below skips them.
      const parsed = await readJsonFile(filePath);
      const t = /** @type {any} */ (parsed.ok ? parsed.value : null);
      if (!t || t.format !== TRAJECTORY_FORMAT || !Array.isArray(t.steps)) continue;
      episodes += 1;
      const gameId = typeof t.game?.id === 'string' ? t.game.id : 'unknown';
      const bucket =
        actual.get(gameId) ??
        { episodes: 0, calls: 0, tokensIn: 0, tokensOut: 0, spendUsd: 0, unknownCostSteps: 0 };
      bucket.episodes += 1;
      for (const step of t.steps) {
        const usage = step?.usage;
        if (!usage) continue;
        bucket.calls += 1;
        if (typeof usage.inputTokens === 'number' && Number.isFinite(usage.inputTokens)) {
          bucket.tokensIn += usage.inputTokens;
        }
        if (typeof usage.outputTokens === 'number' && Number.isFinite(usage.outputTokens)) {
          bucket.tokensOut += usage.outputTokens;
        }
        if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)) {
          bucket.spendUsd += usage.costUsd;
        } else {
          bucket.unknownCostSteps += 1;
        }
      }
      actual.set(gameId, bucket);
    }
  }

  /** @type {Map<string, EstimateJob[]>} */
  const jobsByGame = new Map();
  for (const job of estimate.jobs) {
    const rows = jobsByGame.get(job.gameId) ?? [];
    rows.push(job);
    jobsByGame.set(job.gameId, rows);
  }

  /**
   * @param {{ calls: number, tokensIn: number, tokensOut: number, spendUsd: number }} act
   * @param {{ callsLow: number | null, callsHigh: number, tokensInLow: number | null, tokensOutLow: number | null, tokensInHigh: number | null, tokensOutHigh: number | null, usdLow: number | null, usdHigh: number | null }} estimated
   * @returns {ComparisonFigures}
   */
  function withRatios(act, estimated) {
    /** @param {number} a @param {number | null} e @returns {number | null} */
    const ratio = (a, e) => (e === null || e === 0 ? null : a / e);
    return {
      actual: act,
      estimated,
      ratio: {
        callsLow: ratio(act.calls, estimated.callsLow),
        callsHigh: ratio(act.calls, estimated.callsHigh),
        tokensInLow: ratio(act.tokensIn, estimated.tokensInLow),
        tokensOutLow: ratio(act.tokensOut, estimated.tokensOutLow),
        tokensInHigh: ratio(act.tokensIn, estimated.tokensInHigh),
        tokensOutHigh: ratio(act.tokensOut, estimated.tokensOutHigh),
        usdLow: ratio(act.spendUsd, estimated.usdLow),
        usdHigh: ratio(act.spendUsd, estimated.usdHigh),
      },
    };
  }

  /**
   * Estimated figures for one game's jobs: a tier without a basis nulls the
   * game's low-side figure rather than hiding inside a sum.
   *
   * @param {EstimateJob[]} rows
   */
  const estimateRows = (rows) => ({
    callsLow: sumNullable(rows, (r) => r.callsLow),
    callsHigh: rows.reduce((a, r) => a + r.callsHigh, 0),
    tokensInLow: sumNullable(rows, (r) =>
      r.callsLow !== null && r.tokens ? r.callsLow * r.tokens.input.mean : null
    ),
    tokensOutLow: sumNullable(rows, (r) =>
      r.callsLow !== null && r.tokens ? r.callsLow * r.tokens.output.mean : null
    ),
    tokensInHigh: sumNullable(rows, (r) => (r.tokens ? r.callsHigh * r.tokens.input.max : null)),
    tokensOutHigh: sumNullable(rows, (r) => (r.tokens ? r.callsHigh * r.tokens.output.max : null)),
    usdLow: sumNullable(rows, (r) => r.usdLow),
    usdHigh: sumNullable(rows, (r) => r.usdHigh),
  });

  const rows = estimate.games.map((game) => {
    const act =
      actual.get(game.gameId) ??
      { episodes: 0, calls: 0, tokensIn: 0, tokensOut: 0, spendUsd: 0, unknownCostSteps: 0 };
    const figures = withRatios(act, estimateRows(jobsByGame.get(game.gameId) ?? []));
    return {
      gameId: game.gameId,
      episodes: act.episodes,
      unknownCostSteps: act.unknownCostSteps,
      figures,
      callsVerdict: callsVerdict(figures.ratio.callsLow),
    };
  });

  const totalAct = rows.reduce(
    (a, r) => ({
      calls: a.calls + r.figures.actual.calls,
      tokensIn: a.tokensIn + r.figures.actual.tokensIn,
      tokensOut: a.tokensOut + r.figures.actual.tokensOut,
      spendUsd: a.spendUsd + r.figures.actual.spendUsd,
    }),
    { calls: 0, tokensIn: 0, tokensOut: 0, spendUsd: 0 }
  );
  const totalEstimated = {
    callsLow: rows.reduce((a, r) => a + (r.figures.estimated.callsLow ?? 0), 0),
    callsHigh: rows.reduce((a, r) => a + r.figures.estimated.callsHigh, 0),
    tokensInLow: rows.reduce((a, r) => a + (r.figures.estimated.tokensInLow ?? 0), 0),
    tokensOutLow: rows.reduce((a, r) => a + (r.figures.estimated.tokensOutLow ?? 0), 0),
    tokensInHigh: rows.reduce((a, r) => a + (r.figures.estimated.tokensInHigh ?? 0), 0),
    tokensOutHigh: rows.reduce((a, r) => a + (r.figures.estimated.tokensOutHigh ?? 0), 0),
    usdLow: rows.reduce((a, r) => a + (r.figures.estimated.usdLow ?? 0), 0),
    usdHigh: rows.reduce((a, r) => a + (r.figures.estimated.usdHigh ?? 0), 0),
  };

  const totalFigures = withRatios(totalAct, totalEstimated);

  return {
    format: COMPARE_FORMAT,
    kind: 'estimate-vs-actual',
    runDir,
    episodes,
    unplayedEpisodes,
    games: rows,
    totals: {
      episodes,
      unknownCostSteps: rows.reduce((a, r) => a + r.unknownCostSteps, 0),
      unplayedEpisodes,
      figures: totalFigures,
      callsVerdict: callsVerdict(totalFigures.ratio.callsLow),
    },
  };
}

/**
 * Render the comparison as a Markdown table for the CLI.
 *
 * @param {EstimateComparison} comparison
 * @returns {string}
 */
export function comparisonToMarkdown(comparison) {
  /** @param {number | null | undefined} v */
  const ratio = (v) =>
    v === null || v === undefined ? '—' : `${(Math.round(v * 100) / 100).toFixed(2)}×`;
  /** @param {'within-2x' | 'over-2x' | 'under-2x' | null | undefined} v */
  const verdict = (v) => (v === null || v === undefined ? '—' : v.replace('-2x', ' 2×'));
  /** @param {number | null | undefined} v */
  const calls = (v) => (v === null || v === undefined ? '—' : String(Math.ceil(v)));
  /** @param {number} a @param {number | null} low @param {number | null} high */
  const cell = (a, low, high) => `${calls(a)} (${ratio(low)} low, ${ratio(high)} high)`;
  /** @type {string[]} */
  const lines = [];
  lines.push(`# Estimate vs actual — ${comparison.runDir}`);
  lines.push('');
  lines.push(
    '**Actual, not an estimate.** ' +
      `${comparison.episodes} trajectory/ies summed per step from the run bundle (the whole bundle, so a ` +
      'resumed run compares against its full actuals). Ratio = actual ÷ estimated; low = expected, ' +
      'high = worst case. Calls vs expected answers the packet acceptance question: did the actual ' +
      'call count land within 2x of the expected figure?'
  );
  if (comparison.totals.unknownCostSteps > 0) {
    lines.push(
      `${comparison.totals.unknownCostSteps} step(s) reported usage without a priced cost — actual spend is understated by them.`
    );
  }
  if (comparison.unplayedEpisodes > 0) {
    lines.push(
      `${comparison.unplayedEpisodes} episode(s) are still unplayed in this bundle — the actuals are partial-run figures.`
    );
  }
  lines.push('');
  lines.push('| Game | Calls | Calls vs expected | Tokens in | Tokens out | USD |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of comparison.games) {
    const f = row.figures;
    lines.push(
      `| ${row.gameId} | ${cell(f.actual.calls, f.ratio.callsLow, f.ratio.callsHigh)} | ${verdict(
        row.callsVerdict
      )} | ${cell(f.actual.tokensIn, f.ratio.tokensInLow, f.ratio.tokensInHigh)} | ${cell(
        f.actual.tokensOut,
        f.ratio.tokensOutLow,
        f.ratio.tokensOutHigh
      )} | ${f.actual.spendUsd.toFixed(4)} (${ratio(f.ratio.usdLow)} low, ${ratio(f.ratio.usdHigh)} high) |`
    );
  }
  const t = comparison.totals.figures;
  lines.push(
    `| **Total** | ${cell(t.actual.calls, t.ratio.callsLow, t.ratio.callsHigh)} | ${verdict(
      comparison.totals.callsVerdict
    )} | ${cell(t.actual.tokensIn, t.ratio.tokensInLow, t.ratio.tokensInHigh)} | ${cell(
      t.actual.tokensOut,
      t.ratio.tokensOutLow,
      t.ratio.tokensOutHigh
    )} | ${t.actual.spendUsd.toFixed(4)} (${ratio(t.ratio.usdLow)} low, ${ratio(t.ratio.usdHigh)} high) |`
  );
  const off = comparison.games.filter(
    (r) => r.callsVerdict === 'over-2x' || r.callsVerdict === 'under-2x'
  );
  if (off.length > 0) {
    lines.push('');
    lines.push(
      `Calls beyond 2× of expected: ${off
        .map((r) => `${r.gameId} (${r.callsVerdict === 'over-2x' ? 'over' : 'under'})`)
        .join(', ')}. Where a model's play bifurcates between forfeiting early and running out ` +
        'the budget, no scalar fitted from other models\' runs lands within 2× of both — see ' +
        'runs/estimate-fit/fit-report.md ("Within-2x verdict", "What the fit cannot do").'
    );
  }
  lines.push('');
  return lines.join('\n');
}

// Re-exported for callers that want to plan without importing plan.js too.
export { planJobs, manifestSha256 };
