/**
 * Cost estimation for a suite run, produced before any model call is made.
 *
 * The numbers are estimates, never measurements, and are labeled as such in
 * every output. Per job:
 *
 * - **low** calls: the game's engine or greedy baseline plays two of the
 *   tier's seeds and the estimate averages its agent-action counts; where no
 *   baseline exists, the episode's `par` is used instead.
 * - **high** calls: the tier's `maxActions` (every episode runs out of
 *   budget).
 * - **tokens per call**: the official system prompt plus the real per-turn
 *   user message, rendered with `harness/official.js` along the baseline
 *   episode, at 4 characters per token (input); the baseline's reply text
 *   stands in for the output.
 *
 * With a prices file (`harness/model-agent.js` PriceFile shape, keyed
 * `"<provider>/<model>"`), the estimate prices low and high per game and in
 * total, as JSON and Markdown.
 *
 * Baseline resolution order: an optional `game.baselineAgent(tier, seed)`
 * hook; else the bundled engine every two-seat game must provide
 * (`game.opponent` seated at the agent's seat); else `par` from
 * `tier.params.par` or the game's reset state (`state.par`, the convention
 * the fixture and efficiency games use). A probe failure degrades to the par
 * fallback, and no par means the low estimate is reported as unknown rather
 * than guessed.
 *
 * @module
 */

import { OFFICIAL_SYSTEM_PROMPT, buildOfficialTurnMessage } from '../harness/official.js';
import { runEpisode } from '../core/runner.js';
import { findSuiteTier, SUITE_FORMAT } from '../scoring/suite.js';

import { manifestSha256, normalizeGames, planJobs } from './plan.js';
import { atomicWriteFile } from './fsutil.js';

/** @import { Agent, Game, TierSpec } from '../core/types.js' */
/** @import { SuiteManifest } from '../scoring/suite.js' */
/** @import { Job } from './plan.js' */

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
 * @typedef {object} TokenStats
 * @property {{ mean: number, max: number }} input Tokens per call, input side.
 * @property {{ mean: number, max: number }} output Tokens per call, output side.
 */

/**
 * @typedef {object} TierProbe
 * @property {'engine-probe' | 'par' | 'none'} basis How the low estimate is
 *   derived.
 * @property {number | null} callsPerEpisode Low-call figure per episode
 *   (engine-probe mean); null for the par basis (par is per seed) and the
 *   none basis.
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
 * @typedef {object} EstimateOptions
 * @property {SuiteManifest} suite
 * @property {Game<*>[] | Map<string, Game<*>> | Record<string, Game<*>>} games
 * @property {Record<string, *>} [prices] Price file keyed `"<provider>/<model>"`.
 * @property {string} [pricingKey] Which entry to price with, e.g.
 *   `"anthropic/claude-sonnet-4-5"`. Required for any USD figure.
 * @property {() => number} [now]
 */

/**
 * @typedef {object} EstimateJob
 * @property {string} key
 * @property {string} gameId
 * @property {string} tierId
 * @property {string} seed
 * @property {'engine-probe' | 'par' | 'none'} basis
 * @property {number | null} callsLow
 * @property {number} callsHigh
 * @property {number | null} usdLow
 * @property {number | null} usdHigh
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
 * @property {string} generatedAt
 * @property {EstimateGame[]} games
 * @property {EstimateJob[]} jobs
 * @property {{ jobs: number, callsLow: number | null, callsHigh: number, usdLow: number | null, usdHigh: number | null }} totals
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
 * Estimate a whole suite. Probes each tier once (two baseline episodes where
 * a baseline exists), then derives per-job figures.
 *
 * @param {EstimateOptions} options
 * @returns {Promise<Estimate>}
 */
export async function estimateSuite({ suite, games, prices, pricingKey, now = Date.now }) {
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
      const suiteTier = findSuiteTier(suite, job.gameId, job.tierId);
      if (!suiteTier) {
        refuse('suite-tier', `planJobs derived a job for ${job.gameId}/${job.tierId} but the suite has no such tier`);
      }
      const game = /** @type {Game<*>} */ (gameMap.get(job.gameId));
      const tier = /** @type {TierSpec} */ (
        game.spec.tiers.find((t) => t.id === job.tierId)
      );
      probe = await probeTier(game, tier, suiteTier.seeds, suite.split);
      tierProbes.set(probeKey, probe);
    }

    /** @type {number | null} */
    let callsLow = null;
    /** @type {string | null} */
    let note = probe.note;
    if (probe.basis === 'engine-probe') {
      callsLow = probe.callsPerEpisode;
    } else if (probe.basis === 'par') {
      const game = /** @type {Game<*>} */ (gameMap.get(job.gameId));
      const tier = /** @type {TierSpec} */ (game.spec.tiers.find((t) => t.id === job.tierId));
      const resolved = resolveBaseline(game, tier, job.seed);
      if (resolved.kind === 'par') {
        callsLow = resolved.par;
      } else if (resolved.kind === 'agent') {
        // The tier-level probe said par, but this seed resolves to an agent
        // (seed-dependent hooks); measure it directly rather than guess.
        try {
          const p = await probeEpisode(game, tier, job.seed, suite.split, resolved.agent);
          callsLow = p.agentActions;
        } catch (err) {
          note = `per-seed probe failed: ${err instanceof Error ? err.message : String(err)}`;
        }
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
      'Estimates, not measurements. Low calls: the game engine/greedy baseline\'s mean agent actions on two ' +
      "seeds of the tier, or the episode par where no baseline exists. High calls: the tier's maxActions. " +
      `Tokens per call: the official system prompt plus the per-turn official user message (harness/official.js) ` +
      `rendered along the baseline episode at ${CHARS_PER_TOKEN} characters per token. Real runs may cost more.`,
    suite: { id: suite.id, split: suite.split, manifestSha256: manifestSha256(suite) },
    pricing: { key: priced ? /** @type {string} */ (pricingKey) : null, priced },
    generatedAt: new Date(now()).toISOString(),
    games: gameEstimates,
    jobs: jobEstimates,
    totals: {
      jobs: jobEstimates.length,
      callsLow: sumNullable(gameEstimates, (g) => g.callsLow),
      callsHigh: gameEstimates.reduce((a, g) => a + g.callsHigh, 0),
      usdLow: sumNullable(gameEstimates, (g) => g.usdLow),
      usdHigh: sumNullable(gameEstimates, (g) => g.usdHigh),
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
  const notes = estimate.jobs.filter((j) => j.note);
  if (notes.length > 0) {
    lines.push('');
    for (const n of notes) {
      lines.push(`- \`${n.key}\`: ${n.note}`);
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

// Re-exported for callers that want to plan without importing plan.js too.
export { planJobs, manifestSha256 };
