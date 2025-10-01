/**
 * @fileoverview Base adapter interface for 2048-like game detection and interaction
 * Follows the steering contract for game detection patterns
 */

/**
 * Direction constants for move execution
 * @readonly
 * @enum {number}
 */
export const Direction = {
  UP: 0,
  RIGHT: 1,
  DOWN: 2,
  LEFT: 3,
};

/**
 * Base adapter interface for different 2048 game implementations.
 * Each adapter handles site-specific DOM patterns and input methods.
 *
 * @interface
 */
export class Adapter {
  /**
   * Quick check if this adapter can handle the current page
   * @returns {boolean} True if adapter can attach to current page
   */
  canAttach() {
    throw new Error("canAttach() must be implemented by subclass");
  }

  /**
   * Extract current game state as 4x4 number matrix (0 = empty)
   * @returns {number[][]|null} 4x4 matrix or null if extraction fails
   */
  readBoard() {
    throw new Error("readBoard() must be implemented by subclass");
  }

  /**
   * Send move command to the game
   * @param {0|1|2|3} dir Direction (0=Up, 1=Right, 2=Down, 3=Left)
   */
  sendMove(dir) {
    throw new Error("sendMove() must be implemented by subclass");
  }

  /**
   * Get current game score (optional)
   * @returns {number|null} Current score or null if not available
   */
  getScore() {
    return null;
  }

  /**
   * Check if game is over (optional)
   * @returns {boolean} True if game is over
   */
  isGameOver() {
    return false;
  }

  /**
   * Get adapter name for debugging
   * @returns {string} Adapter name
   */
  getName() {
    return this.constructor.name;
  }
}

/**
 * Utility functions for board manipulation
 */
export const BoardUtils = {
  /**
   * Create empty 4x4 board
   * @returns {number[][]} Empty 4x4 matrix
   */
  createEmptyBoard() {
    return Array.from({ length: 4 }, () => Array(4).fill(0));
  },

  /**
   * Calculate simple hash of board state for change detection
   * @param {number[][]} board 4x4 board matrix
   * @returns {string} Hash string
   */
  hashBoard(board) {
    if (!board || !Array.isArray(board)) return "";
    return board.flat().join(",");
  },

  /**
   * Check if board is valid 4x4 matrix
   * @param {any} board Board to validate
   * @returns {boolean} True if valid
   */
  isValidBoard(board) {
    return (
      Array.isArray(board) &&
      board.length === 4 &&
      board.every((row) => Array.isArray(row) && row.length === 4)
    );
  },

  /**
   * Parse tile value from text content
   * @param {string} text Text content from tile element
   * @returns {number} Parsed tile value or 0 if invalid
   */
  parseTileValue(text) {
    if (!text || typeof text !== "string") return 0;
    const trimmed = text.trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) return 0;
    const value = parseInt(trimmed, 10);
    return Math.min(value, 65536); // Cap at reasonable max (2^16)
  },
};
