/**
 * The explicit Gauntlet game registry. Game packets register here; nothing is
 * auto-discovered, so a game ships only when it is deliberately listed.
 *
 * @module
 */

import tictactoe from './tictactoe/index.js';
import chess from './chess/index.js';
import chessEndgames from './chess-endgames/index.js';
import chessStockfish from './chess-stockfish/index.js';
import chessPuzzles from './chess-puzzles/index.js';
import minesweeper from './minesweeper/index.js';
import nonogram from './nonogram/index.js';
import sudoku from './sudoku/index.js';
import othello from './othello/index.js';
import wordle from './wordle/index.js';
import twoZeroFourEight from './2048/index.js';
import sliding from './sliding/index.js';
import sokoban from './sokoban/index.js';
import connect4 from './connect4/index.js';
import mastermind from './mastermind/index.js';
import holdem from './holdem/index.js';
import cube from './cube/index.js';

/** @import { Game } from '../core/types.js' */

/** @type {Record<string, Game<*>>} */
export const GAMES = {
  tictactoe,
  chess,
  'chess-endgames': chessEndgames,
  'chess-stockfish': chessStockfish,
  'chess-puzzles': chessPuzzles,
  'cube': cube,
  minesweeper,
  '2048': twoZeroFourEight,
  sliding,
  sokoban,
  connect4,
  mastermind,
  holdem,
  nonogram,
  sudoku,
  othello,
  wordle,
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
