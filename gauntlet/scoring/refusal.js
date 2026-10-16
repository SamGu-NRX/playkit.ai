/**
 * A refusal: this input cannot be scored honestly. The message names the
 * file and the step that refused it. Shared by `score.js`,
 * `leaderboard.js` and `profiles.js` so every refusal in the scoring layer
 * carries the same shape.
 *
 * @module
 */

export class GauntletRefusalError extends Error {
  /**
   * @param {string} file Basename of the refusing file, e.g. "score.js".
   * @param {string} step The check that refused, e.g. "duplicate-episodes".
   * @param {string} message Human-readable detail.
   */
  constructor(file, step, message) {
    super(`[gauntlet/scoring/${file}] ${step}: ${message}`);
    this.name = 'GauntletRefusalError';
    /** @type {string} */
    this.file = `gauntlet/scoring/${file}`;
    /** @type {string} */
    this.step = step;
  }
}
