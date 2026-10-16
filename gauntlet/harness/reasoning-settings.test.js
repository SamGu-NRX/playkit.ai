/**
 * Tests for the reasoning settings: Anthropic extended thinking
 * (--thinking-budget → thinking.budget_tokens), OpenAI reasoning effort
 * (--reasoning-effort → reasoning.effort / reasoning_effort), their provider
 * pairing and dry-run rules in the spec layer, the settings suffix in the
 * agent identity, run.json's limits, and the dollar cap's reservation that
 * includes the thinking budget.
 *
 * Fixture bodies mirror the documented provider shapes (Anthropic Messages
 * extended-thinking guide and API reference; OpenAI Responses reasoning
 * guide; chat-completions reasoning_effort as Google's Gemini OpenAI-compatible
 * endpoint takes it) — thinking/redacted_thinking content blocks on Anthropic,
 * reasoning output items and status "incomplete" on OpenAI, and the
 * usage-output-details token breakdowns. All offline: node:http stubs on
 * 127.0.0.1 only, no paid calls.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { createModelAgent } from './model-agent.js';
import { startStubServer, sendJson } from './stub-server.js';
import { parseAgentSpec } from '../cli/agents.js';
import { runSuite } from '../runs/run.js';
import { buildSuite } from '../scoring/suite.js';
import { takeOrPass, countdown } from '../scoring/fixtures.js';
import { getGame } from '../games/index.js';

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
const PRICES = {
  'anthropic/stub-model': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    source: 'stub',
    checked: '2026-10-16',
  },
  'openai/stub-model': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    source: 'stub',
    checked: '2026-10-16',
  },
  'openai-chat/stub-model': {
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
 * @param {Record<string, *>} [usageDetails] Extra Anthropic usage fields.
 * @returns {[number, *]} A (status, payload) pair for scriptStub.
 */
function anthropicTake(usageDetails) {
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
    },
  ];
}

/**
 * A valid takeOrPass reply in the OpenAI Responses shape.
 * @param {Record<string, *>} [usageDetails] Extra OpenAI usage fields.
 * @returns {[number, *]} A (status, payload) pair for scriptStub.
 */
function openaiTake(usageDetails) {
  return [
    200,
    {
      id: 'resp_take',
      object: 'response',
      status: 'completed',
      model: 'stub-model',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'take' }],
        },
      ],
      usage: {
        input_tokens: 70,
        output_tokens: 10,
        total_tokens: 80,
        ...(usageDetails ?? {}),
      },
    },
  ];
}

/**
 * A valid takeOrPass reply in the chat-completions shape.
 * @param {Record<string, *>} [usageDetails] Extra chat-completions usage fields.
 * @returns {[number, *]} A (status, payload) pair for scriptStub.
 */
function chatTake(usageDetails) {
  return [
    200,
    {
      id: 'chatcmpl_take',
      object: 'chat.completion',
      model: 'stub-model',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'take' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 88, completion_tokens: 10, total_tokens: 98, ...(usageDetails ?? {}) },
    },
  ];
}

// ---------------------------------------------------------------------------
// Anthropic: thinking budget reaches the wire; thinking blocks stay out of the
// reply text; thinking tokens are inside the reported output total.

test('anthropic thinkingBudget reaches the wire as thinking.budget_tokens with max_tokens = cap + budget', async () => {
  const stub = await scriptStub([anthropicTake()]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 64,
      thinkingBudget: 1024,
    });
    await agent.act(CTX);
    assert.equal(stub.requests.length, 1);
    const body = stub.requests[0].body;
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 1024 });
    // Thinking tokens count toward max_tokens, so the reply keeps its full
    // 64-token text budget on top of the 1024-token budget.
    assert.equal(body.max_tokens, 64 + 1024);

    // Without a budget: no thinking field and max_tokens is the cap itself.
    const plain = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 64,
    });
    await plain.act(CTX);
    assert.equal(stub.requests[1].body.thinking, undefined);
    assert.equal(stub.requests[1].body.max_tokens, 64);
  } finally {
    await stub.close();
  }
});

test('anthropic thinking and redacted_thinking blocks never enter the reply text; usage stays the reported totals', async () => {
  const stub = await scriptStub([
    [
      200,
      {
        id: 'msg_think',
        type: 'message',
        role: 'assistant',
        model: 'stub-model',
        content: [
          { type: 'thinking', thinking: 'Passing is dominated here, so take.', signature: 'sig' },
          { type: 'redacted_thinking', data: 'encrypted-opaque-blob' },
          { type: 'text', text: 'take' },
        ],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 120,
          output_tokens: 28,
          output_tokens_details: { thinking_tokens: 20 },
        },
      },
    ],
  ]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      thinkingBudget: 1024,
      prices: PRICES,
    });
    const reply = await agent.act(CTX);
    assert.equal(reply.text, 'take');
    assert.ok(!reply.text.includes('dominated'));
    assert.ok(!reply.text.includes('encrypted'));
    // usage.output_tokens is the total including thinking tokens (28, not 8).
    assert.ok(reply.usage);
    assert.ok(reply.usage.costUsd !== null);
    assert.equal(reply.usage.inputTokens, 120);
    assert.equal(reply.usage.outputTokens, 28);
    assert.ok(Math.abs(reply.usage.costUsd - (120 / 1e6) * 3 - (28 / 1e6) * 15) < 1e-12);
    assert.equal(reply.meta.reasoningTokens, 20);
  } finally {
    await stub.close();
  }
});

test('anthropic: an answer cut off mid-thinking (stop_reason max_tokens, only a thinking block) records honestly instead of throwing', async () => {
  const stub = await scriptStub([
    [
      200,
      {
        id: 'msg_cut',
        type: 'message',
        role: 'assistant',
        model: 'stub-model',
        content: [{ type: 'thinking', thinking: 'half a thought…', signature: 'sig' }],
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
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 64,
      thinkingBudget: 1024,
      prices: PRICES,
    });
    const reply = await agent.act(CTX);
    assert.equal(reply.text, '');
    assert.ok(reply.usage);
    assert.ok(reply.usage.costUsd !== null);
    assert.equal(reply.usage.inputTokens, 100);
    assert.equal(reply.usage.outputTokens, 64);
    assert.ok(Math.abs(reply.usage.costUsd - (100 / 1e6) * 3 - (64 / 1e6) * 15) < 1e-12);
    assert.equal(reply.meta.reasoningTokens, 64);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// OpenAI Responses: reasoning.effort reaches the wire; the reasoning output
// item stays out of the reply text; usage.output_tokens includes reasoning.

test('openai reasoningEffort reaches the wire as reasoning.effort; the reasoning item stays out of the text', async () => {
  const stub = await scriptStub([
    [
      200,
      {
        id: 'resp_reason',
        object: 'response',
        status: 'completed',
        model: 'stub-model',
        output: [
          { type: 'reasoning', id: 'rs_1', summary: [] },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'take' }],
          },
        ],
        usage: {
          input_tokens: 70,
          output_tokens: 30,
          output_tokens_details: { reasoning_tokens: 24 },
        },
      },
    ],
  ]);
  try {
    const agent = createModelAgent({
      provider: 'openai',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      reasoningEffort: 'high',
      prices: PRICES,
    });
    const reply = await agent.act(CTX);
    const body = stub.requests[0].body;
    assert.deepEqual(body.reasoning, { effort: 'high' });
    assert.equal(reply.text, 'take');
    assert.deepEqual(reply.usage, {
      inputTokens: 70,
      outputTokens: 30,
      costUsd: (70 * 3 + 30 * 15) / 1e6,
    });
    assert.equal(reply.meta.reasoningTokens, 24);

    // Without effort: no reasoning field at all.
    const plain = createModelAgent({
      provider: 'openai',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    await plain.act(CTX);
    assert.equal(stub.requests[1].body.reasoning, undefined);
  } finally {
    await stub.close();
  }
});

test('openai: status "incomplete" cut off mid-reasoning (no message item) records honestly instead of throwing', async () => {
  const stub = await scriptStub([
    [
      200,
      {
        id: 'resp_inc',
        object: 'response',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        model: 'stub-model',
        output: [{ type: 'reasoning', id: 'rs_1', summary: [] }],
        usage: {
          input_tokens: 64,
          output_tokens: 4096,
          output_tokens_details: { reasoning_tokens: 4096 },
        },
      },
    ],
  ]);
  try {
    const agent = createModelAgent({
      provider: 'openai',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      reasoningEffort: 'high',
      prices: PRICES,
    });
    const reply = await agent.act(CTX);
    assert.equal(reply.text, '');
    assert.ok(reply.usage);
    assert.ok(reply.usage.costUsd !== null);
    assert.equal(reply.usage.inputTokens, 64);
    assert.equal(reply.usage.outputTokens, 4096);
    assert.ok(Math.abs(reply.usage.costUsd - (64 / 1e6) * 3 - (4096 / 1e6) * 15) < 1e-12);
    assert.equal(reply.meta.reasoningTokens, 4096);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// openai-chat (Google's Gemini OpenAI-compatible endpoint and other chat
// servers): reasoning_effort in the body; full-endpoint base URLs honored;
// the completion-usage details carry the reasoning breakdown.

test('openai-chat reasoningEffort reaches the wire as reasoning_effort', async () => {
  const stub = await scriptStub([chatTake()]);
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      reasoningEffort: 'medium',
    });
    await agent.act(CTX);
    assert.equal(stub.requests[0].body.reasoning_effort, 'medium');
    assert.equal(stub.requests[0].body.reasoning, undefined);

    const plain = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    await plain.act(CTX);
    assert.equal(stub.requests[1].body.reasoning_effort, undefined);
  } finally {
    await stub.close();
  }
});

test('openai-chat honors a base URL that already names the full chat-completions endpoint (Gemini), otherwise appends /v1/chat/completions', async () => {
  const stub = await scriptStub([chatTake(), chatTake()]);
  try {
    // A base URL ending in /chat/completions is used exactly as-is — Google's
    // Gemini endpoint is .../v1beta/openai/chat/completions and has no /v1/.
    const gemini = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: `${stub.url}/v1beta/openai/chat/completions`,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      reasoningEffort: 'high',
    });
    await gemini.act(CTX);
    assert.equal(stub.requests[0].url, '/v1beta/openai/chat/completions');
    assert.equal(stub.requests[0].body.reasoning_effort, 'high');

    // A server root still gets the documented /v1/chat/completions path.
    const plain = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    await plain.act(CTX);
    assert.equal(stub.requests[1].url, '/v1/chat/completions');
  } finally {
    await stub.close();
  }
});

test('openai-chat records the reasoning-token breakdown when the server reports one', async () => {
  const stub = await scriptStub([
    chatTake({ completion_tokens_details: { reasoning_tokens: 6 } }),
  ]);
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      reasoningEffort: 'low',
      prices: PRICES,
    });
    const reply = await agent.act(CTX);
    assert.equal(reply.meta.reasoningTokens, 6);
    // Cost follows the reported totals (completion_tokens 10, not 10 - 6).
    assert.ok(reply.usage);
    assert.ok(reply.usage.costUsd !== null);
    assert.equal(reply.usage.inputTokens, 88);
    assert.equal(reply.usage.outputTokens, 10);
    assert.ok(Math.abs(reply.usage.costUsd - (88 / 1e6) * 3 - (10 / 1e6) * 15) < 1e-12);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// Validation: settings that do not match the provider, out-of-range budgets
// and unknown effort values are loud errors at the agent layer.

test('createModelAgent rejects reasoning settings that do not match the provider', () => {
  assert.throws(
    () =>
      createModelAgent({
        provider: 'openai',
        model: 'stub-model',
        thinkingBudget: 1024,
      }),
    /thinkingBudget is the Anthropic extended-thinking setting and only applies to provider "anthropic"/
  );
  assert.throws(
    () =>
      createModelAgent({
        provider: 'openai-chat',
        model: 'stub-model',
        thinkingBudget: 1024,
      }),
    /only applies to provider "anthropic"/
  );
  assert.throws(
    () =>
      createModelAgent({
        provider: 'anthropic',
        model: 'stub-model',
        reasoningEffort: 'high',
      }),
    /reasoningEffort is the OpenAI reasoning setting and does not apply to provider "anthropic"/
  );
  assert.throws(
    () =>
      createModelAgent({
        provider: 'openai',
        model: 'stub-model',
        reasoningEffort: /** @type {*} */ ('extreme'),
      }),
    /reasoningEffort must be "low", "medium" or "high"/
  );
  assert.throws(
    () =>
      createModelAgent({
        provider: 'anthropic',
        model: 'stub-model',
        thinkingBudget: 1023,
      }),
    /thinkingBudget must be an integer >= 1024/
  );
  assert.throws(
    () =>
      createModelAgent({
        provider: 'anthropic',
        model: 'stub-model',
        thinkingBudget: 1024.5,
      }),
    /thinkingBudget must be an integer >= 1024/
  );
});

// ---------------------------------------------------------------------------
// Spec layer (cli/agents.js): the same pairing rules fire at parse time with
// the spec named in the message, dry-run stays rehearsal-only, and settings
// are part of the agent identity through a canonical suffix.

test('parseAgentSpec rejects mismatched reasoning settings, naming the spec', async () => {
  await assert.rejects(
    () => parseAgentSpec('model:openai/stub-model', { thinkingBudget: 1024 }),
    /agent spec "model:openai\/stub-model": thinking-budget only applies to provider "anthropic"/
  );
  await assert.rejects(
    () => parseAgentSpec('model:openai-chat/stub-model', { thinkingBudget: 1024 }),
    /thinking-budget only applies to provider "anthropic"/
  );
  await assert.rejects(
    () => parseAgentSpec('model:anthropic/stub-model', { reasoningEffort: 'high' }),
    /agent spec "model:anthropic\/stub-model": reasoning-effort does not apply to provider "anthropic"/
  );
  await assert.rejects(
    () => parseAgentSpec('baseline:tictactoe:greedy', { thinkingBudget: 1024 }),
    /takes no --dry-run, --script, --prices, --max-output-tokens, --call-timeout-ms, --thinking-budget or --reasoning-effort flags/
  );
});

test('parseAgentSpec rejects reasoning settings on a --dry-run rehearsal', async () => {
  await assert.rejects(
    () =>
      parseAgentSpec('model:anthropic/stub-model', {
        dryRun: true,
        thinkingBudget: 1024,
      }),
    /agent spec "model:anthropic\/stub-model": thinking-budget is a model-agent setting and cannot be combined with --dry-run/
  );
  await assert.rejects(
    () =>
      parseAgentSpec('model:openai/stub-model', {
        dryRun: true,
        reasoningEffort: 'high',
      }),
    /agent spec "model:openai\/stub-model": reasoning-effort is a model-agent setting and cannot be combined with --dry-run/
  );
});

test('a spec-suffix thinking-budget reaches the wire and the agent id keeps the suffix', async () => {
  const stub = await scriptStub([anthropicTake()]);
  try {
    const spec = await parseAgentSpec('model:anthropic/stub-model:thinking-budget=10240', {
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 64,
      prices: 'harness/prices.example.json',
    });
    const agent = await spec.createForEpisode(
      /** @type {*} */ ({ game: takeOrPass, tier: takeOrPass.spec.tiers[0], seed: 's', agentSeat: 0 })
    );
    assert.equal(agent.id, 'model:anthropic/stub-model:thinking-budget=10240');
    await /** @type {*} */ (agent).act(CTX);
    assert.deepEqual(stub.requests[0].body.thinking, { type: 'enabled', budget_tokens: 10240 });
    assert.equal(stub.requests[0].body.max_tokens, 64 + 10240);
  } finally {
    await stub.close();
  }
});

test('a spec-suffix reasoning-effort reaches the wire and the agent id keeps the suffix', async () => {
  const stub = await scriptStub([openaiTake()]);
  try {
    const spec = await parseAgentSpec('model:openai/stub-model:reasoning-effort=high', {
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    const agent = await spec.createForEpisode(
      /** @type {*} */ ({ game: takeOrPass, tier: takeOrPass.spec.tiers[0], seed: 's', agentSeat: 0 })
    );
    assert.equal(agent.id, 'model:openai/stub-model:reasoning-effort=high');
    await /** @type {*} */ (agent).act(CTX);
    assert.deepEqual(stub.requests[0].body.reasoning, { effort: 'high' });
  } finally {
    await stub.close();
  }
});

test('a suffix that does not match the settings grammar stays part of the model id (Ollama tags)', async () => {
  const stub = await scriptStub([chatTake()]);
  try {
    const spec = await parseAgentSpec('model:openai-chat/qwen2.5:7b', {
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    const agent = await spec.createForEpisode(
      /** @type {*} */ ({ game: takeOrPass, tier: takeOrPass.spec.tiers[0], seed: 's', agentSeat: 0 })
    );
    assert.equal(agent.id, 'model:openai-chat/qwen2.5:7b');
    await /** @type {*} */ (agent).act(CTX);
    assert.equal(stub.requests[0].body.model, 'qwen2.5:7b');
  } finally {
    await stub.close();
  }
});

test('flag-set settings get the canonical suffix in the agent id; suffix and flag conflict is an error', async () => {
  const stub = await scriptStub([anthropicTake()]);
  try {
    const spec = await parseAgentSpec('model:anthropic/stub-model', {
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      thinkingBudget: 2048,
    });
    const agent = await spec.createForEpisode(
      /** @type {*} */ ({ game: takeOrPass, tier: takeOrPass.spec.tiers[0], seed: 's', agentSeat: 0 })
    );
    assert.equal(agent.id, 'model:anthropic/stub-model:thinking-budget=2048');
    await assert.rejects(
      () =>
        parseAgentSpec('model:anthropic/stub-model:thinking-budget=2048', {
          thinkingBudget: 2048,
        }),
      /thinking-budget is set both in the spec suffix \(2048\) and with --thinking-budget \(2048\); use one or the other/
    );
    await assert.rejects(
      () =>
        parseAgentSpec('model:anthropic/stub-model:reasoning-effort=high', {
          reasoningEffort: 'low',
        }),
      /reasoning-effort is set both in the spec suffix \(high\) and with --reasoning-effort \(low\); use one or the other/
    );
  } finally {
    await stub.close();
  }
});

test('an out-of-range or duplicate spec-suffix setting is a loud parse error', async () => {
  await assert.rejects(
    () => parseAgentSpec('model:anthropic/stub-model:thinking-budget=512'),
    /agent spec "model:anthropic\/stub-model:thinking-budget=512": thinking-budget must be an integer >= 1024/
  );
  await assert.rejects(
    () => parseAgentSpec('model:anthropic/stub-model:thinking-budget=1024:thinking-budget=2048'),
    /conflicting duplicate "thinking-budget" settings suffix/
  );
});

// ---------------------------------------------------------------------------
// Provenance: run.json records the settings in limits and the agent's label
// carries the settings suffix, so the same model with different settings is a
// different leaderboard entry.

const RUN_SUITE = buildSuite([takeOrPass], { split: 'public' });
const RUN_GAMES = [takeOrPass];

test('run.json records thinkingBudget in limits and the agent label carries the settings suffix', { timeout: 60 * 1000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-reasoning-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const stub = await scriptStub([anthropicTake()]);
  t.after(() => stub.close());

  const pricesPath = join(dir, 'prices.json');
  await writeFile(pricesPath, JSON.stringify(PRICES, null, 2));

  const spec = await parseAgentSpec('model:anthropic/stub-model', {
    baseUrl: stub.url,
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
    maxOutputTokens: 64,
    thinkingBudget: 1024,
    prices: pricesPath,
  });
  const result = await runSuite({
    suite: RUN_SUITE,
    games: RUN_GAMES,
    outDir: dir,
    pricesPath,
    maxOutputTokens: 64,
    thinkingBudget: 1024,
    concurrency: 2,
    sleep: async () => {},
    agentFactory: () =>
      spec.createForEpisode(
        /** @type {*} */ ({ game: takeOrPass, tier: takeOrPass.spec.tiers[0], seed: 's', agentSeat: 0 })
      ),
  });

  assert.equal(result.run.counts.played, 2, 'both one-shot episodes completed');
  assert.equal(result.run.limits.maxOutputTokens, 64);
  assert.equal(result.run.limits.thinkingBudget, 1024);
  assert.equal(result.run.limits.reasoningEffort, null);
  assert.equal(result.run.agent?.id, 'model:anthropic/stub-model:thinking-budget=1024');
  assert.equal(result.run.agent?.model, 'stub-model');
});

test('run.json records reasoningEffort in limits and the agent label carries the settings suffix', { timeout: 60 * 1000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-reasoning-effort-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const stub = await scriptStub([openaiTake()]);
  t.after(() => stub.close());

  const pricesPath = join(dir, 'prices.json');
  await writeFile(pricesPath, JSON.stringify(PRICES, null, 2));

  const spec = await parseAgentSpec('model:openai/stub-model', {
    baseUrl: stub.url,
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
    reasoningEffort: 'medium',
    prices: pricesPath,
  });
  const result = await runSuite({
    suite: RUN_SUITE,
    games: RUN_GAMES,
    outDir: dir,
    pricesPath,
    reasoningEffort: 'medium',
    concurrency: 2,
    sleep: async () => {},
    agentFactory: () =>
      spec.createForEpisode(
        /** @type {*} */ ({ game: takeOrPass, tier: takeOrPass.spec.tiers[0], seed: 's', agentSeat: 0 })
      ),
  });

  assert.equal(result.run.counts.played, 2, 'both one-shot episodes completed');
  assert.equal(result.run.limits.reasoningEffort, 'medium');
  assert.equal(result.run.limits.thinkingBudget, null);
  assert.equal(result.run.agent?.id, 'model:openai/stub-model:reasoning-effort=medium');
});

// ---------------------------------------------------------------------------
// The dollar cap under concurrency with a thinking budget: the reservation's
// worst-case output is the wire max_tokens — the text cap plus the budget —
// so the thinking spend can never push realized spend past the cap.

const CAP_SUITE = buildSuite([takeOrPass, countdown], { split: 'public' });
const CAP_GAMES = [takeOrPass, countdown];
const CAP_PRICES = {
  'anthropic/cap-model': {
    inputPerMTok: 0,
    outputPerMTok: 5000,
    source: 'stub',
    checked: '2026-10-16',
  },
};

/**
 * The cap stub in the Anthropic shape: answers `take` with fixed usage after a
 * short hold and tracks the peak number of calls in flight.
 *
 * @returns {Promise<{ url: string, close: () => Promise<void>, maxInFlight: () => number }>}
 */
async function startCapStub() {
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
          model: 'cap-model',
          content: [{ type: 'text', text: 'take' }],
          stop_reason: 'end_turn',
          // Output totals at the wire max_tokens (5 text + 1024 budget), so
          // settled cost equals the reservation's worst case exactly.
          usage: { input_tokens: 100, output_tokens: 1029 },
        });
      }, 25);
    }
  );
  return { url: stub.url, close: stub.close, maxInFlight: () => maxInFlight };
}

for (let i = 1; i <= 5; i++) {
  test(
    `cap holds with a thinking budget at concurrency 4 (repeat ${i}/5): the reservation is cap + budget, exactly 3 admitted calls`,
    { timeout: 60 * 1000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'gauntlet-reasoning-cap-'));
      t.after(() => rm(dir, { recursive: true, force: true }));

      const stub = await startCapStub();
      t.after(() => stub.close());

      const pricesPath = join(dir, 'prices.json');
      await writeFile(pricesPath, JSON.stringify(CAP_PRICES, null, 2));

      const result = await runSuite({
        suite: CAP_SUITE,
        games: CAP_GAMES,
        outDir: dir,
        pricesPath,
        concurrency: 4,
        maxUsd: 20,
        agentFactory: () =>
          createModelAgent({
            provider: 'anthropic',
            model: 'cap-model',
            baseUrl: stub.url,
            apiKeyEnv: 'GAUNTLET_TEST_KEY',
            prices: CAP_PRICES,
            // The quote's input term is zero (inputPerMTok: 0) and the output
            // term is the wire max_tokens — the 5-token text cap plus the
            // 1024-token budget = 1029 x 5000 / 1e6 = $5.145 — which matches
            // the stub's settled output tokens exactly. A $20 cap admits
            // exactly 3 calls ($15.435) and refuses the 4th ($20.58).
            maxOutputTokens: 5,
            thinkingBudget: 1024,
            sleep: async () => {},
          }),
      });

      assert.equal(result.stopped, 'budget', 'the run stops on the budget cap');
      assert.equal(result.run.calls, 3, 'exactly three calls are admitted');
      assert.ok(
        Math.abs(result.run.spendUsd - 15.435) < 1e-9,
        `spend is exactly 3 x $5.145, got ${result.run.spendUsd}`
      );
      assert.ok(result.run.spendUsd <= 20 + 1e-9, 'realized spend never exceeds the cap');
      assert.equal(result.run.counts.played, 2, 'the two one-shot episodes completed');
      assert.equal(result.run.counts.unplayed, 8, 'the engine episodes stayed unplayed');
      assert.equal(result.run.counts.failed, 0, 'no episode failed');
      const maxInFlight = stub.maxInFlight();
      assert.ok(maxInFlight >= 2, `calls actually overlapped (max in flight: ${maxInFlight})`);
      assert.ok(maxInFlight <= 4, 'concurrency stays bounded by the worker count');
    }
  );
}

// ---------------------------------------------------------------------------
// CLI: the flags parse and pair-check before anything runs.

const gauntletRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(gauntletRoot, 'cli', 'gauntlet.js');

/**
 * Spawn the CLI and capture its combined output and exit code.
 *
 * @param {string[]} args
 * @returns {Promise<{ code: number, output: string }>}
 */
function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, output }));
  });
}

test('the CLI rejects --reasoning-effort with an unknown value before anything runs', { timeout: 30 * 1000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-reasoning-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const suiteFile = join(dir, 'suite.json');
  await writeFile(suiteFile, JSON.stringify(buildSuite([getGame('cube')], { split: 'public' }), null, 2) + '\n');

  const { code, output } = await runCli([
    'run',
    '--suite', suiteFile,
    '--agent', 'model:openai-chat/limits-model',
    '--base-url', 'http://127.0.0.1:1',
    '--out', join(dir, 'run'),
    '--reasoning-effort', 'extreme',
  ]);
  assert.notEqual(code, 0);
  assert.match(output, /--reasoning-effort must be low, medium or high/);
});

test('the CLI rejects --thinking-budget on a non-anthropic spec before anything runs', { timeout: 30 * 1000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gauntlet-reasoning-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const suiteFile = join(dir, 'suite.json');
  await writeFile(suiteFile, JSON.stringify(buildSuite([getGame('cube')], { split: 'public' }), null, 2) + '\n');

  const { code, output } = await runCli([
    'run',
    '--suite', suiteFile,
    '--agent', 'model:openai-chat/limits-model',
    '--base-url', 'http://127.0.0.1:1',
    '--out', join(dir, 'run'),
    '--thinking-budget', '1024',
  ]);
  assert.notEqual(code, 0);
  assert.match(output, /thinking-budget only applies to provider "anthropic"/);
});
