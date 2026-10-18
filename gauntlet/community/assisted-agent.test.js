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
  assert.deepEqual(reply.meta.assisted, { attempts: 3, retried: true, invalidAttempts: 2 });
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

test('the wrapper quotes the run engine at the retry-inclusive worst case', async () => {
  // The dollar caps reserve a quoted agent's next call before it starts
  // (runs/run.js). The wrapper hides up to retries + 1 provider calls behind
  // one turn, so its quote must cover every attempt, not just the first.
  const inner = stubInner(['ACTION: up']);
  inner.quoteWorstCaseUsd = () => 0.4;
  const agent = createAssistedAgent({ inner, retries: 2 });
  const quoted = agent.quoteWorstCaseUsd?.(legalCtx());
  assert.ok(quoted !== null && quoted !== undefined && Math.abs(quoted - 1.2) < 1e-9);
  const single = createAssistedAgent({ inner, retries: 0 });
  assert.equal(single.quoteWorstCaseUsd?.(legalCtx()), 0.4);
});

test('the quote is computed against the derived context the inner agent sees', async () => {
  // The inner agent's request is built from the augmented observation (legal
  // block + ACTION instruction), so the quote must price that text.
  const inner = stubInner(['ACTION: up']);
  /** @type {TurnContext[]} */
  const quoted = [];
  inner.quoteWorstCaseUsd = (/** @type {TurnContext} */ ctx) => {
    quoted.push(ctx);
    return 0.5;
  };
  const agent = createAssistedAgent({ inner, retries: 0 });
  agent.quoteWorstCaseUsd?.(legalCtx());
  assert.equal(quoted.length, 1);
  assert.equal(quoted[0].legalActions, null, 'the inner agent is on the official wire');
  assert.match(quoted[0].observation.text, /Legal actions \(4\)/);
  assert.match(quoted[0].observation.text, /ACTION: <action>/);
});

test('a quote-less inner agent stays quote-less', async () => {
  const inner = stubInner(['ACTION: up']);
  const agent = createAssistedAgent({ inner });
  assert.equal(agent.quoteWorstCaseUsd?.(legalCtx()), null);
});

test('an action beyond the display cap is accepted on the first attempt', async () => {
  // The legal-action DISPLAY truncates to the first maxLegalActions entries,
  // but first-attempt acceptance checks the runner's FULL legalActions list —
  // the cap is presentational only. This pins that contract: nothing in the
  // wrapper may narrow first-attempt acceptance to the displayed prefix.
  const legal = Array.from({ length: 70 }, (_, i) => `move${i + 1}`);
  const inner = stubInner(['ACTION: move70']);
  const agent = createAssistedAgent({ inner, maxLegalActions: 10 });
  const reply = await agent.act({ ...legalCtx(), legalActions: legal });
  assert.equal(inner.calls.length, 1, 'no retry for an un-displayed but legal action');
  assert.equal(reply.meta?.assisted?.attempts, 1);
  // The display still truncates.
  const shown = inner.calls[0].observation.text;
  assert.match(shown, /Legal actions \(70 total, first 10 shown/);
  assert.ok(!shown.includes('move70'), 'move70 is beyond the displayed prefix');
});

test('the retry quote bounds the per-retry request growth with the inner agent\u2019s output cap', async () => {
  // A retry's request is not attempt 0's request: after attempt 0 the inner
  // agent's official turn message embeds the FULL previous reply
  // (harness/official.js), and the wrapper's rejection feedback re-embeds the
  // attempted action — itself a substring of that reply. The quote must price
  // the largest attempt's request, bounded by the inner agent's output cap,
  // not assume every attempt costs what attempt 0 costs.
  /** @type {TurnContext[]} */
  const quoted = [];
  /** @type {number[]} */
  const recorded = [];
  const inner = stubInner(['ACTION: up']);
  inner.quoteWorstCaseUsd = (/** @type {TurnContext} */ ctx) => {
    quoted.push(ctx);
    // Mirror the real estimator: request bytes at one token per two UTF-8
    // bytes, inputPerMTok 2 → byte count / 1e6 USD.
    const price = Buffer.byteLength(ctx.observation.text, 'utf8') / 1_000_000;
    recorded.push(price);
    return price;
  };
  inner.maxOutputTokens = 16;

  // Attempt 0's augmented request, un-padded: the byte baseline every retry
  // grows from.
  const base = createAssistedAgent({ inner, retries: 0 });
  base.quoteWorstCaseUsd?.(legalCtx());
  assert.equal(quoted.length, 1);
  const augmentedBytes = Buffer.byteLength(quoted[0].observation.text, 'utf8');

  const agent = createAssistedAgent({ inner, retries: 2 });
  const quote = agent.quoteWorstCaseUsd?.(legalCtx());
  // The largest (last) attempt's padded request is priced once.
  assert.equal(quoted.length, 2);
  // The quoted request grows by exactly the per-retry bound: a reply of at
  // most 16 tokens contributes at most 2 * 16 bytes as the next previous-
  // reply section, and the rejection feedback re-embeds the attempted action
  // plus fixed text — the pair is bounded at 4 * 16 + 256 bytes per retry.
  const pad = 2 * (4 * 16 + 256);
  assert.equal(
    Buffer.byteLength(quoted[1].observation.text, 'utf8'),
    augmentedBytes + pad,
    'the quoted request grows by the cap-bound per-retry maximum'
  );
  // Every attempt is priced at that largest request.
  assert.ok(quote !== null && quote !== undefined);
  assert.ok(
    Math.abs(quote - 3 * recorded[1]) < 1e-12,
    'every attempt runs at the largest request\u2019s price'
  );
});
