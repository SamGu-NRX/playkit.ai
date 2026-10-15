/**
 * Gauntlet's one error type for rule violations. Games throw it from `step`
 * (and optionally `parseAction`) for any action not in `legalActions`; the
 * runner and conformance kit detect it by name.
 */
export class GauntletRuleError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GauntletRuleError';
  }
}
