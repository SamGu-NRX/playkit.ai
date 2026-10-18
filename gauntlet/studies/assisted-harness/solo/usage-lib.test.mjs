/**
 * Unit tests for the assisted-harness accounting (`usage-lib.mjs`).
 *
 * Pins the per-call correction (PR #97): an assisted step that retried
 * aggregates every provider attempt's wall time and tokens into ONE recorded
 * step, so `secPerCall`/`tokensPerCall` divide by attempts
 * (reply.meta.assisted.attempts), not turns. Pins the per-attempt invalid
 * numerator (PR #117): `invalidReplyRate` counts rejected provider attempts
 * (reply.meta.assisted.invalidAttempts, with the recorded per-step invalid
 * flag as the legacy fallback) against the same attempts denominator.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRates, stepAttempts, usageOf } from './usage-lib.mjs';

/** Build a minimal agent step. */
function step({ invalid = false, ms = 1000, attempts = null, invalidAttempts = null, input = 100, output = 10 } = {}) {
  return {
    by: 'agent',
    invalid,
    ms,
    usage: { inputTokens: input, outputTokens: output },
    ...(attempts === null && invalidAttempts === null
      ? {}
      : {
          reply: {
            meta: {
              assisted: {
                ...(attempts === null ? {} : { attempts, retried: attempts > 1, exhausted: false }),
                ...(invalidAttempts === null ? {} : { invalidAttempts }),
              },
            },
          },
        }),
  };
}

const noRetry = { steps: [step(), step({ invalid: true }), step({ ms: 3000, input: 200, output: 30 })] };

test('without retries, attempts equal turns and the rates match the old per-turn formulas', () => {
  const u = usageOf(noRetry);
  assert.equal(u.calls, 3);
  assert.equal(u.attempts, 3);
  assert.equal(u.invalid, 1);
  assert.equal(u.ms, 5000);
  assert.equal(u.tokIn, 400);
  assert.equal(u.tokOut, 50);
  const rates = aggregateRates(u);
  // Old code: invalid/calls, ms/1000/calls, tokens/calls with calls = turns
  // (round6 to 6 dp, as the old inline round6 calls did). Identical here
  // because a no-retry bundle has attempts == turns.
  assert.equal(rates.invalidReplyRate, 0.333333);
  assert.equal(rates.secPerCall, 1.666667);
  assert.equal(rates.tokensPerCall, 150);
});

test('retried steps divide per-call metrics by provider attempts, not turns', () => {
  // 2 turns, one of which consumed 3 provider calls (like the committed
  // 0.5B mastermind episodes: attempts 3, exhausted).
  const t = { steps: [step({ attempts: 3, ms: 9000, input: 900, output: 30 }), step({ ms: 1000 })] };
  const u = usageOf(t);
  assert.equal(u.calls, 2);
  assert.equal(u.attempts, 4);
  const rates = aggregateRates(u);
  assert.equal(rates.secPerCall, 2.5); // 10000 ms / 4 calls, not /2 turns
  assert.equal(rates.tokensPerCall, 260); // 1040 tokens / 4 calls, not /2 turns
  // No provider reply was rejected (both flags false, no invalidAttempts
  // meta), so the per-attempt invalid rate is 0 here.
  assert.equal(rates.invalidReplyRate, 0);
});

test('missing or degenerate attempt metadata falls back to one call per step', () => {
  assert.equal(stepAttempts(step()), 1);
  assert.equal(stepAttempts(step({ attempts: 0 })), 1);
  assert.equal(stepAttempts({ by: 'agent' }), 1);
  assert.equal(stepAttempts(null), 1);
});

test('aggregate guards zero denominators like the old `|| 1` fallbacks', () => {
  const rates = aggregateRates({ invalid: 0, ms: 0, tokIn: 0, tokOut: 0, calls: 0, attempts: 0 });
  assert.deepEqual(rates, { invalidReplyRate: 0, secPerCall: 0, tokensPerCall: 0 });
});

test('a retried-then-valid step contributes its rejected attempts, not its invalid flag', () => {
  // PR #117 P2 pin: a turn whose first attempt was rejected by the wrapper
  // and whose second attempt was legal records invalid: false at the step
  // level, but one provider reply WAS invalid. The per-step invalid flag read
  // 0 there while the attempts denominator still counted 2 — the rate
  // understated, often to 0 for runs that retried.
  const t = {
    steps: [
      step({ invalid: false, ms: 100, input: 10, output: 5, attempts: 2, invalidAttempts: 1 }),
      step({ invalid: true, ms: 40, input: 0, output: 0 }), // legacy recorded-invalid step
    ],
  };
  const u = usageOf(t);
  assert.equal(u.calls, 2, 'turns');
  assert.equal(u.attempts, 3, '2 assisted attempts + 1 unassisted call');
  assert.equal(u.invalid, 2, '1 wrapper-rejected attempt + 1 legacy recorded-invalid step');
  const rates = aggregateRates(u);
  assert.equal(rates.invalidReplyRate, 0.666667, 'rejected attempts / provider attempts');
});

test('assisted steps without invalidAttempts fall back to the recorded invalid flag', () => {
  // Legacy committed trajectories predate invalidAttempts; their exhausted
  // assisted steps keep the flag fallback — the numerator counts the recorded
  // step once while the denominator stays provider attempts (PR #117).
  const t = { steps: [step({ invalid: true, ms: 60, input: 3, output: 9, attempts: 3 })] };
  const u = usageOf(t);
  assert.equal(u.calls, 1);
  assert.equal(u.attempts, 3);
  assert.equal(u.invalid, 1);
  assert.equal(aggregateRates(u).invalidReplyRate, 0.333333, '1 rejected recorded step / 3 attempts');
});

test('an exhausted step carrying the wrapper meta counts every rejected attempt', () => {
  // New trajectories: on exhaustion the wrapper records invalidAttempts = all
  // attempts, so the rate reaches 1 only when every provider call was
  // rejected.
  const t = { steps: [step({ invalid: true, ms: 120, input: 30, output: 0, attempts: 3, invalidAttempts: 3 })] };
  const u = usageOf(t);
  assert.equal(u.calls, 1);
  assert.equal(u.attempts, 3);
  assert.equal(u.invalid, 3);
  assert.equal(aggregateRates(u).invalidReplyRate, 1);
});

test('unassisted steps keep one call per step and the flag numerator', () => {
  const t = {
    steps: [
      { by: 'agent', invalid: false, ms: 10, usage: { inputTokens: 1, outputTokens: 1 }, reply: { text: 'ACTION: up' } },
      { by: 'agent', invalid: true, ms: 10, usage: { inputTokens: 1, outputTokens: 1 }, reply: { text: 'zzz' } },
      { by: 'opponent', invalid: false, ms: 5, usage: null, reply: { text: 'ACTION: up' } },
    ],
  };
  const u = usageOf(t);
  assert.equal(u.calls, 2, 'only agent steps count');
  assert.equal(u.attempts, 2);
  assert.equal(u.invalid, 1);
  assert.equal(aggregateRates(u).invalidReplyRate, 0.5);
});
