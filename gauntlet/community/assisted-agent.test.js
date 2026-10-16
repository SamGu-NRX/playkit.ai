/**
 * Tests for the community-track assisted agent. Each test names behavior that
 * fails before this packet: the wrapper does not exist at the base commit, so
 * every case here is red before the change and green after.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAssistedAgent } from './assisted-agent.js';

/** @import { Agent, TurnContext } from '../core/types.js' */

/**
 * A stub inner agent: records the contexts it was called with and replays a
 * fixed list of replies (text or full reply objects).
 * @param {Array<string | { text: string, usage?: *, meta?: * }>} replies
 * @returns {Agent & { calls: TurnContext[] }}
 */
function stubInner(replies) {
  const agent = {
    id: 'model:openai-chat/stub-model',
    track: /** @type {'official'} */ ('official'),
    model: 'stub-model',
    provider: 'openai-chat',
    /** @type {TurnContext[]} */
    calls: [],
    /** @param {TurnContext} ctx */
    async act(ctx) {
      agent.calls.push(ctx);
      const out = replies[agent.calls.length - 1];
      if (out === undefined) throw new Error('stub inner ran out of replies');
      return typeof out === 'string'
        ? { text: out, usage: { inputTokens: 1, outputTokens: 2, costUsd: null } }
        : /** @type {*} */ (out);
    },
  };
  return /** @type {*} */ (agent);
}

/** @returns {TurnContext} */
function legalCtx() {
  return {
    spec: /** @type {*} */ ({ id: 'stub', rulesText: 'Rules text here.', version: '1.0.0' }),
    tier: /** @type {*} */ ({ id: 'tier', maxActions: 10 }),
    seat: 0,
    turn: 0,
    observation: { text: 'The board.', data: null },
    legalActions: ['down', 'left', 'right', 'up'],
    feedback: null,
  };
}

test('the derived observation shows the legal actions and asks for a final ACTION line', async () => {
  const inner = stubInner(['ACTION: up']);
  const agent = createAssistedAgent({ inner });
  await agent.act(legalCtx());
  assert.equal(inner.calls.length, 1);
  const derived = inner.calls[0];
  // The runner's observation text survives; the legal list and instruction are added.
  assert.ok(derived.observation.text.startsWith('The board.'));
  assert.match(derived.observation.text, /Legal actions \(4\)/);
  for (const action of ['down', 'left', 'right', 'up']) {
    assert.ok(derived.observation.text.includes(action));
  }
  assert.match(derived.observation.text, /ACTION: <action>/);
  // The inner agent stays on the official wire contract: no legalActions.
  assert.equal(derived.legalActions, null);
});

test('an invalid reply is retried with the referee reason as feedback, in the same turn', async () => {
  const inner = stubInner(['I like this position.', 'ACTION: diagonal', 'ACTION: up']);
  const agent = createAssistedAgent({ inner });
  const reply = await agent.act(legalCtx());
  assert.equal(inner.calls.length, 3);
  // The runner's extractor reads the last non-empty line as the attempted
  // action, so prose is reported as a non-legal action, not as "no action".
  assert.match(
    /** @type {*} */ (inner.calls[1].feedback),
    /"I like this position\." is not a legal action/
  );
  assert.match(/** @type {*} */ (inner.calls[2].feedback), /"diagonal" is not a legal action/);
  assert.equal(reply.text, 'ACTION: up');
  assert.deepEqual(reply.meta.assisted, { attempts: 3, retried: true });
});

test('usage and cost sum across attempts, and null propagates', async () => {
  const inner = stubInner([
    { text: 'hmm', usage: { inputTokens: 10, outputTokens: 5, costUsd: null } },
    { text: 'ACTION: up', usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.25 } },
  ]);
  const agent = createAssistedAgent({ inner });
  const reply = await agent.act(legalCtx());
  assert.deepEqual(reply.usage, { inputTokens: 17, outputTokens: 8, costUsd: null });
});

test('a null token count anywhere makes the turn total unmeasured, not zero', async () => {
  const inner = stubInner([
    { text: 'hmm', usage: { inputTokens: null, outputTokens: 5, costUsd: null } },
    { text: 'ACTION: up', usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.25 } },
  ]);
  const agent = createAssistedAgent({ inner });
  const reply = await agent.act(legalCtx());
  assert.ok(reply.usage, 'reply carries usage');
  const usage = /** @type {NonNullable<import('../core/types.js').AgentReply['usage']>} */ (reply.usage);
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.outputTokens, null);
  assert.equal(usage.costUsd, null);
});

test('the wrapper is on the community track and carries the assisted id', async () => {
  const agent = createAssistedAgent({ inner: stubInner(['ACTION: up']) });
  assert.equal(agent.track, 'community');
  assert.equal(agent.id, 'community-assisted:model:openai-chat/stub-model');
  const named = createAssistedAgent({
    inner: stubInner(['ACTION: up']),
    id: 'community-assisted:openai-chat/stub-model:retries=2',
  });
  assert.equal(named.id, 'community-assisted:openai-chat/stub-model:retries=2');
});

test('after exhausting the retries the last reply is returned untouched and flagged', async () => {
  const inner = stubInner(['nope 1', 'nope 2', 'nope 3']);
  const agent = createAssistedAgent({ inner, retries: 2 });
  const reply = await agent.act(legalCtx());
  assert.equal(inner.calls.length, 3);
  assert.equal(reply.text, 'nope 3');
  assert.equal(reply.meta.assisted.exhausted, true);
  assert.equal(reply.meta.assisted.attempts, 3);
});

test('the inner agent is never called beyond the retry budget', async () => {
  const inner = stubInner(['bad 1', 'bad 2', 'bad 3', 'bad 4']);
  const agent = createAssistedAgent({ inner, retries: 1 });
  await agent.act(legalCtx());
  assert.equal(inner.calls.length, 2);
});

test('the inner agent sees the runner feedback on the first attempt of a retry turn', async () => {
  const inner = stubInner(['ACTION: up']);
  const agent = createAssistedAgent({ inner });
  const ctx = legalCtx();
  ctx.feedback = 'illegal action "e5"';
  await agent.act(ctx);
  assert.equal(inner.calls[0].feedback, 'illegal action "e5"');
});

test('an official-track turn context without legal actions is refused, not silently unassisted', async () => {
  const agent = createAssistedAgent({ inner: stubInner(['ACTION: up']) });
  const ctx = legalCtx();
  ctx.legalActions = null;
  await assert.rejects(() => agent.act(ctx), /needs the community track's legal actions/);
});

test('inner reply meta is preserved under meta.inner', async () => {
  const inner = stubInner([
    { text: 'ACTION: up', usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, meta: { retries: 0 } },
  ]);
  const agent = createAssistedAgent({ inner });
  const reply = await agent.act(legalCtx());
  assert.deepEqual(reply.meta.inner, { retries: 0 });
});

test('a legal-list longer than the cap shows the first cap actions plus the full count', async () => {
  const inner = stubInner(['ACTION: a00']);
  const agent = createAssistedAgent({ inner, maxLegalActions: 8 });
  const ctx = legalCtx();
  ctx.legalActions = Array.from({ length: 30 }, (_, i) => `a${String(i).padStart(2, '0')}`);
  await agent.act(ctx);
  const text = inner.calls[0].observation.text;
  assert.match(text, /Legal actions \(30 total, first 8 shown/);
  assert.ok(text.includes('a00'));
  assert.ok(!text.includes('a29, '));
});
