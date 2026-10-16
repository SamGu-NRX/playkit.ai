/**
 * Tests for thinking headroom: a default output cap per adaptive-thinking
 * capability row (the legacy 4096 default truncated whole replies mid-thought
 * once thinking tokens counted toward max_tokens), `meta.truncated` recording
 * of replies cut off by the cap, the switch to server-sent events when the
 * whole-reply cap exceeds what a non-streaming request should carry, and the
 * dollar-cap reservation staying equal to the wire max_tokens under the new
 * defaults.
 *
 * The doc claims the defaults are sized from (all checked 2026-10-16):
 * - Thinking tokens count toward max_tokens:
 *   https://platform.claude.com/docs/en/build-with-claude/thinking
 * - A non-streaming cap around 16,000 keeps replies under HTTP timeouts;
 *   larger caps need streaming:
 *   https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
 * - `stop_reason: "max_tokens"` marks a reply cut off by the cap:
 *   https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons
 * - Streaming event shapes (message_start / content_block_* / message_delta
 *   with cumulative usage / message_stop, ping and error events):
 *   https://platform.claude.com/docs/en/build-with-claude/streaming
 *
 * All offline: node:http stubs on 127.0.0.1 only, no paid calls.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createModelAgent } from './model-agent.js';
import { startStubServer, sendJson } from './stub-server.js';

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

/** Prices with a zero input rate, so the reservation quote is pure output. */
const PRICES = {
  'anthropic/claude-opus-5-5': {
    inputPerMTok: 0,
    outputPerMTok: 20,
    source: 'stub',
    checked: '2026-10-16',
  },
  'anthropic/claude-opus-4-6': {
    inputPerMTok: 0,
    outputPerMTok: 25,
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
 * Serve one raw body with an explicit content type (for SSE responses), while
 * still recording every parsed request body.
 *
 * @param {string} contentType
 * @param {(reqNo: number) => string} body For the n-th request (1-based).
 * @returns {Promise<{ url: string, requests: *, close: () => Promise<void> }>}
 */
async function rawStub(contentType, body) {
  /** @type {*} */
  const requests = [];
  const { url, close } = await startStubServer((req, res, parsed) => {
    requests.push({ method: req.method, url: req.url, body: parsed });
    res.writeHead(200, { 'content-type': contentType });
    res.end(body(requests.length));
  });
  return { url, requests, close };
}

/**
 * A non-truncated takeOrPass reply in the Anthropic Messages shape.
 * @param {Record<string, *>} [usage] Usage fields.
 * @returns {[number, *]} A (status, payload) pair for scriptStub.
 */
function anthropicTake(usage) {
  return [
    200,
    {
      id: 'msg_take',
      type: 'message',
      role: 'assistant',
      model: 'stub-model',
      content: [{ type: 'text', text: 'take' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 10, ...(usage ?? {}) },
    },
  ];
}

// ---------------------------------------------------------------------------
// The per-row default output cap on the adaptive-thinking models.

test('adaptive rows apply a documented default cap when maxOutputTokens is absent: claude-opus-5-5 sends max_tokens 16384, non-streaming', async () => {
  const stub = await scriptStub([anthropicTake()]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    await agent.act(CTX);
    assert.equal(stub.requests[0].body.max_tokens, 16384);
    assert.equal(stub.requests[0].body.stream, undefined, 'the default cap stays on the non-streaming path');
  } finally {
    await stub.close();
  }
});

test('claude-opus-4-8 gets the same default cap without a flag', async () => {
  const stub = await scriptStub([anthropicTake()]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    await agent.act(CTX);
    assert.equal(stub.requests[0].body.max_tokens, 16384);
  } finally {
    await stub.close();
  }
});

test('an explicit maxOutputTokens still wins over the row default', async () => {
  const stub = await scriptStub([anthropicTake()]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 2048,
    });
    await agent.act(CTX);
    assert.equal(stub.requests[0].body.max_tokens, 2048);
  } finally {
    await stub.close();
  }
});

test('non-adaptive rows and non-Claude ids keep the legacy 4096 default', async () => {
  const stub = await scriptStub([anthropicTake()]);
  try {
    const haiku = createModelAgent({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    await haiku.act(CTX);
    assert.equal(stub.requests[0].body.max_tokens, 4096);

    const proxy = createModelAgent({
      provider: 'anthropic',
      model: 'proxy/stub-model',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    await proxy.act(CTX);
    assert.equal(stub.requests[1].body.max_tokens, 4096);
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// meta.truncated: a reply cut off by the cap is recorded as cut off.

test('opus-4-8: a reply cut off mid-thinking (stop_reason max_tokens) records meta.truncated', async () => {
  const stub = await scriptStub([
    [
      200,
      {
        id: 'msg_cut',
        type: 'message',
        role: 'assistant',
        model: 'stub-model',
        content: [{ type: 'thinking', thinking: 'unreleased reasoning…', signature: 'sig' }],
        stop_reason: 'max_tokens',
        usage: {
          input_tokens: 100,
          output_tokens: 300,
          output_tokens_details: { thinking_tokens: 300 },
        },
      },
    ],
  ]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 1024,
    });
    const reply = await agent.act(CTX);
    assert.equal(reply.text, '', 'a thinking-only reply has no text for the runner');
    assert.deepEqual(reply.meta.truncated, { stopReason: 'max_tokens', outputTokens: 300 });
    assert.equal(reply.meta.reasoningTokens, 300);
    assert.ok(reply.usage, 'the cut-off reply still carries its usage');
    assert.equal(reply.usage.outputTokens, 300, 'the cut-off reply still records its usage');
  } finally {
    await stub.close();
  }
});

test('opus-5-5: a reply cut off with partial text records meta.truncated too', async () => {
  const stub = await scriptStub([
    [
      200,
      {
        id: 'msg_partial',
        type: 'message',
        role: 'assistant',
        model: 'stub-model',
        content: [
          { type: 'text', text: '{"action":"up","note":"the board is nearl' },
        ],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 100, output_tokens: 1024 },
      },
    ],
  ]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 1024,
    });
    const reply = await agent.act(CTX);
    assert.deepEqual(reply.meta.truncated, { stopReason: 'max_tokens', outputTokens: 1024 });
  } finally {
    await stub.close();
  }
});

test('an end_turn reply and a refusal reply carry no truncated marker', async () => {
  const stub = await scriptStub([
    anthropicTake(),
    [
      200,
      {
        id: 'msg_refusal',
        type: 'message',
        role: 'assistant',
        model: 'stub-model',
        content: [],
        stop_reason: 'refusal',
        stop_details: { category: 'cyber', explanation: 'declined' },
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    ],
  ]);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
    });
    const take = await agent.act(CTX);
    assert.equal(take.meta.truncated, undefined);
    const refusal = await agent.act(CTX);
    assert.equal(refusal.meta.truncated, undefined, 'a refusal is not a truncation');
    assert.deepEqual(refusal.meta.refusal, { category: 'cyber', explanation: 'declined' });
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// Oversized caps stream: a wire max_tokens above the documented non-streaming
// guidance switches the request to server-sent events, parsed into the same
// result and usage.

const TRUNCATED_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_sse","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":120,"output_tokens":1}}}',
  '',
  'event: ping',
  'data: {"type":"ping"}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reasoning…"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"partial answe"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":64000}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

test('a wire cap above the non-streaming guidance streams: stream:true on the wire, the SSE reply parsed into the same result and usage', async () => {
  const stub = await rawStub('text/event-stream', () => TRUNCATED_SSE);
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 64000,
    });
    const reply = await agent.act(CTX);
    assert.equal(stub.requests[0].body.stream, true, 'the oversized request goes out with stream: true');
    assert.equal(stub.requests[0].body.max_tokens, 64000);
    assert.equal(reply.text, 'partial answe', 'text deltas accumulate into the reply text');
    assert.ok(reply.usage, 'the SSE reply carries its usage');
    assert.equal(reply.usage.inputTokens, 120, 'input tokens come from message_start');
    assert.equal(reply.usage.outputTokens, 64000, 'output tokens come from the cumulative message_delta usage');
    assert.deepEqual(reply.meta.truncated, { stopReason: 'max_tokens', outputTokens: 64000 });
    assert.equal(reply.meta.responseId, 'msg_sse');
  } finally {
    await stub.close();
  }
});

test('the default cap sits exactly at the streaming threshold; one token more streams', async () => {
  const stub = await scriptStub([anthropicTake()]);
  try {
    const atThreshold = createModelAgent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 16384,
    });
    await atThreshold.act(CTX);
    assert.equal(stub.requests[0].body.stream, undefined, '16384 stays non-streaming');
  } finally {
    await stub.close();
  }
  const sseStub = await rawStub('text/event-stream', () => TRUNCATED_SSE);
  try {
    const overThreshold = createModelAgent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      baseUrl: sseStub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 16385,
    });
    await overThreshold.act(CTX);
    assert.equal(sseStub.requests[0].body.stream, true, '16385 streams');
  } finally {
    await sseStub.close();
  }
});

test('an error event mid-stream is a transport error and retries', async () => {
  const stub = await rawStub(
    'text/event-stream',
    () =>
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_err","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}',
        '',
        'event: error',
        'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
        '',
        '',
      ].join('\n')
  );
  try {
    const agent = createModelAgent({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      baseUrl: stub.url,
      apiKeyEnv: 'GAUNTLET_TEST_KEY',
      maxOutputTokens: 64000,
      maxRetries: 1,
      sleep: async () => {},
    });
    await assert.rejects(() => agent.act(CTX), (err) => {
      assert.ok(err instanceof Error && 'retries' in err, 'the rejection is a provider error');
      const providerErr = /** @type {Error & {retries: number}} */ (err);
      assert.match(providerErr.message, /overloaded_error|Overloaded/);
      assert.equal(providerErr.retries, 1, 'the stream error retried once before giving up');
      return true;
    });
  } finally {
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// The dollar-cap reservation stays equal to the wire max_tokens under the new
// defaults (input rate 0, so the quote is pure output at $20/MTok).

test('the reservation equals the wire max_tokens under the row default', async () => {
  const agent = createModelAgent({
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    baseUrl: 'http://127.0.0.1:1',
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
    prices: PRICES,
  });
  const quote = agent.quoteWorstCaseUsd?.(CTX) ?? null;
  assert.ok(quote !== null, 'agent exposes quoteWorstCaseUsd');
  // 16384 output tokens at $20/MTok.
  assert.ok(Math.abs(quote - (16384 / 1e6) * 20) < 1e-12, `quote ${quote} equals 16384 × $20/MTok`);
});

test('the reservation follows an explicit cap, and cap + budget on a manual-budget row (always the wire max_tokens)', async () => {
  const explicit = createModelAgent({
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    baseUrl: 'http://127.0.0.1:1',
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
    prices: PRICES,
    maxOutputTokens: 2048,
  });
  const explicitQuote = explicit.quoteWorstCaseUsd?.(CTX) ?? null;
  assert.ok(explicitQuote !== null, 'agent exposes quoteWorstCaseUsd');
  assert.ok(Math.abs(explicitQuote - (2048 / 1e6) * 20) < 1e-12);

  const budgeted = createModelAgent({
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    baseUrl: 'http://127.0.0.1:1',
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
    prices: PRICES,
    maxOutputTokens: 2048,
    thinkingBudget: 1024,
  });
  const budgetQuote = budgeted.quoteWorstCaseUsd?.(CTX) ?? null;
  assert.ok(budgetQuote !== null, 'agent exposes quoteWorstCaseUsd');
  // Wire max_tokens = 2048 + 1024 on the manual-budget row.
  assert.ok(Math.abs(budgetQuote - (3072 / 1e6) * 25) < 1e-12);
});
