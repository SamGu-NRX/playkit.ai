/**
 * Seed string formats. Public seeds are pure string formatting (no `node:*`);
 * eval seeds need HMAC, so they live in `seeds-node.js`.
 *
 * Public seed i for a tier is `<game>/<tier>/public/<i>`. These are the only
 * seeds agents may see; eval seeds are unlisted and salted.
 *
 * @module
 */

/**
 * @param {string} gameId
 * @param {string} tierId
 * @param {number} index
 * @returns {string}
 */
export function publicSeed(gameId, tierId, index) {
  return `${gameId}/${tierId}/public/${index}`;
}
