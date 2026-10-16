/**
 * The fault-check copy of the vendored 2048 game.
 *
 * The fixture served at `/2048-faulty/` is byte-identical to the vendored
 * game at `vendor/2048/` (pin in `vendor/PIN.md`) except for exactly one line
 * in `js/game_manager.js`, applied by `patchGameManagerSource` when the local
 * server serves the file. The dropped `!next.mergedFrom` guard lets a tile
 * that was just created by a merge merge *again* in the same move, so lines
 * of three or more equal tiles cascade ([2,2,2] slides left to [8] where the
 * rules produce [4,2]). That is the deviation class the referee must flag:
 * "the page changed cells the slide had already settled" or an unexplained
 * board, on the first offending move.
 *
 * Keeping the patch as this one visible replacement (instead of committing a
 * full second copy of the vendored tree) makes the exact deviation reviewable
 * in the PR diff.
 *
 * @module
 */

/** The exact source line in the vendored `js/game_manager.js` (pin in `vendor/PIN.md`). */
const PRISTINE_LINE = "if (next && next.value === tile.value && !next.mergedFrom) {";

/** The same merge condition with the once-per-move guard removed. */
const PATCHED_LINE = "if (next && next.value === tile.value) {";

/**
 * Apply the double-merge patch to a copy of the vendored game manager source.
 *
 * @param {string} source The pristine vendored `js/game_manager.js` source.
 * @returns {string} The patched source (a tile may merge twice in one move).
 */
export function patchGameManagerSource(source) {
  if (!source.includes(PRISTINE_LINE)) {
    throw new Error(
      "faulty-copy: the vendored js/game_manager.js does not contain the expected merge line; " +
        "the vendored pin changed and the faulty-copy patch needs revisiting",
    );
  }
  return source.replace(PRISTINE_LINE, PATCHED_LINE);
}

export {};
