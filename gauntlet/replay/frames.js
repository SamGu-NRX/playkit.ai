/**
 * Replay frames: re-run a recorded trajectory through its game and return one
 * frame per recorded step, so a viewer can show what the agent saw, what it
 * replied, how the referee judged the reply, and where the score moved.
 *
 * Trajectories store actions and replies, not observations — only an FNV-1a
 * hash of each observation. So the only way to show an episode is to replay it
 * through the game, which also re-verifies it: `buildFrames` refuses loudly
 * (naming the step) when `verifyTrajectory` rejects the trajectory, and again
 * if a re-derived observation hash ever disagrees with the recorded one.
 *
 * The per-frame score on outcome tiers is the game's own `truncate()` value
 * for the position after the step — the score the episode would record if the
 * agent's budget ran out there. It is a running positional score, not a
 * reward; on efficiency tiers it stays null until the game ends solved. The
 * final frame of a terminal episode carries the true end outcome instead.
 *
 * This module must not import `node:*` — it loads in the browser too, where
 * the leaderboard UI consumes its frames payload.
 *
 * @module
 */

import { hashObservation } from '../core/canonical.js';
import { judgeReply } from '../core/runner.js';
import { verifyTrajectory } from '../core/trajectory.js';

/** @import { Game, TierSpec, Trajectory, Usage } from '../core/types.js' */

/**
 * Thrown when a trajectory does not replay. `step` is the 0-based step index
 * the verifier named (-1 for pre-replay problems such as a format/game
 * mismatch); `reason` carries the verifier's explanation.
 */
export class ReplayRefusedError extends Error {
  /**
   * @param {string} trajectoryPath Human-readable trajectory identity for the
   *   message (a file path, or game/tier/seed).
   * @param {number} step
   * @param {string} reason
   */
  constructor(trajectoryPath, step, reason) {
    const at = step < 0 ? 'step -1 (before the first recorded step)' : `step ${step}`;
    super(`refused to replay ${trajectoryPath}: verification failed at ${at}: ${reason}`);
    this.name = 'ReplayRefusedError';
    /** @type {number} */
    this.step = step;
    /** @type {string} */
    this.reason = reason;
  }
}

/**
 * How the referee judged the reply, re-derived exactly as the runner did it
 * (both call `judgeReply`), plus the recorded action for cross-checking.
 *
 * @typedef {object} FrameParse
 * @property {string | null} attempted What `extractAction` read from the reply.
 * @property {string | null} canonical The accepted canonical action, null when invalid.
 * @property {boolean} invalid
 * @property {string | null} reason The invalid-action error, null when valid.
 */

/**
 * @typedef {object} FrameScore
 * @property {number} value Agent-seat score after this step, in [0, 1].
 * @property {'outcome' | 'truncate'} kind 'outcome' once the game is over;
 *   'truncate' for the running positional score before that.
 * @property {number | null} delta Versus the previous frame's value; null on
 *   invalid attempts (the state did not move) and on kind changes.
 */

/**
 * One recorded ply, replayed.
 *
 * @typedef {object} ReplayFrame
 * @property {number} index 0-based step index in the trajectory.
 * @property {number} turn Zero-based attempt index for this seat — the same
 *   number the runner passed in `TurnContext.turn`.
 * @property {number} seat
 * @property {'agent' | 'opponent'} by
 * @property {string} actorId Trajectory agent id, or the opponent's id.
 * @property {string | null} feedback The invalid-action feedback this seat saw
 *   going into the turn (re-derived the way the runner sets it), or null.
 * @property {{ text: string, hash: string, data: * }} observation Re-derived
 *   during replay; `hash` equals the recorded `observationHash`.
 * @property {{ text: string, usage?: *, meta?: * }} reply As recorded — never
 *   re-generated, so a viewer shows exactly what the agent sent.
 * @property {FrameParse} parse
 * @property {string} action The recorded action: the canonical action when
 *   valid, the attempted text when invalid (nothing was applied then).
 * @property {FrameScore | null} score Null on efficiency tiers before the
 *   game ends.
 * @property {number} ms Recorded reply latency for this step.
 * @property {Usage | null} usage As recorded (null for opponent steps).
 * @property {boolean} gameOver True when the game was over after this step.
 */

/**
 * The full replay payload. `end` is the trajectory's recorded end, unchanged.
 *
 * @typedef {object} ReplayFrames
 * @property {'playkit-gauntlet-replay-frames/1'} format
 * @property {{ id: string, version: string }} game
 * @property {string} tier
 * @property {string} seed
 * @property {string} split
 * @property {Trajectory['agent']} agent
 * @property {Trajectory['opponents']} opponents
 * @property {number} agentSeat
 * @property {Trajectory['end']} end
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {ReplayFrame[]} frames
 */

/**
 * Score for the agent seat from the state after a step. Prefers the game's
 * real outcome; falls back to `truncate()` on outcome tiers for the running
 * positional score; returns null on efficiency tiers before the game ends.
 *
 * @param {Game<*>} game
 * @param {TierSpec} tier
 * @param {*} state
 * @param {number} agentSeat
 * @returns {Pick<FrameScore, 'value' | 'kind'> | null}
 */
function positionalScore(game, tier, state, agentSeat) {
  const outcome = game.outcome(state);
  if (outcome && Array.isArray(outcome.normalized)) {
    const value = outcome.normalized[agentSeat];
    return typeof value === 'number' ? { value, kind: 'outcome' } : null;
  }
  if (tier.scoring === 'outcome' && typeof game.truncate === 'function') {
    try {
      const truncated = game.truncate(state);
      const value = truncated && Array.isArray(truncated.normalized)
        ? truncated.normalized[agentSeat]
        : undefined;
      return typeof value === 'number' ? { value, kind: 'truncate' } : null;
    } catch {
      // A game whose truncate() cannot score this position mid-episode simply
      // shows no running score; the recorded end outcome still does.
      return null;
    }
  }
  return null;
}

/**
 * Replay a verified trajectory into frames.
 *
 * @param {Game<*>} game
 * @param {Trajectory} trajectory
 * @param {{ path?: string }} [options] `path` names the trajectory in error
 *   messages (defaults to its game/tier/seed).
 * @returns {Promise<ReplayFrames>}
 * @throws {ReplayRefusedError} when the trajectory does not verify.
 */
export async function buildFrames(game, trajectory, options = {}) {
  const path = options.path ?? `${trajectory.game.id}/${trajectory.tier} seed ${trajectory.seed}`;
  const verdict = await verifyTrajectory(game, trajectory);
  if (!verdict.ok) {
    throw new ReplayRefusedError(path, verdict.step, verdict.reason);
  }

  const tier = /** @type {TierSpec} */ (
    game.spec.tiers.find((t) => t.id === trajectory.tier)
  );
  const agentSeat = trajectory.agent.seat;
  /** @type {Map<number, string>} */
  const opponentIds = new Map(trajectory.opponents.map((o) => [o.seat, o.id]));

  let state = game.reset(tier, trajectory.seed);
  /** @type {number[]} */
  const turns = new Array(game.spec.seats).fill(0);
  /** @type {string | null} */
  let feedback = null;
  /** @type {Pick<FrameScore, 'value' | 'kind'> | null} */
  let previous = null;
  /** @type {ReplayFrame[]} */
  const frames = [];

  for (let i = 0; i < trajectory.steps.length; i++) {
    const step = trajectory.steps[i];
    const seat = /** @type {number} */ (game.toAct(state));
    const legalActions = /** @type {string[]} */ (game.legalActions(state, seat));
    const observation = game.observe(state, seat);
    const hash = hashObservation(observation);
    // verifyTrajectory just checked this; re-checking here keeps the frames
    // honest even if buildFrames' replay ever drifts from the verifier's.
    if (hash !== step.observationHash) {
      throw new ReplayRefusedError(
        path,
        i,
        `replayed observation hash ${hash} disagrees with recorded ${step.observationHash}`
      );
    }
    const replyText =
      step.reply && typeof step.reply.text === 'string' ? step.reply.text : '';
    const decision = judgeReply(game, state, seat, legalActions, replyText);

    /** @type {ReplayFrame} */
    const frame = {
      index: i,
      turn: turns[seat],
      seat,
      by: step.by,
      actorId:
        seat === agentSeat ? trajectory.agent.id : opponentIds.get(seat) ?? `seat-${seat}`,
      feedback,
      observation: {
        text: observation.text,
        hash,
        data: observation.data ?? null,
      },
      reply: {
        text: replyText,
        // The runner records reply.usage, but the TrajectoryStep reply typedef
        // only names text/meta; read it structurally.
        ...(step.reply && /** @type {*} */ (step.reply).usage !== undefined
          ? { usage: /** @type {*} */ (step.reply).usage }
          : {}),
        ...(step.reply && step.reply.meta !== undefined ? { meta: step.reply.meta } : {}),
      },
      parse: {
        attempted: decision.attempted,
        canonical: decision.canonical,
        invalid: decision.invalid,
        reason: decision.reason,
      },
      action: step.action,
      score: null,
      ms: step.ms,
      usage: step.usage ?? null,
      gameOver: false,
    };
    turns[seat]++;

    // Mirror the runner exactly: valid steps (any seat) clear the feedback,
    // invalid agent steps set the next turn's feedback to the referee's
    // reason. Invalid opponent steps cannot reach here — the verifier
    // rejects them before the loop.
    if (decision.invalid) {
      if (seat === agentSeat) feedback = decision.reason;
    } else {
      if (decision.canonical === null) {
        throw new ReplayRefusedError(
          path,
          i,
          'verifier accepted a reply with no canonical action'
        );
      }
      state = game.step(state, seat, decision.canonical);
      feedback = null;
    }

    frame.gameOver = game.toAct(state) === null;
    const score = positionalScore(game, tier, state, agentSeat);
    if (score) {
      const delta =
        !decision.invalid &&
        previous !== null &&
        previous.kind === score.kind
          ? score.value - previous.value
          : null;
      frame.score = { value: score.value, kind: score.kind, delta };
      previous = score;
    }
    frames.push(frame);
  }

  return {
    format: 'playkit-gauntlet-replay-frames/1',
    game: { ...trajectory.game },
    tier: trajectory.tier,
    seed: trajectory.seed,
    split: trajectory.split,
    agent: { ...trajectory.agent },
    opponents: trajectory.opponents.map((o) => ({ ...o })),
    agentSeat,
    end: { ...trajectory.end },
    startedAt: trajectory.startedAt,
    finishedAt: trajectory.finishedAt,
    frames,
  };
}
