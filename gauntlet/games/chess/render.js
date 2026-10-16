/**
 * Observation rendering for chess: a labelled ASCII board (ranks 8..1, files
 * a-h), side to move, move history, opening name, and the legal-move list.
 * Chess is perfect information, so the observation carries the full position;
 * nothing outside the mover's knowledge is ever shown.
 *
 * No `node:*` imports.
 *
 * @module
 */

import { internals } from './engine.js';

/** @import { Chess } from 'chess.js' */

/**
 * The state fields the renderer reads (a subset of the game state).
 *
 * @typedef {object} RenderState
 * @property {string[]} san SAN move history.
 * @property {string | null} openingName
 * @property {number} openingPlies
 */

/** @type {Record<string, string>} Lowercase glyph per piece type. */
const PIECE_GLYPHS = {
  p: 'p',
  n: 'n',
  b: 'b',
  r: 'r',
  q: 'q',
  k: 'k',
};

/**
 * Render the labelled board. Uppercase = white, lowercase = black.
 *
 * @param {Chess} chess
 * @returns {string}
 */
export function renderBoard(chess) {
  const board = internals(chess)._board;
  /** @type {string[]} */
  const rows = [];
  rows.push('    a b c d e f g h');
  rows.push('  +-----------------+');
  for (let rank = 8; rank >= 1; rank--) {
    const cells = [];
    for (let file = 0; file < 8; file++) {
      // 0x88: a8 = 0, so square = (8 - rank) * 16 + file.
      const piece = board[(8 - rank) * 16 + file];
      if (!piece) {
        cells.push('.');
      } else {
        const glyph = PIECE_GLYPHS[piece.type] ?? '?';
        cells.push(piece.color === 'w' ? glyph.toUpperCase() : glyph);
      }
    }
    rows.push(`${rank} | ${cells.join(' ')} |`);
  }
  rows.push('  +-----------------+');
  return rows.join('\n');
}

/**
 * Render the move history as "1. e4 e5 2. Nf3 ...".
 *
 * @param {string[]} san
 * @returns {string}
 */
export function renderMoves(san) {
  if (san.length === 0) return 'none';
  const parts = [];
  for (let i = 0; i < san.length; i += 2) {
    const number = i / 2 + 1;
    parts.push(`${number}. ${san[i]}${san[i + 1] ? ` ${san[i + 1]}` : ''}`);
  }
  return parts.join(' ');
}

/**
 * The full observation text.
 *
 * @param {Chess} chess Position matching the state.
 * @param {RenderState} state
 * @param {number} seat Acting seat (0 white, 1 black).
 * @param {string[]} legal Sorted legal UCI actions for the acting seat.
 * @returns {string}
 */
export function renderObservation(chess, state, seat, legal) {
  const turn = chess.turn();
  const mover = turn === 'w' ? 'white' : 'black';
  const you = seat === 0 ? 'white' : 'black';
  const lines = [
    `Chess. You are seat ${seat} (${you}, ${seat === 0 ? 'uppercase' : 'lowercase'} pieces).`,
    renderBoard(chess),
    `Side to move: ${mover}${chess.isCheck() ? ', in check' : ''}`,
    `Moves: ${renderMoves(state.san)}`,
  ];
  if (state.openingPlies > 0 && state.openingName) {
    lines.push(`Opening: ${state.openingName} (${state.openingPlies} book plies played).`);
  }
  if (legal.length > 0) {
    lines.push(
      legal.length <= 64
        ? `Legal actions (${legal.length}, all listed): ${legal.join(', ')}`
        : `Legal actions: ${legal.length} (too many to list; use UCI like "e2e4").`
    );
  } else {
    lines.push('Legal actions: none (game over).');
  }
  return lines.join('\n');
}
