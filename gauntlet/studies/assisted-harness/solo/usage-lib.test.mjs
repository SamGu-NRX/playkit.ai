/**
 * Unit tests for the assisted-harness accounting (`usage-lib.mjs`).
 *
 * Pins the per-call correction: an assisted step that retried aggregates
 * every provider attempt's wall time and tokens into ONE recorded step, so
 * `secPerCall`/`tokensPerCall` divide by attempts (reply.meta.assisted.attempts),
 * not turns — while `invalidReplyRate` stays per-turn because its numerator
 * only counts recorded steps (review finding, PR #97).
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRates, stepAttempts, usageOf } from './usage-lib.mjs';

/** Build a minimal agent step. */
function step({ invalid = false, ms = 1000, attempts = null, input = 100, output = 10 } = {}) {
  return {
    by: 'agent',
    invalid,
    ms,
    usage: { inputTokens: input, outputTokens: output },
    ...(attempts === null ? {} : { reply: { meta: { assisted: { attempts, retried: attempts > 1, exhausted: false } } } }),
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
  // (round6 to 6 dp, as the old inline round6 calls did).
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
  // Turn denominator kept: numerator counts recorded steps only.
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
