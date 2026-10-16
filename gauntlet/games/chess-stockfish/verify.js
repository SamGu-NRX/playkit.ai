#!/usr/bin/env node
/**
 * Deep verification for the chess-stockfish game. Slower than the test
 * suite; run it when a Stockfish binary is available:
 *
 *   node games/chess-stockfish/verify.js
 *
 * It checks, and prints a summary of:
 *  1. Conformance on two public seeds per tier (all four tiers, so the
 *     1M-node tier plays real episodes).
 *  2. Same-seed full-episode determinism at the two heaviest tiers
 *     (sf-100k and sf-1m): the same seed twice must replay identically.
 *  3. Strength: the sf-10k Stockfish opponent versus the built-in chess
 *     ladder's granite tier (the "ladder-4" rung), played by the granite
 *     engine baseline as the probe agent, over the five public seeds with
 *     alternating colours. Acceptance: Stockfish takes at least 3 of 5
 *     points (win = 1, draw = 0.5).
 *
 * Exit code 0 iff every check passes.
 *
 * Lifecycle: every Stockfish engine this script touches is an episode
 * opponent built inside runEpisode, whose finally disposes it before the
 * episode resolves — so engines are released between episodes here too, and
 * no explicit teardown is needed at this level.
 */

import { chessStockfish } from './index.js';
import { chess } from '../chess/index.js';
import { createEngineBaselineAgent } from '../chess/baselines.js';
import { runEpisode } from '../../core/runner.js';
import { runConformance } from '../../core/conformance.js';
import { canonicalJson } from '../../core/canonical.js';
import { nextInt, rngFromSeed } from '../../core/rng.js';
import { findEngineBinary } from '../../engines/uci/client.js';

/** @import { Agent, TierSpec, TurnContext } from '../../core/types.js' */

const REAL_BINARY = findEngineBinary();
if (!REAL_BINARY) {
  console.error(
    'no engine binary found: install stockfish or set GAUNTLET_STOCKFISH'
  );
  process.exit(2);
}

/**
 * A seeded random legal-move agent.
 *
 * @param {string} label
 * @returns {Agent}
 */
function randomAgent(label) {
  let ply = 0;
  return {
    id: `random-${label}`,
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {TurnContext} */ ctx) {
      const legal = ctx.legalActions ?? [];
      if (legal.length === 0) return { text: '' };
      const pick = nextInt(rngFromSeed(`${label}/${ply}`), 0, legal.length - 1).value;
      ply++;
      return { text: legal[pick] };
    },
  };
}

/**
 * Wall-clock fields stripped, for same-seed trajectory comparison.
 *
 * @param {*} trajectory
 */
function comparable(trajectory) {
  return {
    game: trajectory.game,
    tier: trajectory.tier,
    seed: trajectory.seed,
    agent: trajectory.agent,
    opponents: trajectory.opponents,
    steps: trajectory.steps.map((/** @type {any} */ step) => ({
      seat: step.seat,
      by: step.by,
      observationHash: step.observationHash,
      reply: deterministicReply(step.reply),
      action: step.action,
      invalid: step.invalid,
    })),
    end: trajectory.end,
  };
}

/**
 * A copy of a reply with wall-clock meta removed: the search itself is a
 * deterministic function of (binary, position, options, budget), but its
 * speed — nps — is not, so it never belongs in a same-seed comparison.
 *
 * @param {*} reply
 */
function deterministicReply(reply) {
  if (!reply || typeof reply !== 'object' || !reply.meta) return reply;
  const meta = { ...reply.meta };
  delete meta.nps;
  return { ...reply, meta };
}

/** @type {boolean[]} */
const results = [];

async function main() {
  console.log(`engine: ${REAL_BINARY}`);

  // 1. Conformance, two public seeds per tier (8 episodes).
  const report = await runConformance(chessStockfish, { seedsPerTier: 2 });
  console.log(
    `conformance (seedsPerTier=2, all four tiers): ok=${report.ok} checks=${report.checks}`
  );
  results.push(report.ok);

  // 2. Same-seed determinism at sf-100k and sf-1m.
  for (const tier of /** @type {TierSpec[]} */ (chessStockfish.spec.tiers.slice(2))) {
    const seed = `chess-stockfish/${tier.id}/public/0`;
    const first = await runEpisode({
      game: chessStockfish,
      tierId: tier.id,
      seed,
      agent: randomAgent(`determinism-${tier.id}`),
      maxConsecutiveInvalid: 2,
    });
    const second = await runEpisode({
      game: chessStockfish,
      tierId: tier.id,
      seed,
      agent: randomAgent(`determinism-${tier.id}`),
      maxConsecutiveInvalid: 2,
    });
    const identical =
      canonicalJson(comparable(first)) === canonicalJson(comparable(second));
    console.log(
      `determinism ${tier.id}: identical=${identical} (end reason ${first.end.reason}, ${first.steps.length} recorded plies)`
    );
    results.push(identical);
  }

  // 3. sf-10k opponent vs the built-in ladder's granite tier, five public
  // seeds, colours alternating with the seed via agentSeat.
  const tier = /** @type {TierSpec} */ (
    chessStockfish.spec.tiers.find((t) => t.id === 'sf-10k')
  );
  const granite = /** @type {TierSpec} */ (
    chess.spec.tiers.find((t) => t.id === 'granite')
  );
  /** @type {number} */
  let stockfishScore = 0;
  console.log('strength: granite engine baseline (agent seat) vs sf-10k Stockfish (opponent)');
  for (let index = 0; index < tier.publicSeeds; index++) {
    const seed = `chess-stockfish/${tier.id}/public/${index}`;
    const seat = /** @type {number} */ (/** @type {any} */ (chessStockfish).agentSeat(tier, seed));
    const trajectory = await runEpisode({
      game: chessStockfish,
      tierId: tier.id,
      seed,
      agent: createEngineBaselineAgent({
        tier: granite,
        seed,
        seat,
        id: 'chess-granite-probe',
      }),
      maxConsecutiveInvalid: 2,
    });
    const outcome = /** @type {import('../../core/types.js').Outcome} */ (trajectory.end.outcome);
    const score = outcome.normalized[seat === 0 ? 1 : 0] ?? 0;
    stockfishScore += score;
    console.log(
      `  seed ${index}: agent seat ${seat}, ${trajectory.end.reason} after ${trajectory.steps.length} plies, stockfish score ${score} (raw ${JSON.stringify(outcome.raw)})`
    );
  }
  const ladderWin = stockfishScore >= 3;
  console.log(
    `strength: stockfish ${stockfishScore}/5 points vs granite (acceptance >= 3) -> ${ladderWin ? 'PASS' : 'FAIL'}`
  );
  results.push(ladderWin);

  const ok = results.every(Boolean);
  console.log(ok ? 'VERIFY PASS' : 'VERIFY FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
