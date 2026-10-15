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
