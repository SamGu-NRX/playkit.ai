/**
 * The skill dial: an expert agent degraded toward random play by a noise
 * probability `p`, giving the benchmark a ladder of known-strength agents
 * between "expert" (p=0) and "uniform random" (p=1). Other packets use the
 * same definition, so their results compare.
 *
 * Pinned semantics (do not change without a version bump of every study):
 *
 * - `skillDial(expert, p, { episodeSeed })` is a baseline-track agent with id
 *   `dial-<expert id>-p<p*100>` (percentage rounded, so p=0.1 gives `p10`).
 * - On each turn it draws `u` from
 *   `rngFromSeed(`${episodeSeed}/dial/${p}/${ctx.turn}`)` — one draw, the
 *   pure `nextFloat` over that state.
 * - If `u < p` it plays the legal action that `createRandomAgent`
 *   (`agents/random.js`, default id `random`) would play on that turn — the
 *   same stream, the same rejection-sampled index, so at p=1 the dial's
 *   trajectory is byte-for-byte the random agent's.
 * - Otherwise it plays the expert's reply, verbatim (text, usage, meta), so
 *   at p=0 the dial's trajectory is byte-for-byte the expert's.
 *
 * The dial always plays a legal action, so its turns never burn invalid
 * attempts and its `ctx.turn` advances in lockstep with the expert's and the
 * random agent's — which is what makes the p=0 and p=1 identities exact.
 * Pure JS, no `node:*`.
 *
 * @module
 */

import { nextFloat, nextInt, rngFromSeed } from '../core/rng.js';

/** @import { Agent, AgentReply, TurnContext } from '../core/types.js' */

/**
 * @typedef {object} SkillDialOptions
 * @property {string} episodeSeed The episode's seed string — the same string
 *   the expert and the comparison random agent are constructed with.
 */

/**
 * Build the dial for one episode. Like the baseline agents it wraps, it needs
 * the episode seed at construction: `TurnContext` carries no seed, and the
 * pinned streams are keyed by it.
 *
 * @param {Agent} expert The expert agent. Its `id` names the dial
 *   (`dial-<expert id>-p<pct>`); construct it per episode the way the
 *   calibration kit does, since packet baselines close over the episode.
 * @param {number} p Noise probability in [0, 1]: the chance a turn plays the
 *   random agent's move instead of the expert's. 0 = pure expert, 1 = pure
 *   random.
 * @param {SkillDialOptions} options
 * @returns {Agent}
 */
export function skillDial(expert, p, { episodeSeed }) {
  if (!expert || typeof expert.act !== 'function') {
    throw new Error('skillDial: expert must be an Agent with an act() method');
  }
  if (typeof expert.id !== 'string' || expert.id.length === 0) {
    throw new Error('skillDial: expert must carry a non-empty id to name the dial');
  }
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`skillDial: p must be a number in [0, 1], got ${p}`);
  }
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('skillDial: episodeSeed is required');
  }
  const percent = Math.round(p * 100);
  return {
    id: `dial-${expert.id}-p${percent}`,
    track: /** @type {'baseline'} */ ('baseline'),
    /**
     * @param {TurnContext} ctx
     * @returns {Promise<AgentReply>}
     */
    async act(ctx) {
      const u = nextFloat(rngFromSeed(`${episodeSeed}/dial/${p}/${ctx.turn}`)).value;
      if (u < p) {
        const legal = ctx.legalActions;
        if (!legal || legal.length === 0) {
          throw new Error(
            `skill dial "${expert.id}" p${percent} received no legal actions; noisy play needs the baseline track`
          );
        }
        // Exactly what createRandomAgent({ episodeSeed }) plays on this turn:
        // its stream key, its rejection-sampled index, its reply shape.
        const state = rngFromSeed(`${episodeSeed}/random/${ctx.turn}`);
        const pick = nextInt(state, 0, legal.length - 1).value;
        return { text: legal[pick] };
      }
      return expert.act(ctx);
    },
  };
}
