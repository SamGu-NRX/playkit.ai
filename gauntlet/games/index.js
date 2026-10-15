/**
 * The explicit Gauntlet game registry. Game packets register here; nothing is
 * auto-discovered, so a game ships only when it is deliberately listed.
 *
 * @module
 */

import tictactoe from './tictactoe/index.js';
import chess from './chess/index.js';

import sliding from './sliding/index.js';

/** @import { Game } from '../core/types.js' */

/** @type {Record<string, Game<*>>} */
export const GAMES = {
  tictactoe,
  chess,

  sliding,
};

/**
 * @returns {Game<*>[]}
 */
export function listGames() {
  return Object.values(GAMES);
}

/**
 * @param {string} id
 * @returns {Game<*>}
 * @throws {Error} when the id is not registered.
 */
export function getGame(id) {
  const game = GAMES[id];
  if (!game) {
    throw new Error(
      `unknown game "${id}" (registered: ${Object.keys(GAMES).join(', ') || 'none'})`
    );
  }
  return game;
}
