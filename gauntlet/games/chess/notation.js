/**
 * Action parsing for chess: accepts UCI (with or without an `=` before the
 * promotion piece) and SAN (with or without +/#/?/! decorations, wrapping
 * quotes stripped). Canonical output is UCI. Runs on the public chess.js API
 * — this is a boundary, not a search hot path.
 *
 * No `node:*` imports.
 *
 * @module
 */

import { internals, legalUcis } from './engine.js';

/** @import { Chess } from 'chess.js' */
/** @import { ParseResult } from '../../core/types.js' */

/**
 * The notation.js parse result: `{ ok: true, uci }` or `{ ok: false, error }`.
 *
 * @typedef {object} NotationOk
 * @property {true} ok
 * @property {string} uci Canonical UCI action.
 * @typedef {object} NotationError
 * @property {false} ok
 * @property {string} error
 * @typedef {NotationOk | NotationError} NotationResult
 */

const UCI_PATTERN = /^([a-h][1-8])([a-h][1-8])(?:=?([qrbnQRBN]))?$/;

/**
 * Strip wrapping quotes/backticks, a leading verb, and surrounding whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripDecorations(text) {
  let s = String(text).trim();
  for (let pass = 0; pass < 2; pass++) {
    if (
      s.length >= 2 &&
      ((s.startsWith('`') && s.endsWith('`')) ||
        (s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith("'") && s.endsWith("'")))
    ) {
      s = s.slice(1, -1).trim();
    }
  }
  s = s.replace(/^(move|play)\s+/i, '');
  return s.trim();
}

/**
 * Parse an action against a position. `chess` must hold the current position
 * and is left unchanged (SAN probing via chess.move() is always undone).
 *
 * @param {Chess} chess
 * @param {string} text
 * @returns {NotationResult}
 */
export function parseAction(chess, text) {
  const s = stripDecorations(text);
  if (s.length === 0) {
    return { ok: false, error: 'empty action' };
  }

  const uciMatch = UCI_PATTERN.exec(s);
  if (uciMatch) {
    const uci =
      uciMatch[1] + uciMatch[2] + (uciMatch[3] ? uciMatch[3].toLowerCase() : '');
    if (legalUcis(chess).includes(uci)) {
      return { ok: true, uci };
    }
    return {
      ok: false,
      error: `move "${s}" is not legal in the current position`,
    };
  }

  try {
    const move = chess.move(s);
    internals(chess)._undoMove();
    if (!move) {
      return { ok: false, error: `cannot parse "${s}" as a legal chess move` };
    }
    return { ok: true, uci: `${move.from}${move.to}${move.promotion ?? ''}` };
  } catch {
    return {
      ok: false,
      error: `cannot parse ${JSON.stringify(s)} as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O")`,
    };
  }
}

/**
 * Parse into the Gauntlet ParseResult shape: the canonical UCI string in
 * `action`, or a diagnostic error.
 *
 * @param {Chess} chess
 * @param {string} text
 * @returns {ParseResult}
 */
export function parseNotationAsAction(chess, text) {
  const parsed = parseAction(chess, text);
  if (!parsed.ok) return parsed;
  return { ok: true, action: parsed.uci };
}
