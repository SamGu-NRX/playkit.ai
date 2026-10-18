/**
 * Usage summary over a run bundle's trajectories, shared by the solo study's
 * statistics script (compute-stats.mjs). Pure functions over the committed
 * trajectory JSON: no imports, no I/O.
 *
 * @module
 */

/**
 * Usage summary over a trajectory's agent steps.
 *
 * @param {{ steps: Array<{ by: string, invalid: boolean, usage?: { promptTokens?: number | null, inputTokens?: number | null, completionTokens?: number | null, outputTokens?: number | null } | null, ms?: number, reply?: { meta?: { assisted?: { attempts?: number, invalidAttempts?: number } } } }> }} trajectory
 * @returns {{ calls: number, invalid: number, ms: number, tokIn: number, tokOut: number }}
 */
export function usageOf(trajectory) {
  const agentSteps = trajectory.steps.filter((s) => s.by === 'agent');
  const usage = agentSteps.map((s) => s.usage).filter(Boolean);
  return {
    // Provider-call count, not turn count: an assisted step can carry up to
    // three provider attempts (retries included) and its usage/ms already
    // sum all of them, so secPerCall / tokensPerCall must divide by attempts
    // to stay comparable with the unassisted arm. Steps without the assisted
    // meta (a plain unassisted run) are one call each.
    calls: agentSteps.reduce(
      (a, s) => a + (s.reply?.meta?.assisted?.attempts ?? 1),
      0
    ),
    // Rejected replies, not rejected steps: the numerator counts the same
    // unit as the denominator — provider calls. A retried-then-valid step
    // contributes its wrapper-rejected attempts (meta.assisted
    // .invalidAttempts), which the per-step invalid flag undercounts by
    // exactly the retries that succeeded (the rate read 0 for runs that
    // retried). Legacy trajectories without the field fall back to the
    // flag; unassisted steps never retry.
    invalid: agentSteps.reduce(
      (a, s) =>
        a +
        (typeof s.reply?.meta?.assisted?.invalidAttempts === 'number'
          ? s.reply.meta.assisted.invalidAttempts
          : s.invalid
            ? 1
            : 0),
      0
    ),
    ms: agentSteps.reduce((a, s) => a + (s.ms || 0), 0),
    tokIn: usage.reduce((a, u) => a + (u.promptTokens ?? u.inputTokens ?? 0), 0),
    tokOut: usage.reduce((a, u) => a + (u.completionTokens ?? u.outputTokens ?? 0), 0),
  };
}
