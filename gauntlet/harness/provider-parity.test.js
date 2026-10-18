/**
 * Provider-parity tests: the OpenAI (Responses) and Gemini-on-openai-chat
 * connections meet the same standard as the Anthropic connection — a per-model
 * capability table with doc URLs and check dates (unknown gpt-x and gemini-x
 * ids refused), per-row reasoning-effort enforcement, per-row default output caps,
 * a reply cut off by the output cap recorded as meta.truncated, and verified
 * prices found by the dollar cap.
 *
 * Offline: node:http stubs on 127.0.0.1 only, no SDKs, no paid calls.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createModelAgent } from './model-agent.js';
import { buildOfficialTurnMessage } from './official.js';
import { sendJson, startStubServer } from './stub-server.js';

// The openai/openai-chat clients read the key at call time; a dummy value
// keeps every request on the local stub (mirrors model-agent.test.js).
process.env.GAUNTLET_TEST_KEY = 'stub-key-parity';

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

/**
 * A recording stub that replies with one (status, payload) entry per request,
 * reusing the last entry once the script runs out.
 *
 * @param {Array<[number, *]>} script
 * @returns {Promise<{ url: string, requests: Array<*>, close: () => Promise<void> }>}
 */
async function parityStub(script) {
  /** @type {*} */
  const requests = [];
  const { url, close } = await startStubServer((req, res, body) => {
    requests.push({ method: req.method, url: req.url, body });
    const [status, payload] = script[Math.min(requests.length - 1, script.length - 1)];
    sendJson(res, status, payload);
  });
  return { url, requests, close };
}

const OPENAI_OK = /** @type {[number, *]} */ ([
  200,
  {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    model: 'stub-model',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I take a corner.\naction: a1' }],
      },
    ],
    usage: { input_tokens: 70, output_tokens: 6, total_tokens: 76 },
  },
]);

// A Responses reply cut off mid-reasoning by the output cap: status
// "incomplete", incomplete_details.reason "max_output_tokens", a reasoning
// item but no message item (https://platform.openai.com/docs/guides/reasoning,
// checked 2026-10-16).
const OPENAI_INCOMPLETE = /** @type {[number, *]} */ ([
  200,
  {
    id: 'resp_2',
    object: 'response',
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    model: 'gpt-6-astra',
    output: [{ type: 'reasoning', id: 'rs_1', summary: [] }],
    usage: {
      input_tokens: 70,
      output_tokens: 4096,
      output_tokens_details: { reasoning_tokens: 4090 },
      total_tokens: 4166,
    },
  },
]);

const CHAT_OK = /** @type {[number, *]} */ ([
  200,
  {
    id: 'chatcmpl_1',
    object: 'chat.completion',
    model: 'stub-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'I take an edge.\naction: b1' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 55, completion_tokens: 7, total_tokens: 62 },
  },
]);

// A chat-completions reply cut off by the output cap: finish_reason "length"
// (https://developers.openai.com/api/reference — chat completions
// finish_reason, checked 2026-10-16).
const CHAT_LENGTH = /** @type {[number, *]} */ ([
  200,
  {
    id: 'chatcmpl_2',
    object: 'chat.completion',
    model: 'gemini-4-argon',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '' },
        finish_reason: 'length',
      },
    ],
    usage: {
      prompt_tokens: 55,
      completion_tokens: 16384,
      completion_tokens_details: { reasoning_tokens: 16380 },
      total_tokens: 16439,
    },
  },
]);

test('openai: an untabled gpt-* id carrying settings is refused, naming the capability table; a plain request constructs', () => {
  // f05: the refusal is settings-dependent. A request with reasoningEffort or
  // a sampling field is refused with the table-naming message; the plain
  // request (no reasoningEffort, no sampling fields) is wire-valid on every
  // Responses-API model and constructs with the permissive default — the
  // documented openai/gpt-4o path.
  assert.throws(
    () =>
      createModelAgent({
        provider: 'openai',
        model: 'gpt-9-nova',
        baseUrl: 'http://127.0.0.1:1',
        apiKeyEnv: 'GAUNTLET_TEST_KEY',
        reasoningEffort: /** @type {'low' | 'medium' | 'high' | 'xhigh' | 'max'} */ ('high'),
      }),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /OpenAI capability table/);
      assert.match(err.message, /harness\/model-agent\.js/);
      assert.match(err.message, /platform\.openai\.com\/docs\/models/);
      return true;
    }
  );
  assert.doesNotThrow(() =>
    createModelAgent({
      provider: 'openai',
      model: 'gpt-9-nova',
      baseUrl: 'http://127.0.0.1:1',
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    })
  );
});

test('openai: gpt-6-astra accepts the documented effort levels up to max; reasoning.effort reaches the wire', async () => {
  const stub = await parityStub([OPENAI_OK]);
  try {
    const agent = createModelAgent({
      provider: 'openai',
      model: 'gpt-6-astra',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      reasoningEffort: /** @type {'low' | 'medium' | 'high' | 'xhigh' | 'max'} */ ('max'),
    });
    await agent.act(CTX);
    assert.deepEqual(stub.requests[0].body.reasoning, { effort: 'max' });
  } finally {
    await stub.close();
  }
});

test('openai: an effort level the model row does not document is refused per row', () => {
  // The gpt-5.1 row documents low/medium/high only.
  assert.throws(
    () =>
      createModelAgent({
        provider: 'openai',
        model: 'gpt-5.1',
        baseUrl: 'http://127.0.0.1:1',
        apiKeyEnv: 'GAUNTLET_TEST_KEY',
        reasoningEffort: /** @type {'low' | 'medium' | 'high' | 'xhigh' | 'max'} */ ('max'),
      }),
    /is not documented for model "gpt-5\.1".*the documented levels are "low", "medium", "high"/
  );
});

test('openai-chat: an unknown gemini-* id is refused, naming the capability table; other ids stay permissive', () => {
  assert.throws(
    () =>
      createModelAgent({
        provider: 'openai-chat',
        model: 'gemini-9-nova',
        baseUrl: 'http://127.0.0.1:1',
        apiKeyEnv: 'GAUNTLET_TEST_KEY',
      }),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /Gemini capability table/);
      assert.match(err.message, /harness\/model-agent\.js/);
      assert.match(err.message, /ai\.google\.dev/);
      return true;
    }
  );
  // Local-server ids are not Gemini ids: the permissive default keeps them.
  const agent = createModelAgent({
    provider: 'openai-chat',
    model: 'qwen2.5-1.5b-instruct',
    baseUrl: 'http://127.0.0.1:1',
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
  });
  assert.equal(agent.id, 'openai-chat/qwen2.5-1.5b-instruct');
});

test('openai-chat: gemini-4-argon takes reasoning_effort low/medium/high; xhigh is not documented for it and is refused', async () => {
  const stub = await parityStub([CHAT_OK]);
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'gemini-4-argon',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      reasoningEffort: 'high',
    });
    await agent.act(CTX);
    assert.equal(stub.requests[0].body.reasoning_effort, 'high');
  } finally {
    await stub.close();
  }
  // xhigh is refused: it is not in the openai-chat provider-level set (the
  // per-row table narrows but never widens it), and the per-row refusal is
  // demonstrated on provider "openai" above where the levels genuinely
  // differ between rows.
  assert.throws(
    () =>
      createModelAgent({
        provider: 'openai-chat',
        model: 'gemini-4-argon',
        baseUrl: 'http://127.0.0.1:1',
        apiKeyEnv: 'GAUNTLET_TEST_KEY',
        reasoningEffort: /** @type {'low' | 'medium' | 'high' | 'xhigh' | 'max'} */ ('xhigh'),
      }),
    /must be one of "low", "medium", "high", got "xhigh"/
  );
});

test('sampling: rows whose docs are silent keep the permissive default — temperature passes through on the tabled ids', async () => {
  const openai = await parityStub([OPENAI_OK]);
  try {
    const agent = createModelAgent({
      provider: 'openai',
      model: 'gpt-6-astra',
      baseUrl: openai.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      params: { temperature: 0.5 },
    });
    await agent.act(CTX);
    assert.equal(openai.requests[0].body.temperature, 0.5);
  } finally {
    await openai.close();
  }
  const chat = await parityStub([CHAT_OK]);
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'gemini-4-argon',
      baseUrl: chat.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      params: { top_p: 0.9 },
    });
    await agent.act(CTX);
    assert.equal(chat.requests[0].body.top_p, 0.9);
  } finally {
    await chat.close();
  }
});

test('openai: a reply cut off by the output cap (status "incomplete", reason max_output_tokens) records meta.truncated', async () => {
  const stub = await parityStub([OPENAI_INCOMPLETE]);
  try {
    const agent = createModelAgent({
      provider: 'openai',
      model: 'gpt-6-astra',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 4096,
    });
    const reply = await agent.act(CTX);
    // Cut off mid-reasoning: no message item, so the reply text is empty (an
    // invalid attempt for the runner) and the usage is recorded honestly.
    assert.equal(reply.text, '');
    assert.ok(reply.usage, 'usage must be recorded on a truncated reply');
    assert.equal(reply.usage.inputTokens, 70);
    assert.equal(reply.usage.outputTokens, 4096);
    assert.equal(reply.meta.reasoningTokens, 4090);
    assert.deepEqual(reply.meta.truncated, {
      stopReason: 'max_output_tokens',
      outputTokens: 4096,
    });
  } finally {
    await stub.close();
  }
});

test('openai: a completed response carries no truncated marker', async () => {
  const stub = await parityStub([OPENAI_OK]);
  try {
    const agent = createModelAgent({
      provider: 'openai',
      model: 'gpt-6-astra',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    const reply = await agent.act(CTX);
    assert.equal(reply.meta.truncated, undefined);
  } finally {
    await stub.close();
  }
});

test('openai-chat: a reply cut off by the output cap (finish_reason "length") records meta.truncated', async () => {
  const stub = await parityStub([CHAT_LENGTH]);
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'gemini-4-argon',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 16384,
    });
    const reply = await agent.act(CTX);
    assert.ok(reply.usage, 'usage must be recorded on a truncated reply');
    assert.equal(reply.usage.outputTokens, 16384);
    assert.equal(reply.meta.reasoningTokens, 16380);
    assert.deepEqual(reply.meta.truncated, {
      stopReason: 'length',
      outputTokens: 16384,
    });
  } finally {
    await stub.close();
  }
});

test('openai-chat: finish_reason "stop" carries no truncated marker', async () => {
  const stub = await parityStub([CHAT_OK]);
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'gemini-4-argon',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    const reply = await agent.act(CTX);
    assert.equal(reply.meta.truncated, undefined);
  } finally {
    await stub.close();
  }
});

test('reasoning rows default their output cap to 16384; untabled ids keep 4096', async () => {
  const openai = await parityStub([OPENAI_OK]);
  try {
    const astra = createModelAgent({
      provider: 'openai',
      model: 'gpt-6-astra',
      baseUrl: openai.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    await astra.act(CTX);
    assert.equal(openai.requests[0].body.max_output_tokens, 16384);
    const untabled = createModelAgent({
      provider: 'openai',
      model: 'stub-model',
      baseUrl: openai.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    await untabled.act(CTX);
    assert.equal(openai.requests[1].body.max_output_tokens, 4096);
  } finally {
    await openai.close();
  }
  const chat = await parityStub([CHAT_OK, CHAT_OK]);
  try {
    const argon = createModelAgent({
      provider: 'openai-chat',
      model: 'gemini-4-argon',
      baseUrl: chat.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    await argon.act(CTX);
    assert.equal(chat.requests[0].body.max_tokens, 16384);
    const untabled = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: chat.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    await untabled.act(CTX);
    assert.equal(chat.requests[1].body.max_tokens, 4096);
  } finally {
    await chat.close();
  }
});

test('an unset effort on a tabled id records the provider default in the identity, with the documented default exposed', () => {
  // GPT-6 Astra: effort levels documented, API default docs-silent.
  const astra = createModelAgent({
    provider: 'openai',
    model: 'gpt-6-astra',
    baseUrl: 'http://127.0.0.1:1',
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
  });
  assert.equal(astra.id, 'openai/gpt-6-astra:reasoning-effort=provider-default');
  assert.equal(
    /** @type {*} */ (astra).reasoningEffort,
    'provider-default'
  );
  assert.equal(/** @type {*} */ (astra).reasoningEffortDefault, null);
  // Gemini 4 Argon: the docs document the API default (medium).
  const argon = createModelAgent({
    provider: 'openai-chat',
    model: 'gemini-4-argon',
    baseUrl: 'http://127.0.0.1:1',
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
  });
  assert.equal(argon.id, 'openai-chat/gemini-4-argon:reasoning-effort=provider-default');
  assert.equal(
    /** @type {*} */ (argon).reasoningEffort,
    'provider-default'
  );
  assert.equal(/** @type {*} */ (argon).reasoningEffortDefault, 'medium');
  // Untabled ids keep the plain identity: no effort suffix, no recorded default.
  const untabled = createModelAgent({
    provider: 'openai-chat',
    model: 'qwen2.5-1.5b-instruct',
    baseUrl: 'http://127.0.0.1:1',
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
  });
  assert.equal(untabled.id, 'openai-chat/qwen2.5-1.5b-instruct');
  assert.equal(/** @type {*} */ (untabled).reasoningEffort, undefined);
});

test('prices.example.json rates the release-board models with sources and check dates, and the dollar cap finds them at the row default cap', async () => {
  const prices = JSON.parse(
    readFileSync(new URL('./prices.example.json', import.meta.url), 'utf8')
  );
  const astraEntry = prices['openai/gpt-6-astra'];
  assert.ok(astraEntry, 'prices.example.json must carry openai/gpt-6-astra');
  assert.equal(astraEntry.inputPerMTok, 10);
  assert.equal(astraEntry.outputPerMTok, 50);
  assert.match(astraEntry.source, /openai\.com/);
  assert.equal(astraEntry.checked, '2026-10-16');
  const argonEntry = prices['openai-chat/gemini-4-argon'];
  assert.ok(argonEntry, 'prices.example.json must carry openai-chat/gemini-4-argon');
  assert.equal(argonEntry.inputPerMTok, 2);
  assert.equal(argonEntry.outputPerMTok, 10);
  assert.match(argonEntry.source, /ai\.google\.dev/);
  assert.equal(argonEntry.checked, '2026-10-16');

  // The --max-usd reservation quotes the wire output limit as the worst case.
  // On the tabled rows that limit is the row default cap (16384), so the quote
  // at the row default — not the legacy 4096 — is what a priced run reserves.
  const requestBytes = new TextEncoder().encode(
    buildOfficialTurnMessage(CTX, null)
  ).length;
  const astra = createModelAgent({
    provider: 'openai',
    model: 'gpt-6-astra',
    baseUrl: 'http://127.0.0.1:1',
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
    prices,
  });
  const astraQuote = /** @type {*} */ (astra).quoteWorstCaseUsd(CTX);
  assert.ok(astraQuote !== null && Number.isFinite(astraQuote));
  const astraExpected =
    ((requestBytes / 2) * 10 + 16384 * 50) / 1_000_000;
  assert.ok(Math.abs(astraQuote - astraExpected) < 1e-12);

  const argon = createModelAgent({
    provider: 'openai-chat',
    model: 'gemini-4-argon',
    baseUrl: 'http://127.0.0.1:1',
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
    prices,
  });
  const argonQuote = /** @type {*} */ (argon).quoteWorstCaseUsd(CTX);
  assert.ok(argonQuote !== null && Number.isFinite(argonQuote));
  const argonExpected =
    ((requestBytes / 2) * 2 + 16384 * 10) / 1_000_000;
  assert.ok(Math.abs(argonQuote - argonExpected) < 1e-12);

  // The settled cost follows the provider's reported usage at the file's rates.
  const stub = await parityStub([OPENAI_OK]);
  try {
    const agent = createModelAgent({
      provider: 'openai',
      model: 'gpt-6-astra',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      prices,
    });
    const reply = await agent.act(CTX);
    const expectedCost = (70 * 10 + 6 * 50) / 1_000_000;
    assert.ok(reply.usage, 'usage must be recorded on a settled reply');
    assert.ok(reply.usage.costUsd !== null);
    assert.ok(Math.abs(/** @type {number} */ (reply.usage.costUsd) - expectedCost) < 1e-12);
  } finally {
    await stub.close();
  }
});
