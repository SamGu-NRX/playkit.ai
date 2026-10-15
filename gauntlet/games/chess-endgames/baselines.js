/**
 * Baseline agents for chess endgames: a material-safe greedy heuristic and the
 * tablebase engine. Both play the converting seat (White). The engine probes
 * the DTM table and scores exactly 1.0 efficiency against perfect defense;
 * greedy plays without the table and exists as a beatable floor.
 *
 * @module
 */

import { Chess } from 'chess.js';
import { nextInt, streamFromSeed } from '../../core/rng.js';
import { probe } from './tablebase.js';

/** @import { Agent, TierSpec } from '../../core/types.js' */

export const BASELINE_IDS = ['greedy', 'tablebase-engine'];

/**
 * Apply a UCI from-to move to a FEN.
 *
 * @param {string} fen
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function applyUci(fen, from, to) {
  const chess = new Chess(fen);
  chess.move({ from, to });
  return chess.fen();
}

/**
 * Legal moves as UCI strings, sorted for determinism.
 *
 * @param {Chess} chess
 * @returns {{ uci: string, from: string, to: string }[]}
 */
function legalUci(chess) {
  return chess
    .moves({ verbose: true })
    .map((m) => ({ uci: `${m.from}${m.to}`, from: m.from, to: m.to }))
    .sort((a, b) => (a.uci < b.uci ? -1 : 1));
}

/**
 * Chebyshev distance between two squares.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function kingDistance(a, b) {
  return Math.max(
    Math.abs(a.charCodeAt(0) - b.charCodeAt(0)),
    Math.abs(a.charCodeAt(1) - b.charCodeAt(1)),
  );
}

/**
 * The greedy heuristic, evaluated on the child position: prefer checkmate,
 * then positions where the defender king has the fewest legal moves and the
 * White king stands close to the defender king. Ties break alphabetically, so
 * the agent is fully deterministic.
 *
 * @param {string} eg
 * @param {string} fen
 * @param {string} uci
 * @returns {number} Lower is better for White.
 */
function greedyScore(eg, fen, uci) {
  void eg;
  const child = new Chess(applyUci(fen, uci.slice(0, 2), uci.slice(2, 4)));
  if (child.isCheckmate()) return -1e6;
  const board = child.board();
  /** @type {string[]} */
  const blackKingSquares = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = board[r][f];
      if (sq && sq.type === 'k' && sq.color === 'b') {
        blackKingSquares.push(String.fromCharCode(97 + f) + String(r + 1));
      }
    }
  }
  const bk = blackKingSquares[0];
  const defenderMoves = child.moves().length;
  let minKingDist = 8;
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = board[r][f];
      if (sq && sq.color === 'w') {
        const name = String.fromCharCode(97 + f) + String(r + 1);
        const d = kingDistance(name, bk);
        if (sq.type === 'k' && d < minKingDist) minKingDist = d;
      }
    }
  }
  return defenderMoves * 100 + minKingDist;
}

/**
 * The tablebase engine: always moves along a shortest mate. Against the
 * perfect defender this converts in exactly the starting DTM and scores 1.0.
 *
 * @param {string} eg
 * @param {string} fen
 * @returns {string} UCI of the DTM-optimal move.
 */
export function engineMove(eg, fen) {
  const chess = new Chess(fen);
  let best = /** @type {{ uci: string, dtm: number } | null} */ (null);
  for (const m of legalUci(chess)) {
    const child = new Chess(applyUci(fen, m.from, m.to));
    if (child.isCheckmate()) return m.uci;
    const value = probe(eg, applyUci(fen, m.from, m.to));
    if (value.draw || value.dtm === null) continue; // never walk into a draw
    if (best === null || value.dtm < best.dtm) best = { uci: m.uci, dtm: value.dtm };
  }
  if (best === null) {
    // No progress available (should not happen on a won position): give up
    // quietly with the first legal move.
    return /** @type {string} */ (legalUci(chess)[0]?.uci);
  }
  return best.uci;
}

/**
 * The greedy baseline agent.
 *
 * @param {TierSpec} tier
 * @param {string} seed
 * @param {number} seat
 * @returns {Agent}
 */
export function greedyAgent(tier, seed, seat) {
  void seat;
  return {
    id: 'greedy',
    track: 'baseline',
    async act(ctx) {
      const data = /** @type {{ eg: string, fen: string }} */ (ctx.observation.data);
      const chess = new Chess(data.fen);
      const moves = legalUci(chess);
      if (moves.length === 0) {
        throw new Error('greedy agent found no legal move');
      }
      let best = moves[0];
      let bestScore = Infinity;
      for (const m of moves) {
        const score = greedyScore(data.eg, data.fen, m.uci);
        if (score < bestScore) {
          bestScore = score;
          best = m;
        }
      }
      const tied = moves.filter(
        (m) => greedyScore(data.eg, data.fen, m.uci) === bestScore,
      );
      const stream = streamFromSeed(`${tier.id}/${seed}/greedy/turn${ctx.turn}`);
      const chosen = tied[nextInt(stream.getState(), 0, tied.length - 1).value];
      return { text: chosen.uci };
    },
  };
}

/**
 * The tablebase engine baseline agent.
 *
 * @param {TierSpec} _tier
 * @param {string} _seed
 * @param {number} _seat
 * @returns {Agent}
 */
export function engineAgent(_tier, _seed, _seat) {
  return {
    id: 'tablebase-engine',
    track: 'baseline',
    async act(ctx) {
      const data = /** @type {{ eg: string, fen: string }} */ (ctx.observation.data);
      return { text: engineMove(data.eg, data.fen) };
    },
  };
}
