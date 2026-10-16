/**
 * The pinned skill dial used by the on-ramp studies (and by every other
 * packet that measures a difficulty ladder, so results compare across
 * packets). `agents/skill-dial.js` is landing separately; this local copy
 * exists only so this study and its companion tests do not depend on that
 * packet's timing. The definition here is the pinned one, verbatim:
 *
 * `skillDial(expert, p)` is a baseline-track agent with id
 * `dial-<expert id>-p<p*100>`. On each turn it draws `u` from
 * `rngFromSeed(`${episodeSeed}/dial/${p}/${ctx.turn}`)` (core/rng.js). If
 * `u < p` it plays the legal action that `createRandomAgent`
 * (agents/random.js) would play on that turn; otherwise it plays the
 * expert's reply. `p` takes the values 0, 0.1, 0.25, 0.5, 0.75 and 1, so
 * p=1 is the random agent and p=0 is the expert.
 *
 * `episodeSeed` is not on `TurnContext`, so it is passed at construction
 * like every bundled baseline takes it. The random branch reproduces
 * `createRandomAgent`'s stream exactly: `rngFromSeed(`${episodeSeed}/random/${turn}`)`
 * over `ctx.legalActions` — the `u` draw reads a different stream and does
 * not perturb it, so dial-p1 replays the random agent move for move. When
 * the expert throws instead of replying (no defined reply for the state),
 * the dial plays the random branch for that turn and counts it on
 * `fallbackCount`.
 *
 * Pure JS, no `node:*`.
 *
 * @module
 */

import { nextFloat, nextInt, rngFromSeed } from '../../core/rng.js';

/** @import { Agent } from '../../core/types.js' */

/** The pinned p ladder. */
export const DIAL_P_VALUES = /** @type {const} */ ([0, 0.1, 0.25, 0.5, 0.75, 1]);

/**
 * The dial agent id: `dial-<expert id>-p<p*100>`.
 * @param {string} expertId
 * @param {number} p
 * @returns {string}
 */
export function dialId(expertId, p) {
  return `dial-${expertId}-p${p * 100}`;
}

/**
 * Build the skill dial around one expert agent for one episode. The expert
 * is only asked to act on turns the dial delegates to it; between its turns
 * the game state may have moved (that is the point), and every bundled
 * engine baseline replans from the observation it is handed.
 *
 * @param {{ expert: Agent, p: number, episodeSeed: string }} options
 * @returns {Agent}
 */
export function skillDial({ expert, p, episodeSeed }) {
  if (!(p >= 0 && p <= 1)) {
    throw new Error(`skillDial: p must be in [0, 1], got ${p}`);
  }
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('skillDial: episodeSeed is required');
  }
  return {
    id: dialId(expert.id, p),
    track: /** @type {'baseline'} */ ('baseline'),
    /** Times the expert failed to reply this episode (e.g. the cube solver's
     * proven-range guard). Study-visible for honest reporting. */
    fallbackCount: 0,
    /**
     * @param {import('../../core/types.js').TurnContext} ctx
     * @returns {Promise<import('../../core/types.js').AgentReply>}
     */
    async act(ctx) {
      const u = nextFloat(rngFromSeed(`${episodeSeed}/dial/${p}/${ctx.turn}`)).value;
      if (u < p) {
        return this.randomReply(ctx);
      }
      try {
        return await expert.act(ctx);
      } catch {
        // The expert has no reply for this state (for example the cube
        // baseline solver refuses scrambles beyond its proven range). A
        // throw is not a reply, so the dial falls back to the random branch
        // for this turn and counts it — the fallback rate is reported with
        // the results instead of being silently folded into the score.
        this.fallbackCount += 1;
        return this.randomReply(ctx);
      }
    },
    /**
     * Exactly what createRandomAgent({ episodeSeed }) would play on this
     * turn: its seeded stream over the same legal action list.
     *
     * @param {import('../../core/types.js').TurnContext} ctx
     * @returns {import('../../core/types.js').AgentReply}
     */
    randomReply(ctx) {
      const legal = /** @type {string[]} */ (ctx.legalActions);
      if (!legal || legal.length === 0) {
        throw new Error(`skillDial "${this.id}": no legal actions on turn ${ctx.turn}`);
      }
      const pick = nextInt(rngFromSeed(`${episodeSeed}/random/${ctx.turn}`), 0, legal.length - 1).value;
      return { text: legal[pick] };
    },
  };
}
