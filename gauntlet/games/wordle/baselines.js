/**
 * Bundled Wordle baseline agents. Both act on the baseline track (they read
 * `legalActions`-free observation data) and are deterministic.
 *
 * - `greedy`: the lexicographically first candidate consistent with all
 *   feedback so far — sound but information-blind.
 * - `engine`: the entropy-greedy reference strategy itself (`reference.js`),
 *   the par setter, so it scores exactly 1.0 whenever it solves.
 *
 * No `node:*` imports; no `Math.random`; replays are exact.
 *
 * @module
 */

import { consistentAnswers, answersFor, nextGuess } from './reference.js';

/** @import { Agent, TurnContext } from '../../core/types.js' */
/** @import { WordleHistoryEntry } from './reference.js' */

/**
 * @typedef {object} BaselineOptions
 * @property {string} episodeSeed The episode's seed string.
 */

/**
 * The guess history so far, from the observation payload.
 *
 * @param {TurnContext} ctx
 * @returns {{ wordLength: number, hardMode: boolean, history: WordleHistoryEntry[] }}
 */
function contextOf(ctx) {
  const params = /** @type {{ wordLength: number, hardMode: boolean }} */ (ctx.tier.params);
  const data = /** @type {{ guesses?: WordleHistoryEntry[] }} */ (ctx.observation.data);
  return {
    wordLength: params.wordLength,
    hardMode: params.hardMode,
    history: (data.guesses ?? []).map((entry) => ({ ...entry })),
  };
}

/**
 * The greedy baseline: the lexicographically first answer still consistent
 * with every piece of feedback received so far. Deterministic; the episode
 * seed is accepted for API parity with the other baselines and unused.
 *
 * @param {BaselineOptions} options
 * @returns {Agent}
 */
export function createGreedyAgent({ episodeSeed }) {
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('createGreedyAgent: episodeSeed is required');
  }
  return {
    id: 'greedy',
    track: /** @type {'baseline'} */ ('baseline'),
    async act(ctx) {
      const { wordLength, history } = contextOf(ctx);
      const candidates = consistentAnswers(answersFor(wordLength), history);
      const guess =
        candidates[0] ??
        // Unreachable with correct feedback scoring; fall back to the full
        // answer list rather than crash.
        answersFor(wordLength)[0];
      return { text: `guess ${guess}` };
    },
  };
}

/**
 * The engine baseline: the entropy-greedy reference strategy that sets par.
 * It replays the par computation exactly (same `nextGuess` calls on the same
 * history), so it solves every answer in exactly par guesses.
 *
 * @param {BaselineOptions} options
 * @returns {Agent}
 */
export function createEngineAgent({ episodeSeed }) {
  if (typeof episodeSeed !== 'string' || episodeSeed.length === 0) {
    throw new Error('createEngineAgent: episodeSeed is required');
  }
  return {
    id: 'engine',
    track: /** @type {'baseline'} */ ('baseline'),
    async act(ctx) {
      const { wordLength, hardMode, history } = contextOf(ctx);
      const guess = nextGuess(wordLength, hardMode, history);
      return { text: `guess ${guess}` };
    },
  };
}
