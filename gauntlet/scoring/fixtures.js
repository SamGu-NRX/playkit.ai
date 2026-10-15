/**
 * Fixture games for the scoring tests. These live in `scoring/` because they
 * exist to exercise scoring rules with hand-computable numbers; they are not
 * registered in the game registry. Built through the real runner in tests.
 *
 * @module
 */

import { fnv1a64 } from '../core/canonical.js';
import { runEpisode } from '../core/runner.js';

/** @import { Game, Agent, Trajectory } from '../core/types.js' */
/** @import { SuiteManifest } from './suite.js' */

//
// Countdown — efficiency fixture. The agent must bring a counter to exactly
// zero. "dec" subtracts 1, "dec2" subtracts 2, "wait" does nothing. The
// reference par is the counter's start (a solver that only used "dec"); the
// optimal par is ceil(start / 2) ("dec2" every turn). Exported so tests can
// hand-compute par/agentActions ratios.
//

/**
 * Deterministic start counter for a seed: 4, 5 or 6.
 *
 * @param {string} seed
 * @returns {number}
 */
export function countdownStart(seed) {
  let sum = 0;
  for (let i = 0; i < seed.length; i++) sum += seed.charCodeAt(i);
  return 4 + (sum % 3);
}

/**
 * @typedef {object} CountdownState
 * @property {number} start
 * @property {number} n
 * @property {number} par
 */

/** @type {Game<CountdownState>} */
export const countdown = {
  spec: {
    id: 'countdown',
    version: '1.0.0',
    title: 'Countdown',
    seats: /** @type {1 | 2} */ (1),
    information: 'perfect',
    stochastic: false,
    tags: ['planning'],
    benchmark: true,
    requires: [],
    rulesText:
      'Bring the counter to exactly zero. Actions: "dec" (subtract 1), "dec2" (subtract 2), "wait" (no change).',
    tiers: /** @type {import('../core/types.js').TierSpec[]} */ ([
      {
        id: 'reference-par',
        rank: 1,
        scoring: 'efficiency',
        maxActions: 60,
        publicSeeds: 4,
        params: {},
        parKind: 'reference',
      },
      {
        id: 'optimal-par',
        rank: 2,
        scoring: 'efficiency',
        maxActions: 60,
        publicSeeds: 4,
        params: {},
        parKind: 'optimal',
      },
    ]),
  },

  /**
   * @param {import('../core/types.js').TierSpec} tier
   * @param {string} seed
   * @returns {CountdownState}
   */
  reset(tier, seed) {
    const start = countdownStart(seed);
    const par = tier.parKind === 'optimal' ? Math.ceil(start / 2) : start;
    return { start, n: start, par };
  },

  /**
   * @param {CountdownState} state
   * @returns {number | null}
   */
  toAct(state) {
    return state.n === 0 ? null : 0;
  },

  /**
   * @param {CountdownState} state
   * @param {number} _seat
   * @returns {import('../core/types.js').Observation}
   */
  observe(state, _seat) {
    return { text: `Counter: ${state.n}. Actions: dec, dec2, wait.`, data: { n: state.n } };
  },

  /**
   * @param {CountdownState} state
   * @param {number} _seat
   * @returns {string[]}
   */
  legalActions(state, _seat) {
    return state.n === 0 ? [] : ['dec', 'dec2', 'wait'];
  },

  /**
   * @param {CountdownState} _state
   * @param {number} _seat
   * @param {string} text
   * @returns {import('../core/types.js').ParseResult}
   */
  parseAction(_state, _seat, text) {
    const t = text.trim().toLowerCase();
    if (t === 'dec' || t === 'dec2' || t === 'wait') return { ok: true, action: t };
    return { ok: false, error: `unknown action ${JSON.stringify(text)}` };
  },

  /**
   * @param {CountdownState} state
   * @param {number} _seat
   * @param {string} action
   * @returns {CountdownState}
   */
  step(state, _seat, action) {
    if (action === 'dec') return { ...state, n: state.n - 1 };
    if (action === 'dec2') return { ...state, n: Math.max(0, state.n - 2) };
    return { ...state };
  },

  /**
   * @param {CountdownState} state
   * @returns {import('../core/types.js').Outcome | null}
   */
  outcome(state) {
    if (state.n !== 0) return null;
    return {
      normalized: [1],
      raw: [state.start],
      reason: 'counter reached zero',
      solved: true,
      par: state.par,
    };
  },

  truncate() {
    return { normalized: [0], raw: null, reason: 'ran out of budget' };
  },
};

//
// Take-or-pass — outcome fixture. One action: "take" scores 1, "pass"
// scores 0.25. Outcome tiers ignore action counts, so efficiency rules do
// not leak into it.
//

/**
 * @typedef {object} TakeOrPassState
 * @property {boolean} done
 * @property {boolean} took
 */

/** @type {Game<TakeOrPassState>} */
export const takeOrPass = {
  spec: {
    id: 'take-or-pass',
    version: '1.0.0',
    title: 'Take or Pass',
    seats: /** @type {1 | 2} */ (1),
    information: 'perfect',
    stochastic: false,
    tags: ['planning'],
    benchmark: true,
    requires: [],
    rulesText: 'Choose "take" (score 1) or "pass" (score 0.25).',
    tiers: /** @type {import('../core/types.js').TierSpec[]} */ ([
      { id: 'main', rank: 1, scoring: 'outcome', maxActions: 5, publicSeeds: 2, params: {} },
    ]),
  },

  /**
   * @returns {TakeOrPassState}
   */
  reset() {
    return { done: false, took: false };
  },

  /**
   * @param {TakeOrPassState} state
   * @returns {number | null}
   */
  toAct(state) {
    return state.done ? null : 0;
  },

  /**
   * @param {TakeOrPassState} state
   * @param {number} _seat
   * @returns {import('../core/types.js').Observation}
   */
  observe(state, _seat) {
    return {
      text: state.done ? 'Game over.' : 'Choose: take, pass.',
      data: { done: state.done },
    };
  },

  /**
   * @param {TakeOrPassState} state
   * @param {number} _seat
   * @returns {string[]}
   */
  legalActions(state, _seat) {
    return state.done ? [] : ['pass', 'take'];
  },

  /**
   * @param {TakeOrPassState} _state
   * @param {number} _seat
   * @param {string} text
   * @returns {import('../core/types.js').ParseResult}
   */
  parseAction(_state, _seat, text) {
    const t = text.trim().toLowerCase();
    if (t === 'take' || t === 'pass') return { ok: true, action: t };
    return { ok: false, error: `unknown action ${JSON.stringify(text)}` };
  },

  /**
   * @param {TakeOrPassState} _state
   * @param {number} _seat
   * @param {string} action
   * @returns {TakeOrPassState}
   */
  step(_state, _seat, action) {
    return { done: true, took: action === 'take' };
  },

  /**
   * @param {TakeOrPassState} state
   * @returns {import('../core/types.js').Outcome | null}
   */
  outcome(state) {
    if (!state.done) return null;
    return {
      normalized: [state.took ? 1 : 0.25],
      raw: [state.took ? 1 : 0],
      reason: state.took ? 'took' : 'passed',
    };
  },

  /**
   * @returns {import('../core/types.js').Outcome}
   */
  truncate() {
    return { normalized: [0], raw: null, reason: 'ran out of budget' };
  },
};

//
// Slot — outcome fixture with seed-dependent scores, for bootstrap interval
// tests: the same distribution over 2 seeds versus 6 seeds must give the
// same point estimate and a narrower interval with more episodes.
//

/**
 * Deterministic normalized score for a slot seed. Public seeds end in an
 * integer index; anything else falls back to the observation hash.
 *
 * @param {string} seed
 * @returns {number}
 */
export function slotValue(seed) {
  // First two: mean 0.325 with a wide spread. All six: the same mean 0.325
  // with half the spread, so more episodes narrow the bootstrap interval
  // without moving the point estimate.
  const values = [0.15, 0.5, 0.2, 0.45, 0.3, 0.35];
  const match = /(\d+)$/.exec(seed);
  const index = match ? Number(match[1]) : Number(BigInt(`0x${fnv1a64(seed)}`) % 6n);
  return values[index % values.length];
}

/**
 * @typedef {object} SlotState
 * @property {boolean} done
 * @property {number} value
 */

/**
 * @param {number} publicSeeds
 * @returns {Game<SlotState>}
 */
export function makeSlotGame(publicSeeds) {
  /** @type {Game<SlotState>} */
  return {
    spec: {
      id: 'slot',
      version: '1.0.0',
      title: 'Slot',
      seats: /** @type {1 | 2} */ (1),
      information: 'perfect',
      stochastic: false,
      tags: ['planning'],
      benchmark: true,
      requires: [],
      rulesText: 'Choose "go" to stop the machine and receive your payout.',
      tiers: /** @type {import('../core/types.js').TierSpec[]} */ ([
        { id: 'main', rank: 1, scoring: 'outcome', maxActions: 3, publicSeeds, params: {} },
      ]),
    },

    /**
     * @param {import('../core/types.js').TierSpec} _tier
     * @param {string} seed
     * @returns {SlotState}
     */
    reset(_tier, seed) {
      return { done: false, value: slotValue(seed) };
    },

    /**
     * @param {SlotState} state
     * @returns {number | null}
     */
    toAct(state) {
      return state.done ? null : 0;
    },

    /**
     * @param {SlotState} _state
     * @param {number} _seat
     * @returns {import('../core/types.js').Observation}
     */
    observe(_state, _seat) {
      return { text: 'Choose: go.', data: {} };
    },

    /**
     * @param {SlotState} state
     * @param {number} _seat
     * @returns {string[]}
     */
    legalActions(state, _seat) {
      return state.done ? [] : ['go'];
    },

    /**
     * @param {SlotState} _state
     * @param {number} _seat
     * @param {string} text
     * @returns {import('../core/types.js').ParseResult}
     */
    parseAction(_state, _seat, text) {
      const t = text.trim().toLowerCase();
      if (t === 'go') return { ok: true, action: 'go' };
      return { ok: false, error: `unknown action ${JSON.stringify(text)}` };
    },

    /**
     * @param {SlotState} state
     * @returns {SlotState}
     */
    step(state) {
      return { done: true, value: state.value };
    },

    /**
     * @param {SlotState} state
     * @returns {import('../core/types.js').Outcome | null}
     */
    outcome(state) {
      if (!state.done) return null;
      // The value travels through the step above; keep it from reset instead.
      return { normalized: [state.value], raw: null, reason: 'paid out' };
    },

    /**
     * @returns {import('../core/types.js').Outcome}
     */
    truncate() {
      return { normalized: [0], raw: null, reason: 'ran out of budget' };
    },
  };
}

//
// Test helpers.
//

/**
 * A scripted agent: replies with the given items in order, repeating the
 * last one once the script runs out. Items are reply texts or
 * `{ text, usage }` objects.
 *
 * @param {Array<string | { text: string, usage?: import('../core/types.js').Usage }>} responses
 * @param {{ id?: string, track?: 'baseline' | 'official' | 'community', model?: string, provider?: string, dryRun?: boolean }} [options]
 * @returns {Agent}
 */
export function scriptedAgent(responses, options = {}) {
  let i = 0;
  const act = async () => {
    const response = i < responses.length ? responses[i] : responses[responses.length - 1];
    i++;
    return typeof response === 'string' ? { text: response } : response;
  };
  return /** @type {Agent} */ ({
    id: options.id ?? 'scripted',
    track: options.track ?? 'community',
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    act,
  });
}

/**
 * Run every episode of a suite through the real runner, building each
 * episode's agent with `makeAgent(gameId, tierId, seed)`.
 *
 * @param {SuiteManifest} suite
 * @param {Game<*>[]} games
 * @param {(gameId: string, tierId: string, seed: string) => Agent} makeAgent
 * @returns {Promise<Trajectory[]>}
 */
export async function runSuite(suite, games, makeAgent) {
  const gameById = new Map(games.map((g) => [g.spec.id, g]));
  /** @type {Trajectory[]} */
  const trajectories = [];
  for (const sg of suite.games) {
    const game = /** @type {Game<*>} */ (gameById.get(sg.id));
    for (const st of sg.tiers) {
      for (const seed of st.seeds) {
        trajectories.push(
          await runEpisode({
            game,
            tierId: st.id,
            seed,
            split: suite.split,
            agent: makeAgent(sg.id, st.id, seed),
          })
        );
      }
    }
  }
  return trajectories;
}
