/**
 * Chess against Stockfish for the Gauntlet: the chess game's rules,
 * observations, opening book and adjudication, with the tier opponent
 * replaced by a local Stockfish binary searched on a fixed node budget
 * (`go nodes`), one thread and a fixed 16 MB hash, so its play is
 * deterministic for a given position and search history. Four tiers scale
 * the node budget (1k, 10k, 100k, 1M).
 *
 * This game is Node-only by design: it shells out to the `stockfish` binary
 * (`requires: ["stockfish"]`) through the UCI client in
 * `engines/uci/client.js`. The chess game itself stays browser-loadable;
 * this variant is not part of the browser game surface.
 *
 * @module
 */

import { chess } from '../chess/index.js';
import { createStockfishOpponentAgent } from './stockfish-agent.js';

/** @import { Game, TierSpec } from '../../core/types.js' */

const MAX_ACTIONS = 150;

/** Search-timeout ceilings per tier: far above the expected per-move time. */
const SEARCH_TIMEOUT_MS = {
  'sf-250': 10_000,
  'sf-1k': 10_000,
  'sf-10k': 20_000,
  'sf-100k': 30_000,
  'sf-1m': 60_000,
};

/**
 * The chess-stockfish game. Delegates every rule to the `chess` game
 * object; only the tiers and the opponent are its own.
 *
 * @type {Game<import('../chess/index.js').ChessState>}
 */
export const chessStockfish = {
  spec: {
    id: 'chess-stockfish',
    // 1.1.0: the opponent now pins MultiPV 1 and Contempt 0 (and gates
    // UCI_LimitStrength/UCI_Elo on advertisement) in addition to Threads 1
    // and Hash 16. Pinning options the engine may not have had set before
    // can change its play on a binary whose defaults differ, so the spec
    // version moves per the game-versioning rules.
    version: '1.1.0',
    title: 'Chess (Stockfish tiers)',
    seats: /** @type {1 | 2} */ (2),
    information: /** @type {import('../../core/types.js').InformationMode} */ ('perfect'),
    stochastic: false,
    tags: /** @type {import('../../core/types.js').GameTag[]} */ (['adversarial', 'planning']),
    benchmark: true,
    requires: ['stockfish'],
    rulesText:
      chess.spec.rulesText +
      ' In this game your opponent is not the built-in ladder engine but a local Stockfish binary: each of its moves comes from a fixed-node search (`go nodes`), single-threaded with a fixed 16 MB hash, so its play is fully deterministic for a given position and search history.',
    tiers: /** @type {TierSpec[]} */ ([
      {
        id: 'sf-1k',
        rank: 2,
        scoring: 'outcome',
        maxActions: MAX_ACTIONS,
        publicSeeds: 5,
        params: { nodes: 1_000, searchTimeoutMs: SEARCH_TIMEOUT_MS['sf-1k'] },
      },
      {
        id: 'sf-10k',
        rank: 3,
        scoring: 'outcome',
        maxActions: MAX_ACTIONS,
        publicSeeds: 5,
        params: { nodes: 10_000, searchTimeoutMs: SEARCH_TIMEOUT_MS['sf-10k'] },
      },
      {
        id: 'sf-100k',
        rank: 4,
        scoring: 'outcome',
        maxActions: MAX_ACTIONS,
        publicSeeds: 5,
        params: { nodes: 100_000, searchTimeoutMs: SEARCH_TIMEOUT_MS['sf-100k'] },
      },
      {
        id: 'sf-1m',
        rank: 5,
        scoring: 'outcome',
        maxActions: MAX_ACTIONS,
        publicSeeds: 5,
        params: { nodes: 1_000_000, searchTimeoutMs: SEARCH_TIMEOUT_MS['sf-1m'] },
      },
      {
        // Bridge rung for rating-ladder identifiability: weak enough to draw
        // the built-in wood engine while still connected to sf-1k (probed
        // 4/6 vs wood, 1/16 vs sf-1k — nonzero cross scores on both sides).
        id: 'sf-250',
        rank: 1,
        scoring: 'outcome',
        maxActions: MAX_ACTIONS,
        publicSeeds: 5,
        params: { nodes: 250, searchTimeoutMs: SEARCH_TIMEOUT_MS['sf-250'] },
      },
    ]),
  },

  /**
   * Same seeded opening book as the chess game (the tier id enters the RNG
   * stream, so tier/seed pairs pick lines independently).
   *
   * @param {TierSpec} tier
   * @param {string} seed
   */
  reset(tier, seed) {
    return chess.reset(tier, seed);
  },

  /**
   * Seat to act, or null when the game is over.
   *
   * @param {import('../chess/index.js').ChessState} state
   * @returns {number | null}
   */
  toAct(state) {
    return chess.toAct(state);
  },

  /**
   * Full observation, identical to the chess game's.
   *
   * @param {import('../chess/index.js').ChessState} state
   * @param {number} seat
   */
  observe(state, seat) {
    return chess.observe(state, seat);
  },

  /**
   * Sorted legal UCI actions for the mover.
   *
   * @param {import('../chess/index.js').ChessState} state
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(state, seat) {
    return chess.legalActions(state, seat);
  },

  /**
   * Parse UCI or SAN against the current position.
   *
   * @param {import('../chess/index.js').ChessState} state
   * @param {number} seat
   * @param {string} text
   */
  parseAction(state, seat, text) {
    return chess.parseAction(state, seat, text);
  },

  /**
   * Apply a UCI action; throws GauntletRuleError on anything illegal.
   *
   * @param {import('../chess/index.js').ChessState} state
   * @param {number} seat
   * @param {string} action
   */
  step(state, seat, action) {
    return chess.step(state, seat, action);
  },

  /**
   * Outcome of a terminated state, or null while the game runs.
   *
   * @param {import('../chess/index.js').ChessState} state
   */
  outcome(state) {
    return chess.outcome(state);
  },

  /**
   * Truncation adjudication, identical to the chess game's.
   *
   * @param {import('../chess/index.js').ChessState} state
   */
  truncate(state) {
    return chess.truncate(state);
  },

  /**
   * The tier opponent: a local Stockfish at the tier's node budget.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @param {number} seat
   */
  opponent(tier, seed, seat) {
    return createStockfishOpponentAgent({
      tier,
      seed,
      seat,
      id: `chess-stockfish-${tier.id}`,
    });
  },

  /**
   * The agent's seat alternates with the seed, so it plays both colours
   * across the public seed set.
   *
   * @param {TierSpec} tier
   * @param {string} seed
   * @returns {number}
   */
  agentSeat(tier, seed) {
    return chess.agentSeat(tier, seed);
  },
};

export default chessStockfish;
