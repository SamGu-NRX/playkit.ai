/**
 * Bundled baselines for chess-endgames. The `engine` plays tablebase-optimal
 * moves (always reducing the distance to mate) and must score 1.0 on every
 * public seed. The `greedy` baseline uses no tablebase: it mates in one when
 * it can and otherwise restricts the defending king's mobility, with seeded
 * tie-breaks.
 *
 * @module
 */

import { Chess } from 'chess.js';
import { GauntletRuleError } from '../../core/errors.js';
import { streamFromSeed } from '../../core/rng.js';
import { getTablebase, positionFromPlacement } from './tablebase.js';

/** @import { Agent, TierSpec, TurnContext } from '../../core/types.js' */

/**
 * @typedef {import('./index.js').ChessEndgameState} ChessEndgameState
 */

/**
 * The tablebase-optimal agent for seat 0: every move reduces the DTM of the
 * resulting position by exactly one, so the episode mates in exactly `par`
 * moves and scores 1.0.
 *
 * @param {TierSpec} tier
 * @param {string} seed
 * @returns {Agent}
 */
export function engineAgent(tier, seed) {
  return {
    id: 'tablebase-engine',
    track: 'baseline',
    /**
     * @param {TurnContext} ctx
     * @returns {Promise<{ text: string }>}
     */
    async act(ctx) {
      const data = /** @type {ChessEndgameState & { seat?: number }} */ (ctx.observation.data);
      const table = getTablebase(data.kind);
      const chess = new Chess(data.fen);
      const verbose = chess.moves({ verbose: true });
      if (verbose.length === 0) {
        throw new GauntletRuleError('tablebase engine found no legal move');
      }
      /** @type {{ m: import('chess.js').Move, d: number }[]} */
      const wins = [];
      for (const m of verbose) {
        chess.move({ from: m.from, to: m.to });
        const placement = chess.fen().split(' ')[0];
        const pos = positionFromPlacement(data.kind, placement, 1);
        const d = table.dtm(pos);
        chess.undo();
        if (d !== null) wins.push({ m, d });
      }
      const stream = streamFromSeed(`${tier.id}/${seed}/engine/turn${ctx.turn}`);
      if (wins.length === 0) {
        // Not expected from a winning start with optimal play; fall back to a
        // seeded legal move rather than crashing the episode.
        const pick = stream.nextInt(0, verbose.length - 1);
        return { text: verbose[pick].from + verbose[pick].to };
      }
      let best = Infinity;
      for (const w of wins) best = Math.min(best, w.d);
      const tied = wins.filter((w) => w.d === best);
      const pick = stream.nextInt(0, tied.length - 1);
      return { text: tied[pick].m.from + tied[pick].m.to };
    },
  };
}

/**
 * The greedy agent for seat 0: mate in one when available, otherwise the move
 * after which Black has the fewest legal replies (mobility restriction). No
 * tablebase involvement.
 *
 * @param {TierSpec} tier
 * @param {string} seed
 * @returns {Agent}
 */
export function greedyAgent(tier, seed) {
  return {
    id: 'greedy-mobility',
    track: 'baseline',
    /**
     * @param {TurnContext} ctx
     * @returns {Promise<{ text: string }>}
     */
    async act(ctx) {
      const data = /** @type {ChessEndgameState & { seat?: number }} */ (ctx.observation.data);
      const chess = new Chess(data.fen);
      const verbose = chess.moves({ verbose: true });
      if (verbose.length === 0) {
        throw new GauntletRuleError('greedy baseline found no legal move');
      }
      /** @type {import('chess.js').Move[]} */
      const mates = [];
      /** @type {{ m: import('chess.js').Move, replies: number }[]} */
      const scored = [];
      for (const m of verbose) {
        chess.move({ from: m.from, to: m.to });
        if (chess.isCheckmate()) {
          mates.push(m);
        } else if (!chess.isGameOver()) {
          scored.push({ m, replies: chess.moves().length });
        }
        chess.undo();
      }
      const stream = streamFromSeed(`${tier.id}/${seed}/greedy/turn${ctx.turn}`);
      if (mates.length > 0) {
        const pick = stream.nextInt(0, mates.length - 1);
        return { text: mates[pick].from + mates[pick].to };
      }
      if (scored.length === 0) {
        const pick = stream.nextInt(0, verbose.length - 1);
        return { text: verbose[pick].from + verbose[pick].to };
      }
      let best = Infinity;
      for (const s of scored) best = Math.min(best, s.replies);
      const tied = scored.filter((s) => s.replies === best);
      const pick = stream.nextInt(0, tied.length - 1);
      return { text: tied[pick].m.from + tied[pick].m.to };
    },
  };
}

/**
 * @param {TierSpec} tier
 * @param {string} seed
 * @param {number} seat
 * @returns {Agent}
 */
export function engineFor(tier, seed, seat) {
  if (seat !== 0) throw new Error('chess-endgames baselines play seat 0 only');
  return engineAgent(tier, seed);
}

/**
 * @param {TierSpec} tier
 * @param {string} seed
 * @param {number} seat
 * @returns {Agent}
 */
export function greedyFor(tier, seed, seat) {
  if (seat !== 0) throw new Error('chess-endgames baselines play seat 0 only');
  return greedyAgent(tier, seed);
}
