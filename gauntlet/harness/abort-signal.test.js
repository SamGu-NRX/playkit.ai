/**
 * The model agent cancels its in-flight call when the episode's wall-clock
 * limit fires (the PR #94 follow-up: the harness model agent did not consume
 * `ctx.signal`, so a timed-out episode always rode out the runner's grace
 * window with the request still open).
 *
 * The runner hands every `act()` a `TurnContext.signal` aborted at the
 * episode deadline (core/runner.js). The model agent joins that signal with
 * the per-attempt timeout (Node 20's `AbortSignal.any`) on every provider
 * request and on every retry wait. An episode abort rejects the call with an
 * error that says the episode's time limit ended it — distinct from the
 * per-attempt timeout's message — cancels the stalled request (the stub
 * server sees the connection close), and stops a pending 429 backoff before
 * its retry fires.
 *
 * Local stub server on 127.0.0.1 only; no paid calls.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runEpisode } from '../core/runner.js';
import { createModelAgent } from './model-agent.js';
import { startStubServer, sendJson } from './stub-server.js';

const API_KEY_ENV = 'GAUNTLET_ABORT_SIGNAL_TEST_KEY';
process.env[API_KEY_ENV] = 'stub-secret';

/** How long a stalling stub withholds its reply — far past every watchdog. */
const STALL_MS = 60_000;

const STUB_REPLY = {
  id: 'chatcmpl-stub',
  object: 'chat.completion',
  created: 1,
  model: 'stub-model',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'take' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 1 },
};

/**
 * A stub whose replies stall until the connection drops. Tracks requests and
 * server-side connection closes, so a test can assert the abort really tore
 * the connection down.
 */
async function stallingStub() {
  let requests = 0;
  let closed = 0;
  const stub = await startStubServer(
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
    (req, res) => {
      requests += 1;
      const timer = setTimeout(() => sendJson(res, 200, STUB_REPLY), STALL_MS);
      res.on('close', () => {
        closed += 1;
        clearTimeout(timer);
      });
    }
  );
  return {
    url: stub.url,
    close: async () => {
      // close() alone would wait out a stalled connection; drop them first.
      stub.server.closeAllConnections();
      await stub.close();
    },
    requests: () => requests,
    closed: () => closed,
  };
}

/** A stub that answers 429 with a long Retry-After on every request. */
async function rateLimitedStub() {
  let requests = 0;
  const stub = await startStubServer(
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
    (req, res) => {
      requests += 1;
      res.setHeader('retry-after', '30');
      sendJson(res, 429, { error: { type: 'rate_limit', message: 'slow down' } });
    }
  );
  return {
    url: stub.url,
    close: async () => {
      stub.server.closeAllConnections();
      await stub.close();
    },
    requests: () => requests,
  };
}

/**
 * @param {{ callTimeoutMs?: number, maxRetries?: number }} options
 * @param {string} baseUrl
 */
function modelAgent(options, baseUrl) {
  return createModelAgent({
    provider: 'openai-chat',
    model: 'stub-model',
    baseUrl,
    apiKeyEnv: API_KEY_ENV,
    maxOutputTokens: 64,
    ...(options.callTimeoutMs !== undefined ? { callTimeoutMs: options.callTimeoutMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : { maxRetries: 3 }),
  });
}

/**
 * A TurnContext carrying (or not carrying) the runner's time-limit signal.
 *
 * @param {AbortSignal} [signal]
 * @returns {import('../core/types.js').TurnContext}
 */
function turnCtx(signal) {
  return /** @type {import('../core/types.js').TurnContext} */ ({
    spec: { rulesText: 'Choose: take, pass.' },
    tier: { id: 'mini' },
    seat: 0,
    turn: 0,
    observation: { text: 'Choose: take, pass.', data: {} },
    legalActions: null,
    feedback: null,
    ...(signal ? { signal } : {}),
  });
}

/**
 * Reject `pending` when the caller's watchdog fires first: a call that never
 * settles must fail the test at the watchdog, not hang the suite.
 *
 * @template T
 * @param {Promise<T>} pending
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function settlesWithin(pending, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: not settled within ${ms}ms`)), ms);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * @param {() => boolean} predicate
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test('an episode abort rejects the call with the time-limit message, not the timeout message', { timeout: 30_000 }, async (t) => {
  const stub = await stallingStub();
  t.after(() => stub.close());
  const agent = modelAgent({ callTimeoutMs: 10_000 }, stub.url);
  const controller = new AbortController();
  const pending = agent.act(turnCtx(controller.signal));
  setTimeout(() => controller.abort(), 150);
  const err = await settlesWithin(pending, 5_000, 'abort mid-call').then(
    () => null,
    (/** @type {Error} */ e) => e
  );
  assert.ok(err, 'the call rejected');
  assert.match(err.message, /episode's time limit ended the call/);
  assert.doesNotMatch(err.message, /timed out after/, 'distinct from the per-attempt timeout message');
  assert.equal(/** @type {*} */ (err).retries, 0, 'an episode abort is never retried');
  assert.equal(
    await waitFor(() => stub.closed() >= stub.requests(), 2_000),
    true,
    'the stub server saw the stalled connection close'
  );
});

test('an abort during the 429 retry wait stops the backoff and makes no second request', { timeout: 30_000 }, async (t) => {
  const stub = await rateLimitedStub();
  t.after(() => stub.close());
  const agent = modelAgent({ callTimeoutMs: 10_000 }, stub.url);
  const controller = new AbortController();
  const pending = agent.act(turnCtx(controller.signal));
  // Abort well into the 30 s Retry-After wait.
  setTimeout(() => controller.abort(), 200);
  const err = await settlesWithin(pending, 5_000, 'abort mid-backoff').then(
    () => null,
    (/** @type {Error} */ e) => e
  );
  assert.ok(err, 'the call rejected');
  assert.match(err.message, /episode's time limit ended the call/);
  assert.equal(stub.requests(), 1, 'no second request after the abort — the backoff wait was cut');
});

test('the per-attempt timeout still rejects with its own message when no turn signal is present', { timeout: 30_000 }, async (t) => {
  const stub = await stallingStub();
  t.after(() => stub.close());
  const agent = modelAgent({ callTimeoutMs: 300, maxRetries: 0 }, stub.url);
  const err = await settlesWithin(agent.act(turnCtx()), 5_000, 'per-attempt timeout').then(
    () => null,
    (/** @type {Error} */ e) => e
  );
  assert.ok(err, 'the call rejected');
  assert.match(err.message, /call timed out after 300ms per attempt/);
});

test('with both a turn signal and a per-attempt timeout, the timeout that fires first wins', { timeout: 30_000 }, async (t) => {
  const stub = await stallingStub();
  t.after(() => stub.close());
  const agent = modelAgent({ callTimeoutMs: 300, maxRetries: 0 }, stub.url);
  const controller = new AbortController();
  const err = await settlesWithin(agent.act(turnCtx(controller.signal)), 5_000, 'timeout first with a signal present').then(
    () => null,
    (/** @type {Error} */ e) => e
  );
  assert.ok(err, 'the call rejected');
  assert.match(err.message, /call timed out after 300ms per attempt/);
});

/**
 * A minimal one-seat outcome game: a single legal action, terminal after the
 * first accepted step. Just enough game for runEpisode.
 */
function makeGame() {
  /** @type {import('../core/types.js').TierSpec} */
  const tier = {
    id: 'mini',
    rank: 1,
    scoring: 'outcome',
    maxActions: 10,
    publicSeeds: 2,
    params: {},
  };
  return /** @type {import('../core/types.js').Game<*>} */ (/** @type {*} */ ({
    spec: {
      id: 'abort-fixture',
      version: '1.0.0',
      seats: 1,
      rulesText: 'Take the action. Taking ends the episode.',
      tiers: [tier],
    },
    reset: () => ({ done: false }),
    toAct: (/** @type {{ done?: boolean }} */ state) => (state.done ? null : 0),
    observe: () => ({ text: 'take it', data: {} }),
    legalActions: () => ['take'],
    parseAction: (/** @type {*} */ _state, /** @type {*} */ _seat, /** @type {string} */ text) =>
      text === 'take'
        ? { ok: true, action: 'take' }
        : { ok: false, error: `unparseable: ${text}` },
    step: () => ({ done: true }),
    outcome: (/** @type {{ done?: boolean }} */ state) =>
      state.done
        ? { normalized: [1], raw: null, reason: 'solved', solved: true, par: null }
        : null,
    truncate: () => ({ normalized: [0], raw: null, reason: 'budget', solved: false, par: null }),
  }));
}

test('runEpisode ends time-limit inside the grace window and the stub connection closes', { timeout: 60_000 }, async (t) => {
  const stub = await stallingStub();
  t.after(() => stub.close());
  const agent = modelAgent({ callTimeoutMs: 15_000 }, stub.url);
  const trajectory = await runEpisode({
    game: makeGame(),
    tierId: 'mini',
    seed: 'abort-fixture/mini/public/0',
    agent,
    episodeTimeLimitMs: 400,
    timeLimitGraceMs: 1000,
  });
  assert.equal(trajectory.end.reason, 'time-limit');
  assert.equal(trajectory.end.timeLimitMs, 400);
  // Well inside the 1000 ms grace: the call settled promptly on the abort.
  // Pre-fix the stalled request never settled and the runner waited out the
  // whole grace, landing near 1400 ms.
  assert.ok(
    (trajectory.end.elapsedMs ?? Number.POSITIVE_INFINITY) < 800,
    `elapsed ${trajectory.end.elapsedMs}ms must be well inside the grace window`
  );
  assert.equal(
    await waitFor(() => stub.closed() >= 1, 2_000),
    true,
    'the stub server saw the stalled connection close — the abort cancelled the request, it did not merely outlive the episode'
  );
});
