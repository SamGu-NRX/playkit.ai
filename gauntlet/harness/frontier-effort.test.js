/**
 * Tests for adaptive thinking and reasoning effort on current Claude models:
 * the per-model Anthropic capability table (accepted thinking modes, effort
 * levels, documented defaults, sampling-field rules, with doc URLs and check
 * dates on each row), the effort wire shape (`output_config.effort`, no
 * `thinking` field, max_tokens as the hard limit on the whole reply), the
 * effective-effort agent identity, manual budgets on the models that still
 * take them, `stop_reason: "refusal"` replies, and the dollar cap's
 * reservation when an effort is set instead of a budget.
 *
 * Fixture bodies mirror the documented provider shapes (Anthropic effort and
 * adaptive-thinking guides, models overview, Opus 5.5 migration guide,
 * refusals and fallback — all checked 2026-10-16). All offline: node:http
 * stubs on 127.0.0.1 only, no paid calls.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createModelAgent } from './model-agent.js';
import { OFFICIAL_SYSTEM_PROMPT } from './official.js';
import { startStubServer, sendJson } from './stub-server.js';
import { runSuite } from '../runs/run.js';
import { buildSuite } from '../scoring/suite.js';
import { takeOrPass, countdown } from '../scoring/fixtures.js';

// The clients read the key at call time; a dummy value keeps every request on
// the local stubs.
process.env.GAUNTLET_TEST_KEY = 'stub-key-anthropic';

const RULES = 'RULES TEXT for the stub game.';
const OBS = 'OBSERVATION TEXT';

const CTX = /** @type {import('../core/types.js').TurnContext} */ ({
  spec: { rulesText: RULES },
  tier: { id: 't' },
  seat: 0,
  turn: 0,
  observation: { text: OBS, data: {} },
  legalActions: null,
  feedback: null,
});

/** Prices whose output rate makes arithmetic easy to check by hand. */
const EFFORT_PRICES = {
  'anthropic/claude-opus-5-5': {
    inputPerMTok: 4,
    outputPerMTok: 5000,
    source: 'stub',
    checked: '2026-10-16',
  },
  'anthropic/claude-sonnet-5-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    source: 'stub',
    checked: '2026-10-16',
  },
  'anthropic/claude-opus-4-5': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    source: 'stub',
    checked: '2026-10-16',
  },
  'anthropic/claude-opus-4-7': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    source: 'stub',
    checked: '2026-10-16',
  },
  'anthropic/claude-opus-4-6': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    source: 'stub',
    checked: '2026-10-16',
  },
  'anthropic/claude-3-7-sonnet-latest': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    source: 'stub',
    checked: '2026-10-16',
  },
};

/**
 * A scripted JSON stub that records method, path and parsed body per request,
 * answering from a list of (status, payload) pairs (last one repeats).
 *
 * @param {Array<[number, *]>} script
 * @returns {Promise<{ url: string, requests: *, close: () => Promise<void> }>}
 */
async function scriptStub(script) {
  /** @type {*} */
  const requests = [];
  const { url, close } = await startStubServer((req, res, body) => {
    requests.push({ method: req.method, url: req.url, body });
    const [status, payload] = script[Math.min(requests.length - 1, script.length - 1)];
    sendJson(res, status, payload);
  });
  return { url, requests, close };
}

/**
 * A valid takeOrPass reply in the Anthropic Messages shape.
 * @param {Record<string, *>} [overrides] Extra top-level response fields.
 * @param {Record<string, *>} [usageDetails] Extra Anthropic usage fields.
 * @returns {[number, *]} A (status, payload) pair for scriptStub.
 */
function anthropicTake(overrides, usageDetails) {
  return [
    200,
    {
      id: 'msg_take',
      type: 'message',
      role: 'assistant',
      model: 'stub-model',
      content: [{ type: 'text', text: 'take' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        ...(usageDetails ?? {}),
      },
      ...(overrides ?? {}),
    },
  ];
}

/**
 * Convenience: an agent on the local stub with the standard test options.
 * @param {string} stubUrl
 * @param {string} model
 * @param {Partial<import('./model-agent.js').ModelAgentOptions>} [options]
 */
function testAgent(stubUrl, model, options) {
  return createModelAgent({
    provider: 'anthropic',
    model,
    baseUrl: stubUrl,
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
    maxOutputTokens: 64,
    prices: EFFORT_PRICES,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// The wire shape on an adaptive-thinking model: effort goes out as
// output_config.effort, no `thinking` field is ever sent, and max_tokens is
// the whole-reply limit (the text cap itself, no budget headroom).

test('claude-opus-5-5 with reasoningEffort sends output_config.effort, no thinking field, and max_tokens as the cap itself', async () => {
  const stub = await scriptStub([anthropicTake()]);
  try {
    const agent = testAgent(stub.url, 'claude-opus-5-5', { reasoningEffort: 'high' });
    assert.equal(agent.id, 'anthropic/claude-opus-5-5:reasoning-effort=high');
    await agent.act(CTX);
    const body = stub.requests[0].body;
    // Exact key set: no thinking field, no sampling fields, no stray params.
    assert.deepEqual(
      Object.keys(body).sort(),
      ['max_tokens', 'messages', 'model', 'output_config', 'system']
    );
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.max_tokens, 64);
    assert.deepEqual(body.output_config, { effort: 'high' });
    assert.equal(body.system, OFFICIAL_SYSTEM_PROMPT);
  } finally {
    await stub.close();
  }
});

test('an unset effort on a documented-default model sends no output_config and records provider-default plus the documented default', async () => {
  const stub = await scriptStub([anthropicTake()]);
  try {
    const agent = testAgent(stub.url, 'claude-opus-5-5');
    assert.equal(agent.id, 'anthropic/claude-opus-5-5:reasoning-effort=provider-default');
    assert.equal(agent.reasoningEffort, 'provider-default');
    assert.equal(agent.reasoningEffortDefault, 'medium');
    await agent.act(CTX);
    const body = stub.requests[0].body;
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'system']);
    assert.equal(body.max_tokens, 64);
  } finally {
    await stub.close();
  }
});

test('all five documented effort levels are accepted on claude-opus-5-5 and reach the wire verbatim', async () => {
  const stub = await scriptStub([
    anthropicTake(),
    anthropicTake(),
    anthropicTake(),
    anthropicTake(),
    anthropicTake(),
  ]);
  try {
    const agent = testAgent(stub.url, 'claude-opus-5-5');
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const withEffort = createModelAgent({
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        baseUrl: stub.url,
        apiKeyEnv: 'GAUNTLET_TEST_KEY',
        maxOutputTokens: 64,
        reasoningEffort: /** @type {*} */ (level),
      });
      await withEffort.act(CTX);
    }
    const levels = stub.requests.map((/** @type {*} */ r) => r.body.output_config.effort);
    assert.deepEqual(levels, ['low', 'medium', 'high', 'xhigh', 'max']);
    for (const request of stub.requests) {
      assert.equal(request.body.thinking, undefined, 'no thinking field on adaptive models');
      assert.equal(request.body.max_tokens, 64);
    }
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// Manual budgets: refused on the adaptive-thinking models at construction
// (the API answers HTTP 400), kept on the models whose rows still accept
// them, where max_tokens is the text cap plus the budget as before.

test('thinkingBudget on claude-opus-5-5 throws at construction, naming the model, the table, and reasoningEffort', () => {
  assert.throws(
    () =>
      createModelAgent({
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        baseUrl: 'http://127.0.0.1:9',
        apiKeyEnv: 'GAUNTLET_TEST_KEY',
        thinkingBudget: 1024,
      }),
    (/** @type {*} */ err) => {
      assert.match(err.message, /thinkingBudget is not accepted on model "claude-opus-5-5" \(Claude Opus 5\.5\)/);
      assert.match(err.message, /rejects manual budget_tokens with HTTP 400 — steer thinking with reasoningEffort instead/);
      assert.match(err.message, /Anthropic capability table in harness\/model-agent\.js/);
      assert.match(err.message, /opus-5-5\/migration-guide/);
      assert.match(err.message, /checked 2026-10-16/);
      return true;
    }
  );
});

test('models whose rows keep manual mode ride the budget on top of the cap: claude-opus-4-5 sends thinking.budget_tokens with max_tokens = cap + budget', async () => {
  const stub = await scriptStub([anthropicTake()]);
  try {
    const agent = testAgent(stub.url, 'claude-opus-4-5', { thinkingBudget: 1024 });
    assert.equal(agent.id, 'anthropic/claude-opus-4-5', 'no effort suffix without documented effort levels');
    await agent.act(CTX);
    const body = stub.requests[0].body;
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'system', 'thinking']);
    assert.equal(body.max_tokens, 64 + 1024);
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 1024 });
    assert.equal(body.output_config, undefined);
  } finally {
    await stub.close();
  }
});

test('reasoningEffort on a model without documented effort levels is refused, naming the table', () => {
  assert.throws(
    () =>
      createModelAgent({
        provider: 'anthropic',
        model: 'claude-opus-4-5',
        baseUrl: 'http://127.0.0.1:9',
        apiKeyEnv: 'GAUNTLET_TEST_KEY',
        reasoningEffort: 'high',
      }),
    (/** @type {*} */ err) => {
      assert.match(err.message, /documents no effort levels for model "claude-opus-4-5" \(Claude Opus 4\.5\)/);
      assert.match(err.message, /See the table in harness\/model-agent\.js and https:\/\/platform\.claude\.com/);
      assert.match(err.message, /checked 2026-10-16/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Effort levels are enforced per model, exactly as documented: xhigh exists on
// Opus 4.7 but the Opus 4.6 row lists low/medium/high/max only.

test('claude-opus-4-7 takes xhigh; claude-opus-4-6 refuses xhigh but takes max', async () => {
  const stub = await scriptStub([anthropicTake(), anthropicTake()]);
  try {
    const opus47 = testAgent(stub.url, 'claude-opus-4-7', { reasoningEffort: 'xhigh' });
    assert.equal(opus47.id, 'anthropic/claude-opus-4-7:reasoning-effort=xhigh');
    await opus47.act(CTX);
    assert.deepEqual(stub.requests[0].body.output_config, { effort: 'xhigh' });
    assert.equal(stub.requests[0].body.max_tokens, 64);

    assert.throws(
      () =>
        createModelAgent({
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          baseUrl: stub.url,
          apiKeyEnv: 'GAUNTLET_TEST_KEY',
          reasoningEffort: 'xhigh',
        }),
      (/** @type {*} */ err) => {
        assert.match(err.message, /reasoning effort "xhigh" is not documented for model "claude-opus-4-6" \(Claude Opus 4\.6\)/);
        assert.match(err.message, /documented levels are "low", "medium", "high", "max"/);
        return true;
      }
    );

    const opus46 = testAgent(stub.url, 'claude-opus-4-6', { reasoningEffort: 'max' });
    await opus46.act(CTX);
    assert.deepEqual(stub.requests[1].body.output_config, { effort: 'max' });
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// The table's refusal paths: an unknown Claude id is refused with a message
// naming the table (a new model cannot be silently run with settings it may
// reject), while legacy ids keep older behaviour.

test('an unknown Claude id is refused with a message naming the capability table', () => {
  assert.throws(
    () =>
      createModelAgent({
        provider: 'anthropic',
        model: 'claude-opus-9-9',
        baseUrl: 'http://127.0.0.1:9',
        apiKeyEnv: 'GAUNTLET_TEST_KEY',
      }),
    (/** @type {*} */ err) => {
      assert.match(err.message, /"claude-opus-9-9" is a Claude id that matches no row in the Anthropic capability table/);
      assert.match(err.message, /Add a row with the model-id pattern, accepted thinking modes, effort levels, default effort, and sampling-field rules/);
      assert.match(err.message, /https:\/\/platform\.claude\.com\/docs\/en\/models\/overview/);
      return true;
    }
  );
});

test('a legacy Claude id keeps older behaviour: claude-3-7 takes a budget and refuses effort; pre-thinking ids refuse both', async () => {
  const stub = await scriptStub([anthropicTake()]);
  try {
    const legacy = testAgent(stub.url, 'claude-3-7-sonnet-latest', { thinkingBudget: 1024 });
    await legacy.act(CTX);
    const body = stub.requests[0].body;
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 1024 });
    assert.equal(body.max_tokens, 64 + 1024);

    assert.throws(
      () =>
        createModelAgent({
          provider: 'anthropic',
          model: 'claude-3-7-sonnet-latest',
          baseUrl: stub.url,
          apiKeyEnv: 'GAUNTLET_TEST_KEY',
          reasoningEffort: 'high',
        }),
      /documents no effort levels for model "claude-3-7-sonnet-latest"/
    );
    assert.throws(
      () =>
        createModelAgent({
          provider: 'anthropic',
          model: 'claude-2.0',
          baseUrl: stub.url,
          apiKeyEnv: 'GAUNTLET_TEST_KEY',
          thinkingBudget: 1024,
        }),
      /thinkingBudget is not accepted on model "claude-2\.0" \(Claude legacy \(pre-thinking model ids\)\): the model rejects manual budget_tokens with HTTP 400\. See the Anthropic capability table/
    );
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// Sampling fields: refused at construction (through params) exactly where the
// docs say the API rejects them with HTTP 400, passed through elsewhere.

test('sampling fields in params are refused on the models that reject them, naming the fields', async () => {
  for (const [model, params, fields] of [
    ['claude-opus-5-5', { temperature: 0.7 }, '"temperature"'],
    ['claude-sonnet-5-5', { top_p: 0.9, top_k: 40 }, '"top_p", "top_k"'],
  ]) {
    assert.throws(
      () =>
        createModelAgent({
          provider: 'anthropic',
          model: /** @type {string} */ (model),
          baseUrl: 'http://127.0.0.1:9',
          apiKeyEnv: 'GAUNTLET_TEST_KEY',
          params: /** @type {Record<string, *>} */ (params),
        }),
      (/** @type {*} */ err) => {
        assert.match(err.message, new RegExp(`params carries sampling field\\(s\\) ${fields}`));
        assert.match(err.message, new RegExp(`model "${model}"`));
        assert.match(err.message, /rejects non-default temperature\/top_p\/top_k with HTTP 400/);
        assert.match(err.message, /steer behavior with reasoningEffort/);
        return true;
      }
    );
  }
});

test('sampling params pass through on a model that allows them', async () => {
  const stub = await scriptStub([anthropicTake()]);
  try {
    const agent = testAgent(stub.url, 'claude-opus-4-5', { params: { temperature: 0 } });
    await agent.act(CTX);
    const body = stub.requests[0].body;
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 64);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// Refusal replies: HTTP 200 with stop_reason "refusal" arrives as empty text,
// honest usage, and refusal metadata (category + explanation, null when the
// provider sends no stop_details) — distinct from a malformed reply.

test('a refusal reply records empty text with meta.refusal category and explanation, and honest usage', async () => {
  const stub = await scriptStub([
    anthropicTake(
      {
        stop_reason: 'refusal',
        stop_details: {
          type: 'refusal',
          category: 'cyber',
          explanation: 'This request was declined because it could enable cyber harm.',
          recommended_model: null,
        },
      },
      { input_tokens: 100, output_tokens: 0 }
    ),
    anthropicTake(
      { stop_reason: 'refusal' },
      { input_tokens: 100, output_tokens: 0 }
    ),
  ]);
  try {
    const agent = testAgent(stub.url, 'claude-opus-5-5', { reasoningEffort: 'high' });
    const first = await agent.act(CTX);
    assert.equal(first.text, '');
    assert.deepEqual(first.meta.refusal, {
      category: 'cyber',
      explanation: 'This request was declined because it could enable cyber harm.',
    });
    assert.equal(first.meta.retries, 0);
    const { usage } = first;
    assert.ok(usage, 'a refusal records measured usage, not a transport error');
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 0);
    assert.ok(usage.costUsd !== null, 'refusal usage is recorded as measured');
    assert.ok(Math.abs(usage.costUsd - 0.0004) < 1e-12);

    const second = await agent.act(CTX);
    assert.equal(second.text, '');
    assert.deepEqual(second.meta.refusal, { category: null, explanation: null });
  } finally {
    await stub.close();
  }
});

test('a reply cut off while thinking under adaptive effort records empty text and honest usage, not a fake action', async () => {
  const stub = await scriptStub([
    [
      200,
      {
        id: 'msg_thinking',
        type: 'message',
        role: 'assistant',
        model: 'stub-model',
        content: [{ type: 'thinking', thinking: 'unreleased reasoning…', signature: 'sig' }],
        stop_reason: 'max_tokens',
        usage: {
          input_tokens: 100,
          output_tokens: 64,
          output_tokens_details: { thinking_tokens: 64 },
        },
      },
    ],
  ]);
  try {
    const agent = testAgent(stub.url, 'claude-opus-5-5', { reasoningEffort: 'max' });
    const reply = await agent.act(CTX);
    assert.equal(reply.text, '', 'thinking blocks never enter the reply text');
    const { usage } = reply;
    assert.ok(usage, 'a cut-off reply records its usage');
    assert.equal(usage.inputTokens, 100);
    assert.equal(usage.outputTokens, 64);
    assert.equal(reply.meta.reasoningTokens, 64);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// The dollar cap with an effort set: on the adaptive-thinking models the wire
// max_tokens is the cap itself (thinking rides inside it), so the reservation
// equals the wire limit one for one and the cap holds under concurrency.

const CAP_SUITE = buildSuite([takeOrPass, countdown], { split: 'public' });
const CAP_GAMES = [takeOrPass, countdown];

test('the dollar cap holds with an effort set: the reservation is the wire max_tokens, exactly 3 admitted calls', { timeout: 60 * 1000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-frontier-effort-cap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  let inFlight = 0;
  let maxInFlight = 0;
  const stub = await startStubServer(
    /** @param {import('node:http').IncomingMessage} _req @param {import('node:http').ServerResponse} res */
    (_req, res) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight -= 1;
        sendJson(res, 200, {
          id: 'msg_cap',
          type: 'message',
          role: 'assistant',
          model: 'stub-model',
          content: [{ type: 'text', text: 'take' }],
          stop_reason: 'end_turn',
          // Output totals at the wire max_tokens (1029), so settled cost
          // equals the reservation's worst case exactly.
          usage: { input_tokens: 100, output_tokens: 1029 },
        });
      }, 25);
    }
  );
  t.after(() => stub.close());

  const pricesPath = join(dir, 'prices.json');
  await writeFile(pricesPath, JSON.stringify(EFFORT_PRICES, null, 2));

  const result = await runSuite({
    suite: CAP_SUITE,
    games: CAP_GAMES,
    outDir: dir,
    pricesPath,
    reasoningEffort: 'medium',
    concurrency: 4,
    maxUsd: 20,
    agentFactory: () =>
      createModelAgent({
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        baseUrl: stub.url,
        apiKeyEnv: 'GAUNTLET_TEST_KEY',
        prices: EFFORT_PRICES,
        // The quote's output term is the wire max_tokens — the 1029-token
        // whole-reply cap (no separate budget) at $5000/MTok = $5.145 per call
        // — plus a small input term, and the stub settles at exactly 1029
        // output tokens, so settled cost matches the reservation's worst case.
        // A $20 cap admits exactly 3 calls and refuses the 4th.
        maxOutputTokens: 1029,
        reasoningEffort: 'medium',
        sleep: async () => {},
      }),
  });

  assert.equal(result.stopped, 'budget', 'the run stops on the budget cap');
  assert.equal(result.run.calls, 3, 'exactly three calls are admitted');
  assert.ok(result.run.spendUsd <= 20 + 1e-9, 'realized spend never exceeds the cap');
  assert.equal(result.run.counts.failed, 0, 'no episode failed');
  assert.ok(maxInFlight >= 2, `calls actually overlapped (max in flight: ${maxInFlight})`);
  assert.ok(maxInFlight <= 4, 'concurrency stays bounded by the worker count');
});

// ---------------------------------------------------------------------------
// Non-Anthropic effort widening: the docs' per-model value sets vary; the
// harness accepts xhigh for provider "openai" and keeps openai-chat at the
// three values Google's OpenAI-compatible endpoint documents.

test('reasoningEffort xhigh reaches the wire for provider openai and is refused for openai-chat', async () => {
  const stub = await scriptStub([
    [
      200,
      {
        id: 'resp_take',
        object: 'response',
        status: 'completed',
        model: 'stub-model',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'take' }] },
        ],
        usage: { input_tokens: 70, output_tokens: 10, total_tokens: 80 },
      },
    ],
  ]);
  try {
    const openaiAgent = createModelAgent({
      provider: 'openai',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      reasoningEffort: 'xhigh',
    });
    await openaiAgent.act(CTX);
    assert.deepEqual(stub.requests[0].body.reasoning, { effort: 'xhigh' });

    assert.throws(
      () =>
        createModelAgent({
          provider: 'openai-chat',
          model: 'stub-model',
          baseUrl: stub.url,
          apiKeyEnv: 'GAUNTLET_TEST_KEY',
          reasoningEffort: 'xhigh',
        }),
      /reasoningEffort for provider "openai-chat" must be one of "low", "medium", "high", got "xhigh"/
    );
  } finally {
    await stub.close();
  }
});
