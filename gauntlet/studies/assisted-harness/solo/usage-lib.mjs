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
 * `invalidReplyRate` deliberately stays per-turn: its numerator counts
 * recorded steps the referee rejected, and an attempt that was retried away
 * never became a recorded step, so a per-attempt denominator would pair with
 * a numerator we do not have.
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
 * Usage summary over a trajectory's agent steps: `calls` is the turn count,
 * `attempts` the provider-call count behind those turns.
 *
 * @param {{ steps: { by: string, invalid?: boolean, ms?: number, usage?: { promptTokens?: number, inputTokens?: number, completionTokens?: number, outputTokens?: number } | null }[] }} trajectory
 */
export function usageOf(trajectory) {
  const agentSteps = trajectory.steps.filter((s) => s.by === 'agent');
  const usage = agentSteps.map((s) => s.usage).filter(Boolean);
  return {
    calls: agentSteps.length,
    attempts: agentSteps.reduce((a, s) => a + stepAttempts(s), 0),
    invalid: agentSteps.filter((s) => s.invalid).length,
    ms: agentSteps.reduce((a, s) => a + (s.ms || 0), 0),
    tokIn: usage.reduce((a, u) => a + (u.promptTokens ?? u.inputTokens ?? 0), 0),
    tokOut: usage.reduce((a, u) => a + (u.completionTokens ?? u.outputTokens ?? 0), 0),
  };
}

/**
 * The per-call metric block, from usage summed over a model's episodes.
 * `secPerCall`/`tokensPerCall` divide by provider attempts;
 * `invalidReplyRate` divides by turns (see module doc).
 *
 * @param {{ invalid: number, ms: number, tokIn: number, tokOut: number, calls: number, attempts: number }} usage
 */
export function aggregateRates({ invalid, ms, tokIn, tokOut, calls, attempts }) {
  const turns = calls || 1;
  const providerCalls = attempts || turns;
  return {
    invalidReplyRate: round6(invalid / turns),
    secPerCall: round6(ms / 1000 / providerCalls),
    tokensPerCall: round6((tokIn + tokOut) / providerCalls),
  };
}
