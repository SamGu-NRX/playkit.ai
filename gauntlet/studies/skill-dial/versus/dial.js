/**
 * The skill dial: a baseline-track agent that interpolates between an expert
 * and uniform random play at a known rate, giving every game a ladder of
 * known-strength opponents measured on the same scale.
 *
 * Pinned definition (shared by every packet that measures the dial, so
 * results compare across packets):
 *
 * - `skillDial(expert, p)` is a baseline-track agent with id
 *   `dial-<expert id>-p<p*100>`.
 * - On each turn it draws `u` from `rngFromSeed(`${episodeSeed}/dial/${p}/${ctx.turn}`)`
 *   (core/rng.js) as a float in [0, 1).
 * - If `u < p` it plays the legal action that `createRandomAgent`
 *   (agents/random.js) would play on that turn — the bundled uniform pick over
 *   `legalActions`, streamed from `<episodeSeed>/random/<turn>`, so the random
 *   moves are exactly the ones the p=1 endpoint and the `random` baseline play.
 * - Otherwise it plays the expert's reply, forwarded verbatim.
 * - `p` takes the values 0, 0.1, 0.25, 0.5, 0.75 and 1: p=1 is the random
 *   agent, p=0 is the expert.
 *
 * This is the studies/skill-dial/versus copy. Another packet ships the same
 * definition at `agents/skill-dial.js`; the two must match exactly. A later
 * round replaces this copy with an import of that file.
 *
 * Pure JS (no `node:*`), so it also runs in the browser.
 *
 * @module
 */

import { createRandomAgent } from '../../../agents/random.js';
import { nextFloat, rngFromSeed } from '../../../core/rng.js';

/** @import { Agent, AgentReply, TurnContext } from '../../../core/types.js' */

/** The p values the dial is measured at, in rung order. */
export const SKILL_DIAL_PS = /** @type {const} */ ([0, 0.1, 0.25, 0.5, 0.75, 1]);

/**
 * The dial agent id for an expert and a p value: `dial-<expert id>-p<p*100>`
 * with p*100 rounded, so p=0.1 is `...-p10` and p=1 is `...-p100`.
 *
 * @param {string} expertId The expert agent's id.
 * @param {number} p The random-move probability, in [0, 1].
 * @returns {string}
 */
export function skillDialId(expertId, p) {
  return `dial-${expertId}-p${Math.round(p * 100)}`;
}

/**
 * @typedef {object} SkillDialOptions
 * @property {Agent} expert The expert the dial falls back to. The study's
 *   expert is the game's `engine` baseline, or `greedy` where no engine
 *   exists; with the core kit's baselines the expert must be a baseline-track
 *   agent, because the random branch reads `ctx.legalActions`, which the
 *   runner supplies on the baseline track only.
 * @property {number} p Random-move probability in [0, 1]. Exactly p=0 plays
 *   the expert every turn and exactly p=1 plays random every turn (the dial
 *   compares `u < p` against a float u in [0, 1), so u < 1 always fires).
 * @property {string} episodeSeed The episode's seed string — the dial and the
 *   random branch both key their streams off it.
 * @property {string} [id] Overrides the pinned `dial-<expert id>-p<p*100>` id.
 * @property {'baseline' | 'official' | 'community'} [track] Default
 *   "baseline": the dial reads `ctx.legalActions`.
 */

/**
 * Build the skill dial for one episode.
 *
 * @param {SkillDialOptions} options
 * @returns {Agent} A baseline-track agent with the pinned dial id.
 * @throws {Error} when the options are malformed or p is outside [0, 1].
 */
export function createSkillDialAgent({ expert, p, episodeSeed, id, track = 'baseline' }) {
  if (!expert || typeof expert.act !== 'function') {
    throw new Error('createSkillDialAgent: options.expert must be an Agent');
  }
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`createSkillDialAgent: p must be a number in [0, 1], got ${String(p)}`);
  }
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('createSkillDialAgent: episodeSeed is required');
  }
  // The exact random move the bundled random agent would play on this turn,
  // from the same stream key the `random` baseline uses.
  const randomAgent = createRandomAgent({ episodeSeed, id: 'random' });
  /** @type {(ctx: TurnContext) => Promise<AgentReply>} */
  const randomMove = (ctx) => /** @type {Promise<AgentReply>} */ (randomAgent.act(ctx));
  return {
    id: id ?? skillDialId(expert.id, p),
    track,
    /**
     * @param {TurnContext} ctx
     * @returns {Promise<AgentReply>}
     */
    async act(ctx) {
      const u = nextFloat(rngFromSeed(`${episodeSeed}/dial/${p}/${ctx.turn}`)).value;
      if (u < p) {
        return randomMove(ctx);
      }
      return expert.act(ctx);
    },
  };
}

/**
 * The pinned two-argument form: `skillDial(expert, p)`. Episode options
 * (episodeSeed) are required because the dial's streams key off them.
 *
 * @param {Agent} expert The expert the dial falls back to.
 * @param {number} p Random-move probability in [0, 1].
 * @param {{ episodeSeed: string, id?: string, track?: 'baseline' | 'official' | 'community' }} episode
 *   The episode the dial plays.
 * @returns {Agent}
 */
export function skillDial(expert, p, episode) {
  if (!episode || typeof episode.episodeSeed !== 'string') {
    throw new Error('skillDial: an episode with episodeSeed is required');
  }
  return createSkillDialAgent({ expert, p, episodeSeed: episode.episodeSeed, id: episode.id, track: episode.track });
}
