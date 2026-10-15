/**
 * Node-only seed helpers for the hidden eval split. Import from `node:crypto`
 * — this module must never be loaded in the browser.
 *
 * Eval seed i for a tier is `<game>/<tier>/eval/` followed by the first 16 hex
 * digits of HMAC-SHA256(salt, `<game>/<tier>/<i>`). The salt is never
 * committed or recorded: only `saltCommitment(salt)` (its SHA-256 hex) is
 * published, which lets a later auditor confirm the same salt was used
 * without learning it.
 *
 * @module
 */

import { createHash, createHmac } from 'node:crypto';

/**
 * @param {string} gameId
 * @param {string} tierId
 * @param {number} index
 * @param {string} salt Secret; never committed.
 * @returns {string} The full eval seed string.
 */
export function evalSeed(gameId, tierId, index, salt) {
  const mac = createHmac('sha256', salt)
    .update(`${gameId}/${tierId}/${index}`)
    .digest('hex');
  return `${gameId}/${tierId}/eval/${mac.slice(0, 16)}`;
}

/**
 * @param {string} salt
 * @returns {string} SHA-256 of the salt, lowercase hex (64 digits).
 */
export function saltCommitment(salt) {
  return createHash('sha256').update(salt).digest('hex');
}
