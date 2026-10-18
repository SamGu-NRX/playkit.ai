/**
 * Tests for the usage summary lib (usage-lib.mjs): the invalid-reply rate's
 * numerator counts wrapper-REJECTED provider attempts
 * (reply.meta.assisted.invalidAttempts) so it stays in per-attempt units like
 * the calls denominator, falling back to the step's recorded invalid flag for
 * legacy committed trajectories and unassisted steps.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { usageOf } from './usage-lib.mjs';

test('a retried-then-valid step contributes its rejected attempts, not its invalid flag', () => {
  // The failing case this pin exists for: a turn whose first attempt was
  // rejected by the wrapper and whose second attempt was legal records
  // invalid: false at the step level, but one provider reply WAS invalid.
  // The per-step invalid flag read 0 there while the calls denominator still
  // counted 2 attempts — the rate understated, often to 0 for runs that
  // retried.
  const trajectory = {
    steps: [
      {
        seat: 0,
        by: 'agent',
        observationHash: 'h1',
        action: 'up',
        invalid: false,
        usage: { inputTokens: 10, outputTokens: 5 },
        ms: 100,
        reply: {
          text: 'I like this position.\nACTION: up',
          meta: { assisted: { attempts: 2, retried: true, invalidAttempts: 1 } },
        },
      },
      {
        seat: 0,
        by: 'agent',
        observationHash: 'h2',
        action: 'left',
        invalid: true,
        usage: null,
        ms: 40,
        reply: { text: 'x' },
      },
    ],
  };
  const usage = usageOf(trajectory);
  assert.equal(usage.calls, 3, 'denominator: 2 assisted attempts + 1 unassisted call');
  assert.equal(
    usage.invalid,
    2,
    'numerator: 1 wrapper-rejected attempt + 1 legacy recorded-invalid step'
  );
});

test('assisted steps without invalidAttempts fall back to the recorded invalid flag', () => {
  // Legacy committed trajectories predate invalidAttempts; their assisted
  // steps keep the flag fallback (exhausted: the last attempt was also
  // rejected by the wrapper).
  const trajectory = {
    steps: [
      {
        seat: 0,
        by: 'agent',
        observationHash: 'h1',
        action: '',
        invalid: true,
        usage: { inputTokens: 3, outputTokens: 9 },
        ms: 60,
        reply: {
          text: 'nope 3',
          meta: { assisted: { attempts: 3, retried: true, exhausted: true } },
        },
      },
    ],
  };
  const usage = usageOf(trajectory);
  assert.equal(usage.calls, 3);
  assert.equal(usage.invalid, 1);
});

test('unassisted steps keep one call per step and the flag numerator', () => {
  const trajectory = {
    steps: [
      {
        seat: 0,
        by: 'agent',
        observationHash: 'h1',
        action: 'up',
        invalid: false,
        usage: { inputTokens: 1, outputTokens: 1 },
        ms: 10,
        reply: { text: 'ACTION: up' },
      },
      {
        seat: 0,
        by: 'agent',
        observationHash: 'h2',
        action: '',
        invalid: true,
        usage: { inputTokens: 1, outputTokens: 1 },
        ms: 10,
        reply: { text: 'zzz' },
      },
      {
        seat: 1,
        by: 'opponent',
        observationHash: 'h3',
        action: 'up',
        invalid: false,
        usage: null,
        ms: 5,
        reply: { text: 'ACTION: up' },
      },
    ],
  };
  const usage = usageOf(trajectory);
  assert.equal(usage.calls, 2, 'only agent steps count');
  assert.equal(usage.invalid, 1);
});
