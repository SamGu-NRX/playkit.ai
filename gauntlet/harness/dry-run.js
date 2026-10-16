/**
 * Dry-run agents: official-track agents that produce replies without touching
 * a provider API, so the whole pipeline (runner, games, trajectories,
 * verification) exercises offline. Both report `dryRun: true` and zero usage,
 * and neither imports `node:*`.
 *
 * @module
 */

import { hashObservation } from '../core/canonical.js';

/** @import { Agent, AgentReply, TurnContext, Usage } from '../core/types.js' */
/** @import { Trajectory } from '../core/types.js' */

/** @type {Usage} */
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: null };

/**
 * @typedef {object} ScriptedAgentOptions
 * @property {string} [id] Agent id. Default "scripted".
 */

/**
 * Build an official-track agent from a fixed list of replies or from a
 * function of the turn context. Runs offline: dryRun true, zero usage.
 *
 * With an array, replies are consumed in order and running out is an error —
 * a silent repeat would silently warp the episode. With a function, the
 * function is called each turn and may return the reply text (string) or a
 * full { text, meta? } reply object.
 *
 * @param {string[] | ((ctx: TurnContext) => string | { text: string, meta?: * })} replies
 * @param {ScriptedAgentOptions} [options]
 * @returns {Agent}
 */
export function createScriptedAgent(replies, options = {}) {
  const isFunction = typeof replies === 'function';
  if (!isFunction && !Array.isArray(replies)) {
    throw new Error(
      'createScriptedAgent: replies must be an array of reply strings or a function of the TurnContext'
    );
  }
  const id = options.id ?? 'scripted';
  let index = 0;
  return {
    id,
    track: /** @type {'official'} */ ('official'),
    dryRun: true,
    async act(ctx) {
      let out;
      if (isFunction) {
        out = /** @type {*} */ (replies)(ctx);
      } else {
        const list = /** @type {string[]} */ (replies);
        if (index >= list.length) {
          throw new Error(
            `scripted agent "${id}" ran out of replies: turn ${ctx.turn} asked for reply ${index + 1} but only ${list.length} were supplied`
          );
        }
        out = list[index];
        index += 1;
      }
      const text =
        typeof out === 'string' ? out : out && out.text !== undefined ? out.text : undefined;
      if (typeof text !== 'string') {
        throw new Error(
          `scripted agent "${id}" produced a non-string reply on turn ${ctx.turn}`
        );
      }
      /** @type {AgentReply} */
      const reply = {
        text,
        usage: { ...ZERO_USAGE },
        meta:
          typeof out === 'string'
            ? { scripted: true, ...(isFunction ? {} : { replyIndex: index - 1 }) }
            : { scripted: true, ...(out.meta ?? {}) },
      };
      return reply;
    },
  };
}

/**
 * @typedef {object} ReplayAgentOptions
 * @property {string} [id] Agent id. Default "replay:<original id>".
 */

/**
 * Build an agent that replays the agent replies recorded in a trajectory, in
 * order, offline (dryRun true, zero usage). Each act() checks the live
 * observation hash against the recorded one and refuses to replay when they
 * disagree — a replay against a different game version, tier, or seed must
 * fail loudly instead of producing a plausible-looking trajectory.
 *
 * Opponent plies are not replayed here: the runner generates them live from
 * the game's seeded opponent, which is exactly what replay verification
 * compares against.
 *
 * @param {Trajectory} trajectory The recorded episode to replay.
 * @param {ReplayAgentOptions} [options]
 * @returns {Agent}
 */
export function createReplayAgent(trajectory, options = {}) {
  if (
    !trajectory ||
    !Array.isArray(trajectory.steps) ||
    !trajectory.agent ||
    typeof trajectory.agent.id !== 'string'
  ) {
    throw new Error('createReplayAgent: a trajectory with steps and an agent record is required');
  }
  const agentSteps = trajectory.steps.filter((step) => step && step.by === 'agent');
  if (agentSteps.length === 0) {
    throw new Error('createReplayAgent: the trajectory records no agent replies to replay');
  }
  const id = options.id ?? `replay:${trajectory.agent.id}`;
  let index = 0;
  return {
    id,
    track: trajectory.agent.track,
    dryRun: true,
    ...(trajectory.agent.model !== undefined ? { model: trajectory.agent.model } : {}),
    ...(trajectory.agent.provider !== undefined ? { provider: trajectory.agent.provider } : {}),
    async act(ctx) {
      if (index >= agentSteps.length) {
        throw new Error(
          `replay agent "${id}" ran past the end of the trajectory: turn ${ctx.turn} has no recorded reply (trajectory has ${agentSteps.length} agent replies)`
        );
      }
      const step = agentSteps[index];
      const liveHash = hashObservation(ctx.observation);
      if (liveHash !== step.observationHash) {
        throw new Error(
          `replay agent "${id}": observation mismatch at recorded step ${index}: the live observation hash ${liveHash} does not match the recorded ${step.observationHash}; the game version, tier, seed, or seat differs from the recorded episode`
        );
      }
      index += 1;
      /** @type {AgentReply} */
      return {
        text: step.reply && typeof step.reply.text === 'string' ? step.reply.text : '',
        usage: { ...ZERO_USAGE },
        meta: { replay: true, replayIndex: index - 1 },
      };
    },
  };
}
