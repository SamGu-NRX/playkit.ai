/**
 * Shared core for the pilot rehearsal stub servers.
 *
 * One HTTP server per wire (Anthropic Messages, OpenAI Responses,
 * OpenAI-compatible chat-completions), listening on 127.0.0.1 only, that
 * answers official-track turns with the provider's documented response
 * shape — including thinking content, a truncated reply, a refusal, a
 * 429 with Retry-After and an overload (529/503) — at rates you set, and
 * reports usage tokens like the real API so the run layer's dollar-cap
 * reservation logic runs against realistic numbers.
 *
 * A stub NEVER makes an outbound request, holds no keys, and never spends
 * anything. It validates no API key: any value (or none) is accepted, the
 * same contract the real APIs have.
 *
 * Fault schedule: a per-process request counter, checked in this order —
 *   every Nth request  → HTTP 429 with `retry-after: 0` (rate-limit)
 *   every Nth request  → HTTP 529/503 with the provider's error envelope (overloaded)
 *   every Nth request  → a refusal reply in the wire's documented shape
 *   every Nth request  → a truncated reply in the wire's documented shape
 *   otherwise          → a success reply with thinking content
 * Counters start at 1, so with `--rate-limit-every 5` requests 5, 10, 15…
 * are rate-limited. A retried request advances the counter, so a fault is
 * followed by a fresh (usually successful) attempt — the same shape a real
 * provider shows.
 *
 * Usage honesty: prompt tokens are derived from the request body size
 * (bytes/4, like a conservative tokenizer) plus a fixed per-turn overhead;
 * output tokens are a fixed realistic figure with a reasoning portion. The
 * numbers are large enough that `quoteWorstCaseUsd` reservations and the
 * realized spend both land in the same dollar range a live pilot would.
 *
 * Node-only. No dependencies.
 *
 * @module
 */

import http from 'node:http';
import { writeFileSync } from 'node:fs';

/** Reply texts the stub cycles through. Deliberately game-agnostic AND
 * deliberately never a legal action in any registered game: the runner reads
 * the action from the last non-empty line and strips a leading `action:`, but
 * no game's parseAction accepts these, so every episode ends forfeit-invalid
 * after exactly three priced calls (the standard three-consecutive-invalid
 * forfeit). That bound is what lets a low rehearsal cap bind mid-suite and
 * still let the resume finish: a cap stop unwinds the episode in flight, so a
 * stub episode that could run to a 2400-action budget could never complete
 * under a low cap and the resume would loop forever. Play quality is not what
 * a rehearsal measures; plumbing is. */
const REPLY_TEXTS = [
  'ACTION: fleep 17',
  "I'll play ACTION: quuxflarn this turn.",
  'ACTION: xkcd 9',
  'Let me think... ACTION: wibble',
];

const THINKING_TEXT =
  'The board state is complex. I should weigh the options carefully before committing to a move.';

const REFUSAL_TEXT = "I can't help with that request.";

/**
 * @typedef {object} StubOptions
 * @property {'anthropic' | 'openai' | 'openai-chat'} wire
 * @property {number} port
 * @property {string} [host] Default 127.0.0.1 — loopback only, always.
 * @property {string} [portFile] When set, the actually-bound port is written
 *   to this file once the server is listening. Required with port 0
 *   (ephemeral): the launcher cannot know the assigned port otherwise.
 * @property {number} [rateLimitEvery] Every Nth request → 429 + retry-after. 0 disables.
 * @property {number} [overloadEvery] Every Nth request → 529 (anthropic) / 503. 0 disables.
 * @property {number} [refuseEvery] Every Nth request → documented refusal shape. 0 disables.
 * @property {number} [truncateEvery] Every Nth request → documented truncated shape. 0 disables.
 * @property {string} [model] Model id echoed in replies (the request's model is used when absent).
 * @property {(line: string) => void} [log] One line per request, for rehearsal evidence.
 */

/**
 * Pick the fault for request number n (1-based), in priority order.
 *
 * @param {number} n
 * @param {Required<Omit<StubOptions, 'wire' | 'port' | 'host' | 'model' | 'log'>>} faults
 * @returns {'rate-limit' | 'overload' | 'refusal' | 'truncated' | 'none'}
 */
function faultFor(n, faults) {
  if (faults.rateLimitEvery > 0 && n % faults.rateLimitEvery === 0) return 'rate-limit';
  if (faults.overloadEvery > 0 && n % faults.overloadEvery === 0) return 'overload';
  if (faults.refuseEvery > 0 && n % faults.refuseEvery === 0) return 'refusal';
  if (faults.truncateEvery > 0 && n % faults.truncateEvery === 0) return 'truncated';
  return 'none';
}

/**
 * Read the whole request body.
 *
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Conservative tokenizer, the same basis quoteWorstCaseUsd uses for input:
 * at most one token per four bytes, plus a fixed per-turn overhead.
 *
 * @param {string} bodyText
 * @returns {number}
 */
function promptTokens(bodyText) {
  return Math.ceil(Buffer.byteLength(bodyText, 'utf8') / 4) + 50;
}

/** Output tokens per successful call: text plus reasoning, realistic magnitudes. */
const OUTPUT_TOKENS = 220;
const REASONING_TOKENS = 160;

/**
 * @param {number} n
 * @returns {string}
 */
function pickReply(n) {
  return REPLY_TEXTS[(n - 1) % REPLY_TEXTS.length];
}

/**
 * Anthropic Messages reply bodies (documented shape, docs.anthropic.com —
 * content blocks, stop_reason, usage.input_tokens/output_tokens).
 *
 * @param {unknown} parsedBody
 * @param {'none' | 'truncated' | 'refusal'} kind
 * @param {number} n Request number, for reply cycling.
 * @param {number} inTok
 * @returns {*}
 */
function anthropicReply(parsedBody, kind, n, inTok) {
  const model = /** @type {any} */ (parsedBody)?.model ?? 'stub-model';
  const base = {
    id: `msg_stub_${String(n).padStart(6, '0')}`,
    type: 'message',
    role: 'assistant',
    model,
    stop_sequence: null,
    usage: {
      input_tokens: inTok,
      output_tokens: OUTPUT_TOKENS,
      output_tokens_details: { thinking_tokens: REASONING_TOKENS },
    },
  };
  if (kind === 'refusal') {
    return {
      ...base,
      content: [],
      stop_reason: 'refusal',
      stop_details: {
        category: 'user_request',
        explanation: 'Stub refusal: the request was declined by policy.',
      },
    };
  }
  if (kind === 'truncated') {
    // Cut mid-word, mid-thinking: no complete action line survives.
    return {
      ...base,
      content: [
        { type: 'thinking', thinking: THINKING_TEXT.slice(0, 30), signature: 'stub-signature' },
        { type: 'text', text: pickReply(n).slice(0, 6) },
      ],
      stop_reason: 'max_tokens',
    };
  }
  return {
    ...base,
    content: [
      { type: 'thinking', thinking: THINKING_TEXT, signature: 'stub-signature' },
      { type: 'text', text: pickReply(n) },
    ],
    stop_reason: 'end_turn',
  };
}

/**
 * OpenAI Responses reply bodies (documented shape — output items, status,
 * usage.input_tokens/output_tokens with output_tokens_details).
 *
 * @param {unknown} parsedBody
 * @param {'none' | 'truncated' | 'refusal'} kind
 * @param {number} n
 * @param {number} inTok
 * @returns {*}
 */
function openaiReply(parsedBody, kind, n, inTok) {
  const model = /** @type {any} */ (parsedBody)?.model ?? 'stub-model';
  const base = {
    id: `resp_stub_${String(n).padStart(6, '0')}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    usage: {
      input_tokens: inTok,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: OUTPUT_TOKENS,
      output_tokens_details: { reasoning_tokens: REASONING_TOKENS },
      total_tokens: inTok + OUTPUT_TOKENS,
    },
  };
  if (kind === 'refusal') {
    // Documented refusal part: a message item whose content is a refusal part.
    return {
      ...base,
      status: 'completed',
      output: [
        {
          type: 'message',
          id: `msg_stub_${n}`,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'refusal', refusal: REFUSAL_TEXT }],
        },
      ],
    };
  }
  if (kind === 'truncated') {
    return {
      ...base,
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        {
          type: 'reasoning',
          id: `rs_stub_${n}`,
          summary: [{ type: 'summary_text', text: THINKING_TEXT.slice(0, 30) }],
        },
        {
          type: 'message',
          id: `msg_stub_${n}`,
          role: 'assistant',
          status: 'incomplete',
          content: [{ type: 'output_text', text: pickReply(n).slice(0, 6), annotations: [] }],
        },
      ],
    };
  }
  return {
    ...base,
    status: 'completed',
    output: [
      {
        type: 'reasoning',
        id: `rs_stub_${n}`,
        summary: [{ type: 'summary_text', text: THINKING_TEXT }],
      },
      {
        type: 'message',
        id: `msg_stub_${n}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: pickReply(n), annotations: [] }],
      },
    ],
  };
}

/**
 * OpenAI-compatible chat-completions reply bodies (documented shape —
 * choices[].message, finish_reason, usage.prompt_tokens/completion_tokens).
 *
 * @param {unknown} parsedBody
 * @param {'none' | 'truncated' | 'refusal'} kind
 * @param {number} n
 * @param {number} inTok
 * @returns {*}
 */
function openaiChatReply(parsedBody, kind, n, inTok) {
  const model = /** @type {any} */ (parsedBody)?.model ?? 'stub-model';
  const base = {
    id: `chatcmpl-stub${String(n).padStart(6, '0')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
  };
  if (kind === 'refusal') {
    // Documented chat-completions refusal: message.refusal set, content null.
    return {
      ...base,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, refusal: REFUSAL_TEXT },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: inTok,
        completion_tokens: OUTPUT_TOKENS,
        completion_tokens_details: { reasoning_tokens: REASONING_TOKENS },
        total_tokens: inTok + OUTPUT_TOKENS,
      },
    };
  }
  if (kind === 'truncated') {
    return {
      ...base,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: pickReply(n).slice(0, 6),
            reasoning_content: THINKING_TEXT.slice(0, 30),
          },
          finish_reason: 'length',
        },
      ],
      usage: {
        prompt_tokens: inTok,
        completion_tokens: OUTPUT_TOKENS,
        completion_tokens_details: { reasoning_tokens: REASONING_TOKENS },
        total_tokens: inTok + OUTPUT_TOKENS,
      },
    };
  }
  return {
    ...base,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: pickReply(n),
          reasoning_content: THINKING_TEXT,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: inTok,
      completion_tokens: OUTPUT_TOKENS,
      completion_tokens_details: { reasoning_tokens: REASONING_TOKENS },
      total_tokens: inTok + OUTPUT_TOKENS,
    },
  };
}

/**
 * @param {string} wire
 * @param {unknown} parsedBody
 * @param {'none' | 'truncated' | 'refusal'} kind
 * @param {number} n
 * @param {number} inTok
 * @returns {*}
 */
function wireReply(wire, parsedBody, kind, n, inTok) {
  if (wire === 'anthropic') return anthropicReply(parsedBody, kind, n, inTok);
  if (wire === 'openai') return openaiReply(parsedBody, kind, n, inTok);
  return openaiChatReply(parsedBody, kind, n, inTok);
}

/**
 * @param {'anthropic' | 'openai' | 'openai-chat'} wire
 * @param {'rate-limit' | 'overload'} httpFault
 * @returns {{ status: number, headers: Record<string, string>, body: string }}
 */
function faultResponse(wire, httpFault) {
  if (httpFault === 'rate-limit') {
    const body =
      wire === 'anthropic'
        ? JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: 'Stub: rate limited' },
          })
        : JSON.stringify({ error: { message: 'Stub: rate limited', type: 'rate_limit_error' } });
    return { status: 429, headers: { 'retry-after': '0' }, body };
  }
  // Overload: Anthropic documents 529 `overloaded_error`; OpenAI and
  // chat-completions servers speak 503.
  const status = wire === 'anthropic' ? 529 : 503;
  const type = wire === 'anthropic' ? 'overloaded_error' : 'server_error';
  const body =
    wire === 'anthropic'
      ? JSON.stringify({ type: 'error', error: { type, message: 'Stub: overloaded' } })
      : JSON.stringify({ error: { message: 'Stub: overloaded', type } });
  return { status, headers: {}, body };
}

/**
 * Start the stub server. Resolves when the server is listening.
 *
 * @param {StubOptions} options
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function startStub(options) {
  const {
    wire,
    port,
    host = '127.0.0.1',
    portFile,
    rateLimitEvery = 0,
    overloadEvery = 0,
    refuseEvery = 0,
    truncateEvery = 0,
    log = () => {},
  } = options;
  const faults = { rateLimitEvery, overloadEvery, refuseEvery, truncateEvery };
  let counter = 0;
  const server = http.createServer((req, res) => {
    void (async () => {
      counter += 1;
      const n = counter;
      const bodyText = await readBody(req);
      const fault = faultFor(n, faults);
      const url = req.url ?? '';
      if (fault === 'rate-limit' || fault === 'overload') {
        const r = faultResponse(wire, fault);
        log(`#${n} wire=${wire} ${req.method} ${url} fault=${fault} status=${r.status}`);
        res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
        res.end(r.body);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        parsed = {};
      }
      const inTok = promptTokens(bodyText);
      const kind = fault === 'refusal' ? 'refusal' : fault === 'truncated' ? 'truncated' : 'none';
      const reply = wireReply(wire, parsed, kind, n, inTok);
      log(
        `#${n} wire=${wire} ${req.method} ${url} fault=${fault} prompt_tokens=${inTok} output_tokens=${OUTPUT_TOKENS} kind=${kind}`
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply));
    })().catch((err) => {
      log(`#${counter} wire=${wire} ERROR ${err instanceof Error ? err.message : String(err)}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stub internal error' } }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    // Loopback only, always: a stub must never be reachable off-machine.
    server.listen(port, host, () => resolve(undefined));
  });
  // The kernel assigns the port at bind time and this process holds it for
  // its whole life — with port 0 there is no probe-close-then-rebind window
  // for another process to slip into. The launcher reads the assigned port
  // from portFile instead of predicting it.
  const boundPort = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  if (portFile !== undefined) {
    writeFileSync(portFile, `${boundPort}\n`, 'utf8');
  }
  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    close: () =>
      new Promise((resolve, reject) => {
        server.close(() => resolve(undefined));
        server.on('error', reject);
      }),
  };
}

/**
 * Parse the shared CLI arguments for a stub server entrypoint.
 *
 * @param {string[]} argv
 * @param {'anthropic' | 'openai' | 'openai-chat'} wire
 * @returns {StubOptions}
 */
export function parseStubArgs(argv, wire) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = '1';
    }
  }
  const port = Number(flags['port'] ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`stub: --port must be a valid port number, got "${flags['port'] ?? ''}"`);
  }
  const portFile = flags['port-file'];
  if (port === 0 && portFile === undefined) {
    throw new Error(
      'stub: --port 0 (ephemeral) requires --port-file PATH so the launcher learns the assigned port'
    );
  }
  return {
    wire,
    port,
    portFile,
    host: '127.0.0.1',
    rateLimitEvery: Number(flags['rate-limit-every'] ?? 0),
    overloadEvery: Number(flags['overload-every'] ?? 0),
    refuseEvery: Number(flags['refuse-every'] ?? 0),
    truncateEvery: Number(flags['truncate-every'] ?? 0),
    model: flags['model'],
    log: (line) => process.stdout.write(line + '\n'),
  };
}
