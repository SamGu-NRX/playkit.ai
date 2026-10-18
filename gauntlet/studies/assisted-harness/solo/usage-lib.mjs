/**
 * Provider-call accounting for the assisted-harness solo study
 * (`compute-stats.mjs`), extracted so the arithmetic is unit-testable.
 *
 * One agent step is one TURN, but the assisted harness may have spent several
 * provider CALLS on it: a step that retried records the retry count in
 * `reply.meta.assisted.attempts` and aggregates every attempt's token usage
 * and elapsed wall time into that single recorded step. Per-call metrics must
 * therefore divide by attempts, not turns — `secPerCall` and `tokensPerCall`
 * were previously per-TURN, understating both by the retry factor on exactly
 * the episodes where the harness worked hardest (review finding, PR #97).
 *
 * `invalidReplyRate` counts rejected PROVIDER attempts against the provider
 * attempts denominator. Earlier this rate stayed per-turn for lack of a
 * per-attempt numerator; PR #117's wrapper now records how many of a step's
 * attempts were rejected in `reply.meta.assisted.invalidAttempts`, so the
 * numerator and the denominator share units. Trajectories written before that
 * field fall back to the recorded per-step invalid flag, whose count equals
 * the old per-turn numerator on data that never carried the meta.
 *
 * @module
 */

/** Shared rounding: 6 decimal places, null for non-finite input. */
export const round6 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6);

/**
 * Provider attempts behind one agent step: the harness's recorded retry count
 * when present, otherwise 1 (unassisted steps and single-attempt assisted
 * steps are one call each).
 *
 * @param {{ reply?: { meta?: { assisted?: { attempts?: number } } } } | null | undefined} step
 * @returns {number}
 */
export function stepAttempts(step) {
  const attempts = step?.reply?.meta?.assisted?.attempts;
  return Number.isFinite(attempts) && attempts >= 1 ? attempts : 1;
}

/**
 * Rejected provider attempts behind one agent step: the wrapper's recorded
 * `reply.meta.assisted.invalidAttempts` count when present (attempts rejected
 * before the successful one; every attempt on exhaustion), otherwise the
 * recorded invalid flag for legacy trajectories and unassisted steps.
 *
 * @param {{ invalid?: boolean, reply?: { meta?: { assisted?: { invalidAttempts?: number } } } } | null | undefined} step
 * @returns {number}
 */
function stepInvalidAttempts(step) {
  const rejected = step?.reply?.meta?.assisted?.invalidAttempts;
  if (typeof rejected === 'number' && rejected >= 0) return rejected;
  return step?.invalid ? 1 : 0;
}

/**
 * Usage summary over a trajectory's agent steps: `calls` is the turn count,
 * `attempts` the provider-call count behind those turns, and `invalid` the
 * rejected-attempt count (see module doc).
 *
 * @param {{ steps: { by: string, invalid?: boolean, ms?: number, usage?: { promptTokens?: number | null, inputTokens?: number | null, completionTokens?: number | null, outputTokens?: number | null } | null, reply?: { meta?: { assisted?: { attempts?: number, invalidAttempts?: number } } } }[] }} trajectory
 * @returns {{ calls: number, attempts: number, invalid: number, ms: number, tokIn: number, tokOut: number }}
 */
export function usageOf(trajectory) {
  const agentSteps = trajectory.steps.filter((s) => s.by === 'agent');
  const usage = agentSteps.map((s) => s.usage).filter(Boolean);
  return {
    calls: agentSteps.length,
    attempts: agentSteps.reduce((a, s) => a + stepAttempts(s), 0),
    invalid: agentSteps.reduce((a, s) => a + stepInvalidAttempts(s), 0),
    ms: agentSteps.reduce((a, s) => a + (s.ms || 0), 0),
    tokIn: usage.reduce((a, u) => a + (u.promptTokens ?? u.inputTokens ?? 0), 0),
    tokOut: usage.reduce((a, u) => a + (u.completionTokens ?? u.outputTokens ?? 0), 0),
  };
}

/**
 * The per-call metric block, from usage summed over a model's episodes. All
 * three rates divide by provider attempts: `secPerCall`/`tokensPerCall`
 * (review finding, PR #97) and `invalidReplyRate`, whose per-attempt numerator
 * arrived with the wrapper's invalidAttempts recording (PR #117).
 *
 * @param {{ invalid: number, ms: number, tokIn: number, tokOut: number, calls: number, attempts: number }} usage
 */
export function aggregateRates({ invalid, ms, tokIn, tokOut, calls, attempts }) {
  const providerCalls = attempts || calls || 1;
  return {
    invalidReplyRate: round6(invalid / providerCalls),
    secPerCall: round6(ms / 1000 / providerCalls),
    tokensPerCall: round6((tokIn + tokOut) / providerCalls),
  };
}
