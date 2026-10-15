/**
 * Synthetic outcomes the runner issues when an episode ends outside the
 * game's own rules. Shared by the runner and trajectory verification so both
 * construct identical objects.
 *
 * @module
 */

/**
 * The agent forfeited (too many consecutive invalid attempts): it scores 0,
 * every other seat scores 1.
 *
 * @param {number} seats
 * @param {number} agentSeat
 * @returns {import('./types.js').Outcome}
 */
export function forfeitOutcome(seats, agentSeat) {
  return {
    normalized: Array.from({ length: seats }, (_, seat) => (seat === agentSeat ? 0 : 1)),
    raw: null,
    reason: 'forfeit-invalid',
    solved: false,
    par: null,
  };
}

/**
 * The budget ran out on an efficiency tier: unsolved, zero score everywhere.
 *
 * @param {number} seats
 * @returns {import('./types.js').Outcome}
 */
export function unsolvedOutcome(seats) {
  return {
    normalized: new Array(seats).fill(0),
    raw: null,
    reason: 'budget-exhausted',
    solved: false,
    par: null,
  };
}
