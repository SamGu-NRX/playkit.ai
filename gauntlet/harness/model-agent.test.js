/**
 * Tests for the model agents against local stub servers. Offline: node:http on
 * 127.0.0.1 only, no SDKs, no paid calls.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createModelAgent } from './model-agent.js';
import { OFFICIAL_SYSTEM_PROMPT } from './official.js';
import { sendJson, startStubServer } from './stub-server.js';
import { runEpisode } from '../core/runner.js';
import { verifyTrajectory } from '../core/trajectory.js';
import tictactoe from '../games/tictactoe/index.js';

const RULES = 'RULES TEXT for the stub game.';
const OBS = 'OBSERVATION TEXT';

// The clients read the key at call time; a dummy value keeps every request on
// the local stub. The missing-key test deletes and restores its own variable.
process.env.GAUNTLET_TEST_KEY = 'stub-key-anthropic';

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
 * An Anthropic Messages stub that records requests and replies from a script
 * of (status, payload) pairs, reusing the last entry once the script runs out.
 *
 * @param {Array<[number, *]>} script
 * @returns {Promise<{ url: string, requests: *, close: () => Promise<void> }>}
 */
async function anthropicStub(script) {
  /** @type {*} */
  const requests = [];
  const { url, close } = await startStubServer((req, res, body) => {
    requests.push({
      method: req.method,
      url: req.url,
      apiKey: req.headers['x-api-key'],
      version: req.headers['anthropic-version'],
      body,
    });
    const [status, payload] = script[Math.min(requests.length - 1, script.length - 1)];
    sendJson(res, status, payload);
  });
  return { url, requests, close };
}

/**
 * An OpenAI Responses stub, same contract.
 *
 * @param {Array<[number, *]>} script
 */
async function openaiStub(script) {
  /** @type {*} */
  const requests = [];
  const { url, close } = await startStubServer((req, res, body) => {
    requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body,
    });
    const [status, payload] = script[Math.min(requests.length - 1, script.length - 1)];
    sendJson(res, status, payload);
  });
  return { url, requests, close };
}

const ANTHROPIC_OK = /** @type {[number, *]} */ ([
  200,
  {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'stub-model',
    content: [{ type: 'text', text: 'I play the center.\naction: b2' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 120, output_tokens: 8 },
  },
]);

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

test('anthropic agent sends the verbatim system prompt, one user message, and the auth header', async () => {
  const stub = await anthropicStub([ANTHROPIC_OK]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 64,
    });
    const reply = await agent.act(CTX);
    assert.equal(stub.requests.length, 1);
    const req = stub.requests[0];
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.apiKey, 'stub-key-anthropic');
    assert.equal(req.version, '2023-06-01');
    assert.equal(req.body.system, OFFICIAL_SYSTEM_PROMPT);
    assert.deepEqual(req.body.messages, [
      {
        role: 'user',
        content: [
          RULES,
          'Your previous reply:\n(none)',
          'Current state:\nOBSERVATION TEXT',
        ].join('\n\n'),
      },
    ]);
    assert.equal(req.body.model, 'stub-model');
    assert.equal(req.body.max_tokens, 64);
    assert.equal(reply.text, 'I play the center.\naction: b2');
    assert.equal(reply.meta.retries, 0);
  } finally {
    await stub.close();
  }
});

test('openai agent sends instructions + input and a bearer auth header', async () => {
  const stub = await openaiStub([OPENAI_OK]);
  try {
    const agent = createModelAgent({
      provider: 'openai',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    const reply = await agent.act(CTX);
    assert.equal(stub.requests.length, 1);
    const req = stub.requests[0];
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.auth, 'Bearer stub-key-anthropic');
    assert.equal(req.body.instructions, OFFICIAL_SYSTEM_PROMPT);
    assert.equal(
      req.body.input,
      [RULES, 'Your previous reply:\n(none)', 'Current state:\nOBSERVATION TEXT'].join('\n\n')
    );
    assert.equal(req.body.model, 'stub-model');
    assert.equal(reply.text, 'I take a corner.\naction: a1');
  } finally {
    await stub.close();
  }
});

test('an untabled gpt-* id with default settings constructs and posts (the documented openai/gpt-4o path)', async () => {
  const stub = await openaiStub([OPENAI_OK]);
  try {
    const agent = createModelAgent({
      provider: 'openai',
      model: 'gpt-4o',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    const reply = await agent.act(CTX);
    assert.equal(stub.requests.length, 1);
    const req = stub.requests[0];
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.body.model, 'gpt-4o');
    assert.ok(!('reasoning' in req.body), 'a plain request carries no reasoning field');
    assert.equal(reply.text, 'I take a corner.\naction: a1');
  } finally {
    await stub.close();
  }
});

test('an untabled gpt-* id carrying reasoningEffort is refused, naming the OpenAI capability table', async () => {
  const stub = await openaiStub([OPENAI_OK]);
  try {
    assert.throws(
      () =>
        createModelAgent({
          provider: 'openai',
          model: 'gpt-9-nova',
          baseUrl: stub.url,
          apiKeyEnv: 'GAUNTLET_TEST_KEY',
          reasoningEffort: /** @type {'low' | 'medium' | 'high' | 'xhigh' | 'max'} */ ('high'),
        }),
      (/** @type {Error} */ err) => {
        assert.match(err.message, /matches no row in the OpenAI capability table/);
        return true;
      }
    );
    assert.equal(stub.requests.length, 0, 'refused at construction: the stub saw zero requests');
  } finally {
    await stub.close();
  }
});

test('an untabled gpt-* id carrying a sampling param is refused', async () => {
  const stub = await openaiStub([OPENAI_OK]);
  try {
    assert.throws(
      () =>
        createModelAgent({
          provider: 'openai',
          model: 'gpt-9-nova',
          baseUrl: stub.url,
          apiKeyEnv: 'GAUNTLET_TEST_KEY',
          params: { temperature: 0.5 },
        }),
      (/** @type {Error} */ err) => {
        assert.match(err.message, /matches no row in the OpenAI capability table/);
        return true;
      }
    );
    assert.equal(stub.requests.length, 0, 'refused at construction: the stub saw zero requests');
  } finally {
    await stub.close();
  }
});

test('the previous reply and invalid feedback are carried into the next message', async () => {
  const stub = await anthropicStub([
    ANTHROPIC_OK,
    [
      200,
      {
        ...ANTHROPIC_OK[1],
        content: [{ type: 'text', text: 'action: c3' }],
        usage: { input_tokens: 150, output_tokens: 3 },
      },
    ],
  ]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    await agent.act(CTX);
    const reply2 = await agent.act({
      ...CTX,
      turn: 1,
      feedback: 'cell b2 is occupied',
    });
    assert.equal(reply2.text, 'action: c3');
    const secondMessage = stub.requests[1].body.messages[0].content;
    assert.ok(secondMessage.includes('Your previous reply:\nI play the center.\naction: b2'));
    assert.ok(secondMessage.includes('Feedback on your previous reply: cell b2 is occupied'));
    const feedbackIndex = secondMessage.indexOf('Feedback on your previous reply:');
    const stateIndex = secondMessage.indexOf('Current state:');
    assert.ok(feedbackIndex > -1 && feedbackIndex < stateIndex);
  } finally {
    await stub.close();
  }
});

test('usage maps from the provider shape and costUsd is null without prices', async () => {
  const stub = await anthropicStub([ANTHROPIC_OK]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    const reply = await agent.act(CTX);
    assert.deepEqual(reply.usage, {
      inputTokens: 120,
      outputTokens: 8,
      costUsd: null,
    });
  } finally {
    await stub.close();
  }
});

test('the agent exposes its effective output cap for wrapper quotes', () => {
  // The assisted wrapper (community/assisted-agent.js) bounds a retry's
  // request growth with the inner agent's cap when it prices the turn's
  // worst case — the cap must be readable off the agent object, like
  // reasoningEffort.
  const agent = createModelAgent({
    provider: 'anthropic',
    model: 'stub-model',
    baseUrl: 'http://127.0.0.1:1/unreachable',
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
    maxOutputTokens: 64,
  });
  assert.equal(agent.maxOutputTokens, 64);
});

test('costUsd comes only from the caller-supplied prices file', async () => {
  const stub = await anthropicStub([ANTHROPIC_OK]);
  try {
    const priced = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      prices: {
        'anthropic/stub-model': {
          inputPerMTok: 3,
          outputPerMTok: 15,
          source: 'https://example.com/pricing',
          checked: '2026-10-15',
        },
      },
    });
    const reply = await priced.act(CTX);
    assert.ok(reply.usage);
    assert.ok(reply.usage.costUsd !== null);
    // 120/1e6*3 + 8/1e6*15 = 0.00036 + 0.00012
    assert.ok(Math.abs(reply.usage.costUsd - 0.00048) < 1e-12);

    const unpricedModel = createModelAgent({
      provider: 'anthropic',
      model: 'other-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      prices: {
        'anthropic/stub-model': {
          inputPerMTok: 3,
          outputPerMTok: 15,
          source: 'x',
          checked: '2026-10-15',
        },
      },
    });
    const reply2 = await unpricedModel.act(CTX);
    assert.ok(reply2.usage);
    assert.equal(reply2.usage.costUsd, null);
  } finally {
    await stub.close();
  }
});

test('retries a 500 and succeeds; the retry shows up in meta, not in the action stream', async () => {
  const stub = await anthropicStub(
    /** @type {Array<[number, *]>} */ ([
      [500, { type: 'error', error: { type: 'api_error', message: 'overloaded' } }],
      ANTHROPIC_OK,
    ])
  );
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      retryBaseDelayMs: 1,
    });
    const reply = await agent.act(CTX);
    assert.equal(reply.text, 'I play the center.\naction: b2');
    assert.equal(reply.meta.retries, 1);
    assert.equal(stub.requests.length, 2);
  } finally {
    await stub.close();
  }
});

test('gives up after 3 retries on a persistent 500 and says so', async () => {
  const stub = await anthropicStub(
    /** @type {Array<[number, *]>} */ ([[500, { type: 'error', error: { message: 'still broken' } }]])
  );
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      retryBaseDelayMs: 1,
    });
    await assert.rejects(
      () => agent.act(CTX),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /HTTP 500/);
        assert.match(err.message, /after 3 retries/);
        return true;
      }
    );
    assert.equal(stub.requests.length, 4); // 1 attempt + 3 retries
  } finally {
    await stub.close();
  }
});

test('a network failure retries and can succeed', async () => {
  const stub = await anthropicStub([ANTHROPIC_OK]);
  try {
    let calls = 0;
    const flaky = /** @type {typeof fetch} */ (async (url, init) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('ECONNRESET');
      }
      return fetch(url, init);
    });
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      fetchImpl: flaky,
      retryBaseDelayMs: 1,
    });
    const reply = await agent.act(CTX);
    assert.equal(reply.text, 'I play the center.\naction: b2');
    assert.equal(reply.meta.retries, 1);
  } finally {
    await stub.close();
  }
});

test('a 400 fails immediately with an excerpt of the response body', async () => {
  const body = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'max_tokens: Field required — the stub rejected the request',
    },
  };
  const stub = await anthropicStub(/** @type {Array<[number, *]>} */ ([[400, body]]));
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      retryBaseDelayMs: 1,
    });
    await assert.rejects(
      () => agent.act(CTX),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /HTTP 400/);
        assert.match(err.message, /max_tokens: Field required/);
        return true;
      }
    );
    assert.equal(stub.requests.length, 1); // no retry on a 4xx
  } finally {
    await stub.close();
  }
});

test('a missing API key throws naming the environment variable, before any request', async () => {
  const stub = await anthropicStub([ANTHROPIC_OK]);
  try {
    const missing = 'GAUNTLET_TEST_DEFINITELY_MISSING_KEY';
    delete process.env[missing];
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: missing,
    });
    await assert.rejects(
      () => agent.act(CTX),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes(missing));
        assert.ok(!err.message.includes('stub-key'));
        return true;
      }
    );
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

test('long error bodies are truncated in the message', async () => {
  const stub = await anthropicStub(
    /** @type {Array<[number, *]>} */ ([[400, { error: { message: 'x'.repeat(2000) } }]])
  );
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    await assert.rejects(
      () => agent.act(CTX),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.length < 700);
        assert.ok(err.message.includes('…'));
        return true;
      }
    );
  } finally {
    await stub.close();
  }
});

test('createModelAgent rejects unknown providers and empty models', () => {
  assert.throws(
    () => createModelAgent({ provider: /** @type {*} */ ('gemini'), model: 'x' }),
    /provider must be/
  );
  assert.throws(() => createModelAgent({ provider: 'openai', model: '' }), /model is required/);
});

// ---------------------------------------------------------------------------
// openai-chat: OpenAI-compatible chat-completions (llama.cpp, Ollama, vLLM,
// other labs' gateways). Same local-stub discipline: 127.0.0.1 only.

/**
 * A chat-completions stub, same contract as openaiStub.
 *
 * @param {Array<[number, *]>} script
 */
async function chatStub(script) {
  /** @type {*} */
  const requests = [];
  const { url, close } = await startStubServer((req, res, body) => {
    requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body,
    });
    const [status, payload] = script[Math.min(requests.length - 1, script.length - 1)];
    sendJson(res, status, payload);
  });
  return { url, requests, close };
}

const CHAT_OK = /** @type {[number, *]} */ ([
  200,
  {
    id: 'chatcmpl_1',
    object: 'chat.completion',
    model: 'stub-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Center is strongest.\naction: b2' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 88, completion_tokens: 9, total_tokens: 97 },
  },
]);

test('openai-chat agent posts the official system+user messages to /v1/chat/completions and maps usage', async () => {
  const stub = await chatStub([CHAT_OK]);
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 64,
    });
    const reply = await agent.act(CTX);
    assert.equal(stub.requests.length, 1);
    const req = stub.requests[0];
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.auth, 'Bearer stub-key-anthropic');
    assert.deepEqual(req.body.messages, [
      { role: 'system', content: OFFICIAL_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          RULES,
          'Your previous reply:\n(none)',
          'Current state:\nOBSERVATION TEXT',
        ].join('\n\n'),
      },
    ]);
    assert.equal(req.body.model, 'stub-model');
    assert.equal(req.body.max_tokens, 64);
    assert.equal(reply.text, 'Center is strongest.\naction: b2');
    assert.deepEqual(reply.usage, { inputTokens: 88, outputTokens: 9, costUsd: null });
    assert.equal(reply.meta.retries, 0);
  } finally {
    await stub.close();
  }
});

test('openai-chat sends no auth header when the key environment variable is unset', async () => {
  const stub = await chatStub([CHAT_OK]);
  const unset = 'GAUNTLET_TEST_DEFINITELY_UNSET_KEY';
  delete process.env[unset];
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: unset,
    });
    const reply = await agent.act(CTX);
    assert.equal(stub.requests[0].auth, undefined);
    assert.equal(reply.text, 'Center is strongest.\naction: b2');
  } finally {
    await stub.close();
  }
});

test('openai-chat keeps separately delivered reasoning out of the reply and records only its length', async () => {
  const reasoningContent = 'Take the center before any corner.';
  const contentStub = await chatStub([
    [
      200,
      {
        ...CHAT_OK[1],
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'action: b2',
              reasoning_content: reasoningContent,
            },
            finish_reason: 'stop',
          },
        ],
      },
    ],
  ]);
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: contentStub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    const reply = await agent.act(CTX);
    assert.equal(reply.text, 'action: b2');
    assert.ok(!reply.text.includes('center'));
    assert.equal(reply.meta.reasoningChars, reasoningContent.length);
  } finally {
    await contentStub.close();
  }

  // Some servers use message.reasoning instead of message.reasoning_content.
  const reasoningField = 'Occupied cells are invalid; block the diagonal.';
  const fieldStub = await chatStub([
    [
      200,
      {
        ...CHAT_OK[1],
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'action: a1',
              reasoning: reasoningField,
            },
            finish_reason: 'stop',
          },
        ],
      },
    ],
  ]);
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: fieldStub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    const reply = await agent.act(CTX);
    assert.equal(reply.text, 'action: a1');
    assert.ok(!reply.text.includes('diagonal'));
    assert.equal(reply.meta.reasoningChars, reasoningField.length);
  } finally {
    await fieldStub.close();
  }
});

test('openai-chat treats null content as an empty reply, not a transport failure', async () => {
  const stub = await chatStub([
    [
      200,
      {
        ...CHAT_OK[1],
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null },
            finish_reason: 'stop',
          },
        ],
      },
    ],
  ]);
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    const reply = await agent.act(CTX);
    assert.equal(stub.requests.length, 1); // no retry: the runner counts an invalid attempt
    assert.equal(reply.text, '');
    assert.equal(reply.meta.reasoningChars, 0);
    assert.deepEqual(reply.usage, { inputTokens: 88, outputTokens: 9, costUsd: null });
  } finally {
    await stub.close();
  }
});

test('openai-chat costUsd is 0 only with an explicit zero-rate price entry', async () => {
  const stub = await chatStub([CHAT_OK, CHAT_OK]);
  try {
    const zeroRates = {
      'openai-chat/stub-model': {
        inputPerMTok: 0,
        outputPerMTok: 0,
        source: 'local server, no charge',
        checked: '2026-10-15',
      },
    };
    const free = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      prices: zeroRates,
    });
    const freeReply = await free.act(CTX);
    assert.equal(freeReply.usage?.costUsd, 0);

    const unpriced = createModelAgent({
      provider: 'openai-chat',
      model: 'other-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      prices: zeroRates,
    });
    const unpricedReply = await unpriced.act(CTX);
    assert.equal(unpricedReply.usage?.costUsd, null);
  } finally {
    await stub.close();
  }
});

test('openai-chat retries a 500 and then succeeds', async () => {
  const stub = await chatStub([[500, { error: { message: 'model is loading' } }], CHAT_OK]);
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      retryBaseDelayMs: 1,
    });
    const reply = await agent.act(CTX);
    assert.equal(stub.requests.length, 2);
    assert.equal(reply.meta.retries, 1);
    assert.equal(reply.text, 'Center is strongest.\naction: b2');
  } finally {
    await stub.close();
  }
});

test('openai-chat fails at once on a 4xx, with the response body excerpt', async () => {
  const stub = await chatStub([[400, { error: { message: 'max_tokens is too large' } }]]);
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      retryBaseDelayMs: 1,
    });
    await assert.rejects(agent.act(CTX), /HTTP 400.*max_tokens is too large/s);
    assert.equal(stub.requests.length, 1); // no retry on a 4xx
  } finally {
    await stub.close();
  }
});

test('openai-chat requires the baseUrl option and names it in the error', () => {
  assert.throws(
    () => createModelAgent({ provider: 'openai-chat', model: 'stub-model' }),
    /baseUrl/
  );
});

// ---------------------------------------------------------------------------
// Usage honesty: a provider that does not report a token count records null,
// never 0, so a priced run cannot mistake unreported usage for a measured
// spend of zero. Retry failures carry the retry count they performed.

const PRICES_ONE_ENTRY = {
  'anthropic/stub-model': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    source: 'https://example.com/pricing',
    checked: '2026-10-15',
  },
  'openai/stub-model': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    source: 'https://example.com/pricing',
    checked: '2026-10-15',
  },
  'openai-chat/stub-model': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    source: 'https://example.com/pricing',
    checked: '2026-10-15',
  },
};

test('anthropic: usage omitted records null tokens and a null cost even with a price file', async () => {
  const stub = await anthropicStub([
    [200, { ...ANTHROPIC_OK[1], usage: undefined }],
  ]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      prices: PRICES_ONE_ENTRY,
    });
    const reply = await agent.act(CTX);
    assert.deepEqual(reply.usage, {
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  } finally {
    await stub.close();
  }
});

test('anthropic: a reported 0 stays 0 (never read as unreported)', async () => {
  const stub = await anthropicStub([
    [200, { ...ANTHROPIC_OK[1], usage: { input_tokens: 0, output_tokens: 0 } }],
  ]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      prices: PRICES_ONE_ENTRY,
    });
    const reply = await agent.act(CTX);
    assert.deepEqual(reply.usage, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  } finally {
    await stub.close();
  }
});

test('openai: usage omitted records null tokens and a null cost even with a price file', async () => {
  const stub = await openaiStub([[200, { ...OPENAI_OK[1], usage: undefined }]]);
  try {
    const agent = createModelAgent({
      provider: 'openai',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      prices: PRICES_ONE_ENTRY,
    });
    const reply = await agent.act(CTX);
    assert.deepEqual(reply.usage, {
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  } finally {
    await stub.close();
  }
});

test('openai: a reported 0 stays 0 (never read as unreported)', async () => {
  const stub = await openaiStub([
    [200, { ...OPENAI_OK[1], usage: { input_tokens: 0, output_tokens: 0 } }],
  ]);
  try {
    const agent = createModelAgent({
      provider: 'openai',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      prices: PRICES_ONE_ENTRY,
    });
    const reply = await agent.act(CTX);
    assert.deepEqual(reply.usage, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  } finally {
    await stub.close();
  }
});

test('openai-chat: usage omitted records null tokens and a null cost even with a price file', async () => {
  const stub = await chatStub([[200, { ...CHAT_OK[1], usage: undefined }]]);
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      prices: PRICES_ONE_ENTRY,
    });
    const reply = await agent.act(CTX);
    assert.deepEqual(reply.usage, {
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  } finally {
    await stub.close();
  }
});

test('openai-chat: a reported 0 stays 0 (never read as unreported)', async () => {
  const stub = await chatStub([
    [200, { ...CHAT_OK[1], usage: { prompt_tokens: 0, completion_tokens: 0 } }],
  ]);
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      prices: PRICES_ONE_ENTRY,
    });
    const reply = await agent.act(CTX);
    assert.deepEqual(reply.usage, {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  } finally {
    await stub.close();
  }
});

test('a 200 with an HTML body fails naming the provider and status, without retrying (anthropic)', async () => {
  /** @type {*} */
  const requests = [];
  const { url, close } = await startStubServer((req, res) => {
    requests.push({ url: req.url });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!DOCTYPE html><html><body>login page from a misbehaving proxy</body></html>');
  });
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      retryBaseDelayMs: 1,
    });
    await assert.rejects(
      () => agent.act(CTX),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          /model agent: anthropic returned an unparseable 2xx body \(HTTP 200\): <!DOCTYPE html>/
        );
        assert.equal(/** @type {*} */ (err).retries, 0);
        return true;
      }
    );
    assert.equal(requests.length, 1); // not retried: a 2xx answer is final
  } finally {
    await close();
  }
});

test('a 200 with an HTML body fails naming the provider and status, without retrying (openai-chat)', async () => {
  /** @type {*} */
  const requests = [];
  const { url, close } = await startStubServer((req, res) => {
    requests.push({ url: req.url });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>gateway error page, not JSON</html>');
  });
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: url,
      retryBaseDelayMs: 1,
    });
    await assert.rejects(
      () => agent.act(CTX),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          /model agent: openai-chat returned an unparseable 2xx body \(HTTP 200\): <html>/
        );
        assert.equal(/** @type {*} */ (err).retries, 0);
        return true;
      }
    );
    assert.equal(requests.length, 1);
  } finally {
    await close();
  }
});

test('an empty 2xx body fails with the same named error, without retrying', async () => {
  const { url, close } = await startStubServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('');
  });
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      retryBaseDelayMs: 1,
    });
    await assert.rejects(
      () => agent.act(CTX),
      /model agent: anthropic returned an unparseable 2xx body \(HTTP 200\): \(empty body\)/
    );
  } finally {
    await close();
  }
});

test('503 until retries run out: the error carries retries equal to maxRetries', async () => {
  const stub = await anthropicStub(
    /** @type {Array<[number, *]>} */ ([[503, { type: 'error', error: { message: 'overloaded' } }]])
  );
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxRetries: 2,
      retryBaseDelayMs: 1,
    });
    await assert.rejects(
      () => agent.act(CTX),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /HTTP 503 after 2 retries/);
        assert.equal(/** @type {*} */ (err).retries, 2);
        return true;
      }
    );
    assert.equal(stub.requests.length, 3); // 1 attempt + 2 retries
  } finally {
    await stub.close();
  }
});

test('a non-retryable 4xx on the first answer carries retries 0', async () => {
  const stub = await anthropicStub(
    /** @type {Array<[number, *]>} */ ([[401, { error: { message: 'bad key' } }]])
  );
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      retryBaseDelayMs: 1,
    });
    await assert.rejects(
      () => agent.act(CTX),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /HTTP 401/);
        assert.equal(/** @type {*} */ (err).retries, 0);
        return true;
      }
    );
    assert.equal(stub.requests.length, 1);
  } finally {
    await stub.close();
  }
});

test('a network failure after exhausting retries carries the retry count', async () => {
  const alwaysDown = /** @type {typeof fetch} */ (async () => {
    throw new Error('ECONNREFUSED');
  });
  const agent = createModelAgent({
    provider: 'anthropic',
    model: 'stub-model',
    baseUrl: 'http://127.0.0.1:1',
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
    maxRetries: 1,
    retryBaseDelayMs: 1,
    fetchImpl: alwaysDown,
  });
  await assert.rejects(
    () => agent.act(CTX),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /model agent: anthropic request failed after 1 retry/);
      assert.equal(/** @type {*} */ (err).retries, 1);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// End to end: an omitting provider records null usage on every trajectory step
// and the episode still verifies (offline, 127.0.0.1 only).

test('end to end: a provider that omits usage records null usage on every step and the trajectory verifies', async () => {
  /** @type {*} */
  const requests = [];
  const { url, close } = await startStubServer((req, res, body) => {
    requests.push(body);
    const text = /** @type {string} */ (
      body?.messages?.[body?.messages?.length - 1]?.content
    );
    const match = /Legal actions \(\d+, at most 64 so all are listed\): ([a-z0-9, ]+)/.exec(
      String(text)
    );
    if (!match) {
      sendJson(res, 400, { error: { message: 'stub could not find legal actions' } });
      return;
    }
    // No `usage` field anywhere in the reply — the case the dollar cap has to
    // refuse rather than bill at $0.
    sendJson(res, 200, {
      id: `chatcmpl_${requests.length}`,
      object: 'chat.completion',
      model: 'stub-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: `action: ${match[1].split(',')[0].trim()}` },
          finish_reason: 'stop',
        },
      ],
    });
  });
  try {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: 'stub-model',
      baseUrl: url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      // A price file is present: with honest usage the cost must still be null,
      // not 0, so a maxUsd cap refuses instead of counting the episode as free.
      prices: {
        'openai-chat/stub-model': PRICES_ONE_ENTRY['openai-chat/stub-model'],
      },
    });
    const trajectory = await runEpisode({
      game: tictactoe,
      tierId: 'perfect-opponent',
      seed: 'tictactoe/perfect-opponent/public/0',
      agent,
    });
    assert.equal(trajectory.end.reason, 'terminal');
    const agentSteps = trajectory.steps.filter((s) => s.by === 'agent');
    assert.ok(agentSteps.length >= 3);
    for (const step of agentSteps) {
      assert.deepEqual(step.usage, {
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      });
    }
    const verdict = await verifyTrajectory(tictactoe, trajectory);
    assert.deepEqual(verdict, { ok: true });
  } finally {
    await close();
  }
});

// Effort is the Messages API field output_config.effort, not a top-level
// `effort`; the per-model capability table (frontier-effort.test.js) decides
// which models take which levels, and claude-opus-4-5 documents none.
test('provider anthropic sends reasoningEffort as output_config.effort', async () => {
  const stub = await anthropicStub([ANTHROPIC_OK]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      reasoningEffort: 'xhigh',
    });
    const reply = await agent.act(CTX);
    assert.equal(reply.text, 'I play the center.\naction: b2');
    assert.deepEqual(stub.requests[0].body.output_config, { effort: 'xhigh' });
    assert.equal(stub.requests[0].body.effort, undefined);
  } finally {
    await stub.close();
  }
});

test('thinkingBudget and reasoningEffort together are refused on anthropic', () => {
  assert.throws(
    () =>
      createModelAgent({
        provider: 'anthropic',
        model: 'claude-opus-4-5',
        apiKeyEnv: 'GAUNTLET_TEST_KEY',
        thinkingBudget: 1024,
        reasoningEffort: 'high',
      }),
    /both steer Anthropic thinking/
  );
});

test('params.thinking cannot reintroduce manual thinking on an adaptive row', async () => {
  // f06 pin (bf5b30a): the Anthropic body spreads params BEFORE the thinking
  // override, so params.thinking is silently overridden — manual budget mode
  // cannot sneak back onto an adaptive row through params. top_p rides the
  // fable-5 row's samplingFieldsAllowed:true and reaches the wire. Passes on
  // base: a pin, not a fail-before.
  const stub = await anthropicStub([ANTHROPIC_OK]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'claude-fable-5',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      params: {
        thinking: { type: 'enabled', budget_tokens: 2048 },
        top_p: 0.9,
      },
    });
    const reply = await agent.act(CTX);
    assert.equal(reply.text, 'I play the center.\naction: b2');
    assert.deepEqual(stub.requests[0].body.thinking, { type: 'adaptive' });
    assert.equal(stub.requests[0].body.top_p, 0.9);
  } finally {
    await stub.close();
  }
});

