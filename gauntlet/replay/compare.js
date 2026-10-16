/**
 * Compare two recorded Gauntlet episodes of the same (game, version, tier,
 * seed): per-agent attempt/invalid/observation/action statistics, tokens,
 * latency, cost, end reason and outcome, and the first turn where the two
 * diverge — both observations included. Also the bundle pairing that compares
 * two run directories episode by episode.
 *
 * Built on `frames.js`: both trajectories are replay-verified before anything
 * is reported, so a tampered or stale trajectory is refused at the failing
 * step (`ReplayRefusedError`, from frames.js) and the identity check refuses
 * a game/version/tier/seed mismatch by name (`CompareRefusedError`).
 *
 * Episode scores replicate `scoring/score.js`'s `episodeScore` exactly
 * (outcome tiers take `normalized[seat]`; efficiency tiers take the
 * par-ratio rule with the same caps) so this module and the leaderboard
 * cannot drift — the caps are imported from there.
 *
 * This module must not import `node:*` — it loads in the browser too, and
 * the CLI's bundle mode feeds directories into it as entry maps.
 *
 * @module
 */

import { buildFrames, ReplayRefusedError } from './frames.js';
import { EFFICIENCY_CAP_OPTIMAL, EFFICIENCY_CAP_REFERENCE } from '../scoring/score.js';

/** @import { Game, TierSpec, Trajectory, Usage } from '../core/types.js' */
/** @import { ReplayFrame } from './frames.js' */

export { ReplayRefusedError };

/**
 * Thrown when the two trajectories are not the same episode. `field` names
 * the mismatch ("game", "version", "tier", "seed").
 */
export class CompareRefusedError extends Error {
  /**
   * @param {string} field
   * @param {string} message
   */
  constructor(field, message) {
    super(message);
    this.name = 'CompareRefusedError';
    /** @type {string} */
    this.field = field;
  }
}

/**
 * @typedef {object} ActionCount
 * @property {string} action
 * @property {number} count
 * @property {number} share Of this agent's valid actions.
 */

/**
 * @typedef {object} AgentTokens
 * @property {number | null} inputTokens Sum over agent steps that reported a
 *   count; null when no step reported one.
 * @property {number | null} outputTokens
 * @property {number | null} totalTokens
 * @property {number} unknownSteps Agent steps with no usage record at all.
 */

/**
 * @typedef {object} AgentLatency
 * @property {number} totalMs
 * @property {number | null} meanMs
 * @property {number | null} maxMs
 */

/**
 * @typedef {object} EndSummary
 * @property {string} reason
 * @property {number} agentActions
 * @property {number} invalidActions
 * @property {number | null} outcomeScore `outcome.normalized[agentSeat]`.
 * @property {boolean | null} solved
 * @property {number | null} par
 * @property {number | null} episodeScore Same rule as `scoring/score.js`.
 */

/**
 * Per-agent comparison stats, over this agent's own steps only.
 *
 * @typedef {object} AgentCompare
 * @property {string} id
 * @property {string | undefined} model
 * @property {string | undefined} track
 * @property {number} seat
 * @property {number} attempts Agent steps recorded (valid and invalid).
 * @property {number} validActions
 * @property {number} invalidActions
 * @property {{ reason: string, count: number }[]} invalidByReason Descending by count.
 * @property {number} distinctObservations Distinct observation hashes this agent saw.
 * @property {number} revisitedStates Attempts landing on an already-seen observation.
 * @property {ActionCount[]} topActions Ten most frequent valid actions, descending.
 * @property {number | null} undoStyleActions Count of this agent's valid
 *   undo-style actions (canonical action matching /undo/i); null when neither
 *   agent ever played one, so the episode itself shows no undo-style action
 *   in either grammar use.
 * @property {AgentTokens} tokens
 * @property {AgentLatency} latency
 * @property {number | null} costUsd Sum of agent-step costs; null when any
 *   agent step's cost is unknown (same rule as score.js's trajectoryCost).
 * @property {number | null} wallMs Episode wall time from the recorded timestamps.
 * @property {EndSummary} end
 */

/**
 * The first turn where the two episodes diverge.
 *
 * @typedef {object} Divergence
 * @property {number} index 0-based step index.
 * @property {'actions-differ' | 'observation-differs' | 'a-ended' | 'b-ended'} reason
 * @property {boolean} observationMatch True when both agents saw the same
 *   observation hash at this step.
 * @property {DivergenceSide | null} a Null for 'b-ended' (A has no step here).
 * @property {DivergenceSide | null} b
 */

/**
 * @typedef {object} DivergenceSide
 * @property {{ text: string, hash: string }} observation
 * @property {string} replyText
 * @property {string | null} attempted
 * @property {string | null} canonical
 * @property {boolean} invalid
 * @property {string} action The recorded action.
 */

/**
 * The episode-mode payload, format `playkit-gauntlet-replay-compare/1`.
 *
 * @typedef {object} EpisodeCompare
 * @property {'playkit-gauntlet-replay-compare/1'} format
 * @property {'episode'} mode
 * @property {{ id: string, version: string }} game
 * @property {string} tier
 * @property {string} seed
 * @property {{ a: string, b: string }} splits
 * @property {{ a: AgentId, b: AgentId }} agents
 * @property {AgentCompare} a
 * @property {AgentCompare} b
 * @property {Divergence | null} divergence Null when the replays are identical.
 * @property {boolean} identical
 */

/**
 * @typedef {object} AgentId
 * @property {string} id
 * @property {string | undefined} model
 * @property {string | undefined} track
 */

/**
 * @typedef {object} TrajectoryEntry
 * @property {Trajectory} trajectory
 * @property {string} path
 */

/**
 * @typedef {object} BundlePair
 * @property {string} key `<game>/<tier>/<split>/<seed>`.
 * @property {string} game
 * @property {string} tier
 * @property {string} seed
 * @property {'verified' | 'end-record'} verdict `verified` = both sides
 *   replay-verified against the current game; `end-record` = the recorded
 *   game version is older than the current one, so the pair is scored from
 *   its recorded end only and is never presented as replay-verified.
 * @property {{ recorded: string, current: string } | null} versionDrift
 * @property {{ agent: string, outcome: string, episodeScore: number | null }} a
 * @property {{ agent: string, outcome: string, episodeScore: number | null }} b
 * @property {'a' | 'b' | 'tie'} winner
 */

/**
 * @typedef {object} BundleGameSummary
 * @property {string} game
 * @property {number} aWins
 * @property {number} ties
 * @property {number} bWins
 * @property {number} pairs
 * @property {number | null} signTestP Two-sided exact sign-test p-value
 *   (ties dropped); null when no pair was decisive.
 */

/**
 * @typedef {object} BundleCompare
 * @property {'playkit-gauntlet-replay-compare/1'} format
 * @property {'bundle'} mode
 * @property {{ a: { dir: string, agent: string, episodes: number }, b: { dir: string, agent: string, episodes: number } }} bundles
 * @property {BundlePair[]} pairs
 * @property {BundleGameSummary[]} games
 * @property {{ a: string[], b: string[] }} unpaired Episode keys present in
 *   only one bundle.
 * @property {{ key: string, reason: string }[]} refused Pairs that could not
 *   be compared: the two sides disagree on identity, or replay verification
 *   failed for a same-version pair.
 * @property {string[]} ignored Files in the run directories that are not
 *   trajectory JSON (run.json, suite.json, …) — filled by the CLI walker.
 */

/**
 * The identity two trajectories must share before they may be compared.
 *
 * @param {Trajectory} a
 * @param {Trajectory} b
 */
function requireSameIdentity(a, b) {
  for (const [field, va, vb] of [
    ['game', a.game.id, b.game.id],
    ['version', a.game.version, b.game.version],
    ['tier', a.tier, b.tier],
    ['seed', a.seed, b.seed],
  ]) {
    if (va !== vb) {
      throw new CompareRefusedError(
        /** @type {string} */ (field),
        `refused to compare: ${field} mismatch — A is ${JSON.stringify(va)}, B is ${JSON.stringify(vb)}`
      );
    }
  }
}

/**
 * Episode score for one trajectory on its tier, replicating
 * `scoring/score.js` `episodeScore` (the default rhae-v1 profile): outcome
 * tiers take `outcome.normalized[seat]`; efficiency tiers take
 * `min(cap, (par/agentActions)²)` when solved, 0 otherwise. Null when the
 * end record cannot be scored honestly (solved without a finite par, …).
 *
 * @param {TierSpec} tier
 * @param {Trajectory} trajectory
 * @returns {number | null}
 */
export function episodeScoreOf(tier, trajectory) {
  const outcome = trajectory.end.outcome;
  const seat = trajectory.agent ? trajectory.agent.seat : undefined;
  if (tier.scoring === 'outcome') {
    const value =
      outcome && Array.isArray(outcome.normalized) && typeof seat === 'number'
        ? outcome.normalized[seat]
        : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  if (!outcome || outcome.solved !== true) return 0;
  const par = outcome.par;
  if (typeof par !== 'number' || !Number.isFinite(par) || par <= 0) return null;
  const agentActions = trajectory.end.agentActions;
  if (!Number.isInteger(agentActions) || agentActions <= 0) return null;
  const cap = tier.parKind === 'optimal' ? EFFICIENCY_CAP_OPTIMAL : EFFICIENCY_CAP_REFERENCE;
  return Math.min(cap, (par / agentActions) ** 2);
}

/**
 * Two-sided exact sign test on paired wins: p = 2 · P(X ≥ max(winsA, winsB))
 * under Binomial(n, ½), ties dropped. Binomial coefficients are exact via
 * BigInt. Null when no pair was decisive.
 *
 * @param {number} winsA
 * @param {number} winsB
 * @returns {number | null}
 */
export function signTestP(winsA, winsB) {
  const n = winsA + winsB;
  if (n === 0) return null;
  const k = Math.max(winsA, winsB);
  /** @type {bigint} */
  let c = 1n;
  /** @type {bigint} */
  let tail = 0n;
  for (let i = 0; i <= n; i++) {
    if (i > 0) c = (c * BigInt(n - i + 1)) / BigInt(i);
    if (i >= k) tail += c;
  }
  return Math.min(1, 2 * (Number(tail) / 2 ** n));
}

/**
 * @param {ReplayFrame} frame
 * @returns {boolean}
 */
function isUndoStyle(frame) {
  return !frame.parse.invalid && frame.parse.canonical !== null && /undo/i.test(frame.parse.canonical);
}

/**
 * Sum an agent's token usage over its steps. Nulls stay honest: a step with
 * no usage record lands in `unknownSteps`; reported sums cover only steps
 * that reported a count.
 *
 * @param {ReplayFrame[]} frames Agent frames.
 * @returns {AgentTokens}
 */
function tokensOf(frames) {
  let input = 0;
  let output = 0;
  let inputSeen = false;
  let outputSeen = false;
  let unknownSteps = 0;
  for (const frame of frames) {
    const usage = /** @type {Usage | null} */ (frame.usage);
    if (!usage) {
      unknownSteps++;
      continue;
    }
    if (typeof usage.inputTokens === 'number') {
      input += usage.inputTokens;
      inputSeen = true;
    }
    if (typeof usage.outputTokens === 'number') {
      output += usage.outputTokens;
      outputSeen = true;
    }
  }
  return {
    inputTokens: inputSeen ? input : null,
    outputTokens: outputSeen ? output : null,
    totalTokens: inputSeen || outputSeen ? input + output : null,
    unknownSteps,
  };
}

/**
 * @param {ReplayFrame[]} frames Agent frames.
 * @returns {AgentLatency}
 */
function latencyOf(frames) {
  const totalMs = frames.reduce((sum, f) => sum + f.ms, 0);
  return {
    totalMs,
    meanMs: frames.length ? totalMs / frames.length : null,
    maxMs: frames.length ? Math.max(...frames.map((f) => f.ms)) : null,
  };
}

/**
 * Sum of agent-step costs; null when any agent step's cost is unknown — the
 * same honesty rule as `scoring/score.js` `trajectoryCost`.
 *
 * @param {ReplayFrame[]} frames Agent frames.
 * @returns {number | null}
 */
function costOf(frames) {
  let sum = 0;
  for (const frame of frames) {
    const usage = /** @type {Usage | null} */ (frame.usage);
    if (!usage || typeof usage.costUsd !== 'number' || !Number.isFinite(usage.costUsd)) {
      return null;
    }
    sum += usage.costUsd;
  }
  return sum;
}

/**
 * @param {Trajectory} trajectory
 * @returns {number | null}
 */
function wallMsOf(trajectory) {
  const start = Date.parse(trajectory.startedAt);
  const end = Date.parse(trajectory.finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

/**
 * Per-agent stats from one verified replay. `otherAgentFrames` feeds the
 * undo-grammar check: if the other agent played an undo-style action, the
 * grammar has one and this agent's count is 0 rather than null.
 *
 * @param {Trajectory} trajectory
 * @param {ReplayFrame[]} allFrames All frames of this replay.
 * @param {ReplayFrame[]} otherAgentFrames Agent frames of the other replay.
 * @returns {AgentCompare}
 */
function agentCompareOf(trajectory, allFrames, otherAgentFrames) {
  const frames = allFrames.filter((f) => f.by === 'agent');
  /** @type {Map<string, number>} */
  const invalidByReason = new Map();
  /** @type {Map<string, number>} */
  const actionCounts = new Map();
  const seenHashes = new Set();
  let revisited = 0;
  let invalid = 0;
  for (const frame of frames) {
    if (seenHashes.has(frame.observation.hash)) revisited++;
    seenHashes.add(frame.observation.hash);
    if (frame.parse.invalid) {
      invalid++;
      const reason = frame.parse.reason ?? 'unparseable action';
      invalidByReason.set(reason, (invalidByReason.get(reason) ?? 0) + 1);
    } else if (frame.parse.canonical !== null) {
      actionCounts.set(frame.parse.canonical, (actionCounts.get(frame.parse.canonical) ?? 0) + 1);
    }
  }
  const validActions = frames.length - invalid;
  const grammarHasUndo = frames.some(isUndoStyle) || otherAgentFrames.some(isUndoStyle);

  return {
    id: trajectory.agent.id,
    model: trajectory.agent.model,
    track: trajectory.agent.track,
    seat: trajectory.agent.seat,
    attempts: frames.length,
    validActions,
    invalidActions: invalid,
    invalidByReason: [...invalidByReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((x, y) => y.count - x.count || x.reason.localeCompare(y.reason)),
    distinctObservations: seenHashes.size,
    revisitedStates: revisited,
    topActions: [...actionCounts.entries()]
      .map(([action, count]) => ({ action, count, share: validActions ? count / validActions : 0 }))
      .sort((x, y) => y.count - x.count || x.action.localeCompare(y.action))
      .slice(0, 10),
    undoStyleActions: grammarHasUndo ? frames.filter(isUndoStyle).length : null,
    tokens: tokensOf(frames),
    latency: latencyOf(frames),
    costUsd: costOf(frames),
    wallMs: wallMsOf(trajectory),
    end: /** @type {EndSummary} */ (/** @type {*} */ ({})),
  };
}

/**
 * First divergence between two verified replays. Steps are compared pairwise
 * by index: the first step where the observation hashes differ (the positions
 * split — in two-seat games the opponent can cause this) or where the
 * referee's decision differs (what each agent tried, or whether its reply
 * was accepted). When one episode simply ends first, that is the divergence.
 *
 * @param {ReplayFrame[]} a
 * @param {ReplayFrame[]} b
 * @returns {{ divergence: Divergence | null, identical: boolean }}
 */
function divergenceOf(a, b) {
  /** @param {ReplayFrame} f @returns {DivergenceSide} */
  const sideOf = (f) => ({
    observation: { text: f.observation.text, hash: f.observation.hash },
    replyText: f.reply.text,
    attempted: f.parse.attempted,
    canonical: f.parse.canonical,
    invalid: f.parse.invalid,
    action: f.action,
  });
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const fa = a[i];
    const fb = b[i];
    const observationMatch = fa.observation.hash === fb.observation.hash;
    const decisionMatch =
      fa.parse.canonical === fb.parse.canonical && fa.parse.invalid === fb.parse.invalid;
    if (!observationMatch) {
      return {
        divergence: { index: i, reason: 'observation-differs', observationMatch, a: sideOf(fa), b: sideOf(fb) },
        identical: false,
      };
    }
    if (!decisionMatch) {
      return {
        divergence: { index: i, reason: 'actions-differ', observationMatch, a: sideOf(fa), b: sideOf(fb) },
        identical: false,
      };
    }
  }
  if (a.length !== b.length) {
    const aLonger = a.length > b.length;
    return {
      divergence: {
        index: shared,
        reason: aLonger ? 'b-ended' : 'a-ended',
        observationMatch: true,
        a: aLonger ? null : sideOf(a[shared]),
        b: aLonger ? sideOf(b[shared]) : null,
      },
      identical: false,
    };
  }
  return { divergence: null, identical: true };
}

/**
 * Compare two verified trajectories of the same episode.
 *
 * @param {Game<*>} game
 * @param {Trajectory} a
 * @param {Trajectory} b
 * @param {{ pathA?: string, pathB?: string }} [options] Names used in refusal
 *   messages (defaults: the trajectories' game/tier/seed).
 * @returns {Promise<EpisodeCompare>}
 * @throws {CompareRefusedError} when game, version, tier or seed differ.
 * @throws {ReplayRefusedError} when either trajectory fails replay verification.
 */
export async function compareTrajectories(game, a, b, options = {}) {
  requireSameIdentity(a, b);
  const pathA = options.pathA ?? `${a.game.id}/${a.tier} seed ${a.seed}`;
  const pathB = options.pathB ?? `${b.game.id}/${b.tier} seed ${b.seed}`;
  const payloadA = await buildFrames(game, a, { path: pathA });
  const payloadB = await buildFrames(game, b, { path: pathB });

  const agentFramesA = payloadA.frames.filter((f) => f.by === 'agent');
  const agentFramesB = payloadB.frames.filter((f) => f.by === 'agent');

  const statsA = agentCompareOf(a, payloadA.frames, agentFramesB);
  const statsB = agentCompareOf(b, payloadB.frames, agentFramesA);

  const tier = /** @type {TierSpec} */ (game.spec.tiers.find((t) => t.id === a.tier));
  /** @param {Trajectory} trajectory @returns {EndSummary} */
  const endOf = (trajectory) => {
    const outcome = trajectory.end.outcome;
    const seat = trajectory.agent.seat;
    return {
      reason: trajectory.end.reason,
      agentActions: trajectory.end.agentActions,
      invalidActions: trajectory.end.invalidActions,
      outcomeScore:
        outcome && Array.isArray(outcome.normalized) && typeof outcome.normalized[seat] === 'number'
          ? outcome.normalized[seat]
          : null,
      solved: outcome && typeof outcome.solved === 'boolean' ? outcome.solved : null,
      par: outcome && typeof outcome.par === 'number' ? outcome.par : null,
      episodeScore: episodeScoreOf(tier, trajectory),
    };
  };
  statsA.end = endOf(a);
  statsB.end = endOf(b);

  const { divergence, identical } = divergenceOf(payloadA.frames, payloadB.frames);

  return {
    format: 'playkit-gauntlet-replay-compare/1',
    mode: 'episode',
    game: { ...a.game },
    tier: a.tier,
    seed: a.seed,
    splits: { a: a.split, b: b.split },
    agents: {
      a: { id: a.agent.id, model: a.agent.model, track: a.agent.track },
      b: { id: b.agent.id, model: b.agent.model, track: b.agent.track },
    },
    a: statsA,
    b: statsB,
    divergence,
    identical,
  };
}

/**
 * Outcome line for an end record: the recorded reason plus the agent-seat
 * normalized score where one exists.
 *
 * @param {TierSpec} tier
 * @param {Trajectory} trajectory
 * @returns {{ outcome: string, episodeScore: number | null }}
 */
export function outcomeOf(tier, trajectory) {
  const score = episodeScoreOf(tier, trajectory);
  const outcome = trajectory.end.outcome;
  const seat = trajectory.agent.seat;
  const normalized =
    outcome && Array.isArray(outcome.normalized) && typeof outcome.normalized[seat] === 'number'
      ? outcome.normalized[seat]
      : null;
  const suffix = normalized !== null ? ` · ${normalized.toFixed(3)}` : '';
  return { outcome: `${trajectory.end.reason}${suffix}`, episodeScore: score };
}

/**
 * Pair two run bundles episode by episode. Entries are keyed
 * `<game>/<tier>/<split>/<seed>` from the trajectory contents themselves, so
 * directory layout is incidental and a bundle may span games (pass a
 * `getGameOf` that resolves each trajectory's game from the registry).
 *
 * A pair whose two sides agree on identity and whose recorded game version
 * matches the current implementation is fully replay-verified (`verified`).
 * A pair whose recorded version is older than the current implementation
 * cannot re-verify honestly — observations may have changed with the game —
 * so it is scored from its recorded end only and marked `end-record` with the
 * drift named. The run's own `bundle verify` verified these end records at
 * their commit; this tool never presents them as replay-verified. A pair
 * whose two sides disagree on game/version/tier/seed, or whose verification
 * fails for any other reason, lands in `refused` with the reason.
 *
 * @param {Map<string, TrajectoryEntry>} entriesA
 * @param {Map<string, TrajectoryEntry>} entriesB
 * @param {{ getGameOf: (trajectory: Trajectory) => Game<*>, dirA?: string, dirB?: string }} helpers
 * @returns {Promise<BundleCompare>}
 */
export async function compareBundles(entriesA, entriesB, helpers) {
  const { getGameOf } = helpers;
  /** @type {BundlePair[]} */
  const pairs = [];
  /** @type {{ key: string, reason: string }[]} */
  const refused = [];
  const keysA = [...entriesA.keys()].sort();
  const keysB = [...entriesB.keys()].sort();
  const unpairedA = keysA.filter((k) => !entriesB.has(k));
  const unpairedB = keysB.filter((k) => !entriesA.has(k));

  for (const key of keysA.filter((k) => entriesB.has(k))) {
    const entryA = /** @type {TrajectoryEntry} */ (entriesA.get(key));
    const entryB = /** @type {TrajectoryEntry} */ (entriesB.get(key));
    const a = entryA.trajectory;
    const b = entryB.trajectory;
    try {
      requireSameIdentity(a, b);
    } catch (err) {
      refused.push({ key, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const trajectoryGame = getGameOf(a);
    const tier = /** @type {TierSpec} */ (trajectoryGame.spec.tiers.find((t) => t.id === a.tier));
    const current = trajectoryGame.spec.version;
    const drift = a.game.version !== current ? { recorded: a.game.version, current } : null;

    if (!drift) {
      // Current-version pair: both sides must replay-verify. A refusal here
      // is a real problem (tampering, corruption) — refuse the pair by name.
      try {
        await buildFrames(trajectoryGame, a, { path: entryA.path });
        await buildFrames(trajectoryGame, b, { path: entryB.path });
      } catch (err) {
        refused.push({ key, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
    }

    const agentA = { agent: a.agent.id, ...outcomeOf(tier, a) };
    const agentB = { agent: b.agent.id, ...outcomeOf(tier, b) };
    const scoreA = agentA.episodeScore;
    const scoreB = agentB.episodeScore;
    const winner = scoreA === null || scoreB === null || scoreA === scoreB ? 'tie' : scoreA > scoreB ? 'a' : 'b';
    pairs.push({
      key,
      game: a.game.id,
      tier: a.tier,
      seed: a.seed,
      verdict: drift ? 'end-record' : 'verified',
      versionDrift: drift,
      a: agentA,
      b: agentB,
      winner,
    });
  }

  /** @type {Map<string, BundlePair[]>} */
  const byGame = new Map();
  for (const pair of pairs) {
    if (!byGame.has(pair.game)) byGame.set(pair.game, []);
    /** @type {BundlePair[]} */ (byGame.get(pair.game)).push(pair);
  }
  /** @type {BundleGameSummary[]} */
  const games = [];
  for (const [gameId, gamePairs] of [...byGame.entries()].sort()) {
    const aWins = gamePairs.filter((p) => p.winner === 'a').length;
    const ties = gamePairs.filter((p) => p.winner === 'tie').length;
    const bWins = gamePairs.filter((p) => p.winner === 'b').length;
    games.push({
      game: gameId,
      aWins,
      ties,
      bWins,
      pairs: gamePairs.length,
      signTestP: signTestP(aWins, bWins),
    });
  }

  /** @param {Map<string, TrajectoryEntry>} entries */
  const bundleOf = (entries) => {
    const first = entries.values().next().value;
    return {
      agent: first ? first.trajectory.agent.id : 'unknown',
      episodes: entries.size,
    };
  };

  return {
    format: 'playkit-gauntlet-replay-compare/1',
    mode: 'bundle',
    bundles: {
      a: { dir: helpers.dirA ?? '', ...bundleOf(entriesA) },
      b: { dir: helpers.dirB ?? '', ...bundleOf(entriesB) },
    },
    pairs,
    games,
    unpaired: { a: unpairedA, b: unpairedB },
    refused,
    ignored: [],
  };
}
