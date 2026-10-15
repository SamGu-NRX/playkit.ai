/**
 * Model agents for the official track: a frontier model plays any Gauntlet
 * game through a provider API (Anthropic Messages or OpenAI Responses), using
 * only global fetch — no SDKs, so the same client can later run in the browser
 * overlay. No model IDs and no prices are hardcoded here: the caller names the
 * model, the key environment variable, and (optionally) a prices file.
 *
 * API references used for the request/response/usage field names:
 * - Anthropic Messages: https://docs.anthropic.com/en/api/messages
 *   (POST /v1/messages; headers x-api-key + anthropic-version; body model,
 *   max_tokens, system, messages; response content[].text and
 *   usage.input_tokens / usage.output_tokens).
 * - OpenAI Responses: https://platform.openai.com/docs/api-reference/responses
 *   (POST /v1/responses; header Authorization: Bearer; body model, input,
 *   instructions, max_output_tokens; response output[] message items with
 *   content[] output_text, and usage.input_tokens / usage.output_tokens).
 * - OpenAI chat completions (provider "openai-chat"): the wire format spoken
 *   by local servers (llama.cpp, Ollama, vLLM) and most other labs' gateways.
 *   https://platform.openai.com/docs/api-reference/chat
 *   (POST <baseUrl>/v1/chat/completions; Authorization: Bearer optional; body
 *   model, messages, max_tokens; response choices[0].message.content and
 *   usage.prompt_tokens / usage.completion_tokens; reasoning may arrive
 *   separately as message.reasoning_content or message.reasoning).
 *
 * Pure JS except for reading the API key from `process.env` at call time; no
 * `node:*` imports.
 *
 * @module
 */

import { OFFICIAL_SYSTEM_PROMPT, buildOfficialTurnMessage } from './official.js';

/** @import { Agent, AgentReply, TurnContext, Usage } from '../core/types.js' */

/**
 * @typedef {object} PriceEntry
 * @property {number} inputPerMTok USD per million input tokens.
 * @property {number} outputPerMTok USD per million output tokens.
 * @property {string} source Where the rates were taken from (URL).
 * @property {string} checked When the rates were last verified (ISO date).
 */

/**
 * @typedef {Record<string, PriceEntry>} PriceFile
 * Keyed by "<provider>/<model>".
 */

/**
 * @typedef {object} ModelAgentOptions
 * @property {'anthropic' | 'openai' | 'openai-chat'} provider Which wire
 *   protocol to speak.
 * @property {string} model The provider's model id, sent as-is.
 * @property {string} [baseUrl] API root. Defaults to the provider's public
 *   API for "anthropic" and "openai"; required for "openai-chat" (local
 *   servers have no default). Tests point this at a local stub server.
 * @property {string} [apiKeyEnv] Environment variable holding the API key,
 *   read at call time, never logged. Defaults to ANTHROPIC_API_KEY /
 *   OPENAI_API_KEY. Required for "anthropic" and "openai"; optional for
 *   "openai-chat" (some local servers need no key) — when unset, no
 *   Authorization header is sent.
 * @property {number} [maxOutputTokens] Per-reply cap. Default 4096.
 * @property {Record<string, *>} [params] Extra provider parameters merged into
 *   the request body (temperature, top_p, ...). Required protocol fields win
 *   over anything in `params`.
 * @property {PriceFile} [prices] Price file; without it (or without an entry
 *   for this provider/model) usage.costUsd is null.
 * @property {typeof fetch} [fetchImpl] Fetch implementation. Default global
 *   fetch.
 * @property {number} [maxRetries] Retries for 429/5xx/network errors. Default 3.
 * @property {number} [retryBaseDelayMs] Exponential backoff base. Default 500.
 * @property {(ms: number) => Promise<void>} [sleep] Delay function, injectable
 *   for fast tests.
 * @property {string} [id] Agent id. Default "<provider>/<model>".
 */

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_BASE_URLS = /** @type {Record<string, string>} */ ({
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
});
const DEFAULT_API_KEY_ENVS = /** @type {Record<string, string>} */ ({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-chat': 'OPENAI_API_KEY',
});
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const ERROR_EXCERPT_CHARS = 500;

/**
 * @param {(ms: number) => Promise<void>} [sleep]
 * @returns {(ms: number) => Promise<void>}
 */
function sleepOrDefault(sleep) {
  if (typeof sleep === 'function') return sleep;
  return (ms) => new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Join a base URL and a path without a URL dependency (browser-safe).
 *
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * Read the API key from the named environment variable at call time. Throws
 * naming the variable when it is missing; the key value itself is never
 * placed in an error message or a log.
 *
 * @param {string} apiKeyEnv
 * @param {string} provider
 * @returns {string}
 */
function resolveApiKey(apiKeyEnv, provider) {
  const env =
    typeof process !== 'undefined' && process.env ? process.env : undefined;
  const key = env ? env[apiKeyEnv] : undefined;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(
      `model agent: environment variable ${apiKeyEnv} is not set; it must contain the ${provider} API key (the key is read at call time and is never logged)`
    );
  }
  return key;
}

/**
 * Read the API key for a provider where the key is optional ("openai-chat").
 * Returns null when the environment variable is unset or empty — the request
 * then simply carries no Authorization header. The key value is never placed
 * in an error message or a log.
 *
 * @param {string} apiKeyEnv
 * @param {string} provider
 * @returns {string | null}
 */
function resolveOptionalApiKey(apiKeyEnv, provider) {
  const env =
    typeof process !== 'undefined' && process.env ? process.env : undefined;
  const key = env ? env[apiKeyEnv] : undefined;
  if (typeof key !== 'string' || key.length === 0) {
    return null;
  }
  return key;
}

/**
 * Read the response body as an excerpt for error messages. Truncated to a few
 * hundred characters so a huge error page cannot flood a trajectory.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function responseExcerpt(response) {
  let text = '';
  try {
    text = await response.text();
  } catch (err) {
    text = `<unreadable body: ${err instanceof Error ? err.message : String(err)}>`;
  }
  if (text.length > ERROR_EXCERPT_CHARS) {
    return `${text.slice(0, ERROR_EXCERPT_CHARS)}…`;
  }
  return text.length > 0 ? text : '(empty body)';
}

/**
 * One provider request with retries. 429, 5xx and network errors retry up to
 * `maxRetries` times with exponential backoff (plus a server-provided
 * Retry-After when present); any other non-OK status fails immediately with an
 * excerpt of the response body.
 *
 * @param {object} options
 * @param {string} options.url
 * @param {Record<string, string>} options.headers
 * @param {*} options.body JSON-serializable request body.
 * @param {typeof fetch} options.fetchImpl
 * @param {number} options.maxRetries
 * @param {number} options.retryBaseDelayMs
 * @param {(ms: number) => Promise<void>} options.sleep
 * @param {string} options.provider For error messages only.
 * @returns {Promise<{ json: *, retries: number }>}
 */
async function requestWithRetries({
  url,
  headers,
  body,
  fetchImpl,
  maxRetries,
  retryBaseDelayMs,
  sleep,
  provider,
}) {
  let retries = 0;
  for (;;) {
    /** @type {Response} */
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (retries >= maxRetries) {
        throw new Error(
          `model agent: ${provider} request failed after ${retries} retr${retries === 1 ? 'y' : 'ies'}: ${reason}`
        );
      }
      retries += 1;
      await sleep(retryBaseDelayMs * 2 ** (retries - 1));
      continue;
    }
    if (response.ok) {
      const json = await response.json();
      return { json, retries };
    }
    const excerpt = await responseExcerpt(response);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable) {
      throw new Error(
        `model agent: ${provider} API returned HTTP ${response.status}: ${excerpt}`
      );
    }
    if (retries >= maxRetries) {
      throw new Error(
        `model agent: ${provider} API returned HTTP ${response.status} after ${retries} retr${retries === 1 ? 'y' : 'ies'}: ${excerpt}`
      );
    }
    retries += 1;
    const retryAfterSeconds = Number(response.headers.get('retry-after'));
    const backoff = retryBaseDelayMs * 2 ** (retries - 1);
    const waitMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.max(backoff, retryAfterSeconds * 1000)
      : backoff;
    await sleep(waitMs);
  }
}

/**
 * @param {*} value
 * @returns {number}
 */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

/**
 * Cost from the caller-supplied price file only; null whenever there is no
 * entry, so an unknown price can never masquerade as a known one.
 *
 * @param {PriceFile | undefined} prices
 * @param {string} provider
 * @param {string} model
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @returns {number | null}
 */
function computeCostUsd(prices, provider, model, inputTokens, outputTokens) {
  if (!prices) return null;
  const entry = prices[`${provider}/${model}`];
  if (!entry) return null;
  const inputPerMTok = Number(entry.inputPerMTok);
  const outputPerMTok = Number(entry.outputPerMTok);
  if (!Number.isFinite(inputPerMTok) || !Number.isFinite(outputPerMTok)) {
    return null;
  }
  return (
    (inputTokens / 1_000_000) * inputPerMTok +
    (outputTokens / 1_000_000) * outputPerMTok
  );
}

/**
 * @typedef {object} ProviderCallOptions
 * @property {string} baseUrl API root.
 * @property {string} apiKey
 * @property {string} model
 * @property {number} maxOutputTokens
 * @property {Record<string, *>} [params]
 * @property {string} userMessage
 * @property {typeof fetch} fetchImpl
 * @property {number} maxRetries
 * @property {number} retryBaseDelayMs
 * @property {(ms: number) => Promise<void>} sleep
 */

/**
 * One successful provider turn, as the agent records it. `reasoningChars` is
 * set only by the openai-chat client (character count of separately delivered
 * reasoning; the reasoning content itself never enters the reply text).
 *
 * @typedef {object} ProviderTurnResult
 * @property {string} text
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} retries
 * @property {string | null} responseId
 * @property {number} [reasoningChars]
 */

/**
 * Call the Anthropic Messages API for one official-track turn.
 *
 * @param {ProviderCallOptions} options
 * @returns {Promise<ProviderTurnResult>}
 */
async function callAnthropic({
  baseUrl,
  apiKey,
  model,
  maxOutputTokens,
  params,
  userMessage,
  fetchImpl,
  maxRetries,
  retryBaseDelayMs,
  sleep,
}) {
  const body = {
    ...(params ?? {}),
    model,
    max_tokens: maxOutputTokens,
    system: OFFICIAL_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
  const { json, retries } = await requestWithRetries({
    url: joinUrl(baseUrl, '/v1/messages'),
    headers,
    body,
    fetchImpl,
    maxRetries,
    retryBaseDelayMs,
    sleep,
    provider: 'anthropic',
  });
  const blocks = Array.isArray(/** @type {*} */ (json)?.content)
    ? /** @type {Array<any>} */ (json.content)
    : [];
  const text = blocks
    .filter((/** @type {any} */ b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((/** @type {any} */ b) => b.text)
    .join('\n');
  return {
    text,
    inputTokens: tokenCount(json?.usage?.input_tokens),
    outputTokens: tokenCount(json?.usage?.output_tokens),
    retries,
    responseId: typeof json?.id === 'string' ? json.id : null,
  };
}

/**
 * Call the OpenAI Responses API for one official-track turn.
 *
 * @param {ProviderCallOptions} options Same shape as callAnthropic.
 * @returns {Promise<ProviderTurnResult>}
 */
async function callOpenAI({
  baseUrl,
  apiKey,
  model,
  maxOutputTokens,
  params,
  userMessage,
  fetchImpl,
  maxRetries,
  retryBaseDelayMs,
  sleep,
}) {
  const body = {
    ...(params ?? {}),
    model,
    instructions: OFFICIAL_SYSTEM_PROMPT,
    input: userMessage,
    max_output_tokens: maxOutputTokens,
  };
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
  const { json, retries } = await requestWithRetries({
    url: joinUrl(baseUrl, '/v1/responses'),
    headers,
    body,
    fetchImpl,
    maxRetries,
    retryBaseDelayMs,
    sleep,
    provider: 'openai',
  });
  const items = Array.isArray(/** @type {*} */ (json)?.output)
    ? /** @type {Array<any>} */ (json.output)
    : [];
  let text = items
    .filter((/** @type {any} */ item) => item && item.type === 'message' && item.role === 'assistant')
    .flatMap((/** @type {any} */ item) =>
      Array.isArray(item.content) ? item.content : []
    )
    .filter((/** @type {any} */ part) => part && part.type === 'output_text' && typeof part.text === 'string')
    .map((/** @type {any} */ part) => part.text)
    .join('\n');
  if (text.length === 0 && typeof json?.output_text === 'string') {
    text = json.output_text;
  }
  return {
    text,
    inputTokens: tokenCount(json?.usage?.input_tokens),
    outputTokens: tokenCount(json?.usage?.output_tokens),
    retries,
    responseId: typeof json?.id === 'string' ? json.id : null,
  };
}

/**
 * @typedef {object} ChatCallOptions
 * @property {string} baseUrl API root; the request goes to
 *   <baseUrl>/v1/chat/completions.
 * @property {string | null} apiKey API key, or null when the server needs
 *   none (no Authorization header is sent).
 * @property {string} model
 * @property {number} maxOutputTokens
 * @property {Record<string, *>} [params]
 * @property {string} userMessage
 * @property {typeof fetch} fetchImpl
 * @property {number} maxRetries
 * @property {number} retryBaseDelayMs
 * @property {(ms: number) => Promise<void>} sleep
 */

/**
 * Reply text from a chat-completions `message.content`: a string, or null /
 * missing (an empty reply — the runner counts it as an invalid attempt, it is
 * not a transport error), or an array of { type: 'text', text } parts.
 *
 * @param {*} content
 * @returns {string}
 */
function chatContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((/** @type {any} */ part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((/** @type {any} */ part) => part.text)
      .join('\n');
  }
  return '';
}

/**
 * Call an OpenAI-compatible chat-completions endpoint for one official-track
 * turn. Used for local servers (llama.cpp, Ollama, vLLM) and any other
 * gateway speaking the same wire format; baseUrl is required and the API key
 * is optional.
 *
 * @param {ChatCallOptions} options
 * @returns {Promise<ProviderTurnResult>}
 */
async function callOpenAIChat({
  baseUrl,
  apiKey,
  model,
  maxOutputTokens,
  params,
  userMessage,
  fetchImpl,
  maxRetries,
  retryBaseDelayMs,
  sleep,
}) {
  const body = {
    ...(params ?? {}),
    model,
    max_tokens: maxOutputTokens,
    messages: [
      { role: 'system', content: OFFICIAL_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  };
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json' };
  if (apiKey !== null && apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const { json, retries } = await requestWithRetries({
    url: joinUrl(baseUrl, '/v1/chat/completions'),
    headers,
    body,
    fetchImpl,
    maxRetries,
    retryBaseDelayMs,
    sleep,
    provider: 'openai-chat',
  });
  const choice = Array.isArray(/** @type {*} */ (json)?.choices)
    ? /** @type {Array<any>} */ (json.choices)[0]
    : null;
  const message = choice && choice.message ? choice.message : null;
  const text = chatContentText(message?.content);
  // Reasoning delivered separately never enters the reply text the runner
  // parses; only its character count is recorded.
  const reasoning =
    typeof message?.reasoning_content === 'string'
      ? message.reasoning_content
      : typeof message?.reasoning === 'string'
        ? message.reasoning
        : '';
  return {
    text,
    inputTokens: tokenCount(json?.usage?.prompt_tokens),
    outputTokens: tokenCount(json?.usage?.completion_tokens),
    retries,
    responseId: typeof json?.id === 'string' ? json.id : null,
    reasoningChars: reasoning.length,
  };
}

/**
 * Build an official-track agent backed by a frontier model. The agent carries
 * its previous reply forward itself: each act() sends exactly one user message
 * built by `buildOfficialTurnMessage` and stores the full reply for the next
 * turn, so context stays bounded on long games.
 *
 * @param {ModelAgentOptions} options
 * @returns {Agent}
 */
export function createModelAgent({
  provider,
  model,
  baseUrl,
  apiKeyEnv,
  maxOutputTokens,
  params,
  prices,
  fetchImpl,
  maxRetries,
  retryBaseDelayMs,
  sleep,
  id,
}) {
  if (
    provider !== 'anthropic' &&
    provider !== 'openai' &&
    provider !== 'openai-chat'
  ) {
    throw new Error(
      `createModelAgent: provider must be "anthropic", "openai" or "openai-chat", got ${JSON.stringify(provider)}`
    );
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('createModelAgent: model is required');
  }
  const base = baseUrl ?? DEFAULT_BASE_URLS[provider];
  if (!base) {
    throw new Error(
      'createModelAgent: provider "openai-chat" requires the baseUrl option (an OpenAI-compatible chat-completions server is self-hosted, so there is no default base URL)'
    );
  }
  const keyEnv = apiKeyEnv ?? DEFAULT_API_KEY_ENVS[provider];
  const limit =
    typeof maxOutputTokens === 'number' && maxOutputTokens > 0
      ? maxOutputTokens
      : DEFAULT_MAX_OUTPUT_TOKENS;
  const retries =
    typeof maxRetries === 'number' && maxRetries >= 0
      ? maxRetries
      : DEFAULT_MAX_RETRIES;
  const backoff =
    typeof retryBaseDelayMs === 'number' && retryBaseDelayMs >= 0
      ? retryBaseDelayMs
      : DEFAULT_RETRY_BASE_DELAY_MS;
  const doFetch = fetchImpl ?? globalThis.fetch;
  const wait = sleepOrDefault(sleep);
  if (typeof doFetch !== 'function') {
    throw new Error('createModelAgent: no fetch implementation available');
  }

  /** @type {string | null} */
  let previousReply = null;

  return {
    id: id ?? `${provider}/${model}`,
    track: /** @type {'official'} */ ('official'),
    model,
    provider,
    dryRun: false,
    async act(ctx) {
      const userMessage = buildOfficialTurnMessage(ctx, previousReply);
      const apiKey =
        provider === 'openai-chat'
          ? resolveOptionalApiKey(keyEnv, provider)
          : resolveApiKey(keyEnv, provider);
      const result =
        provider === 'anthropic'
          ? await callAnthropic({
              baseUrl: base,
              apiKey: /** @type {string} */ (apiKey),
              model,
              maxOutputTokens: limit,
              params,
              userMessage,
              fetchImpl: doFetch,
              maxRetries: retries,
              retryBaseDelayMs: backoff,
              sleep: wait,
            })
          : provider === 'openai'
            ? await callOpenAI({
                baseUrl: base,
                apiKey: /** @type {string} */ (apiKey),
                model,
                maxOutputTokens: limit,
                params,
                userMessage,
                fetchImpl: doFetch,
                maxRetries: retries,
                retryBaseDelayMs: backoff,
                sleep: wait,
              })
            : await callOpenAIChat({
                baseUrl: base,
                apiKey,
                model,
                maxOutputTokens: limit,
                params,
                userMessage,
                fetchImpl: doFetch,
                maxRetries: retries,
                retryBaseDelayMs: backoff,
                sleep: wait,
              });
      previousReply = result.text;
      /** @type {Usage} */
      const usage = {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: computeCostUsd(
          prices,
          provider,
          model,
          result.inputTokens,
          result.outputTokens
        ),
      };
      /** @type {AgentReply} */
      const reply = {
        text: result.text,
        usage,
        // Retries are transport, not game actions: they live in meta, never in
        // the action stream.
        meta: {
          retries: result.retries,
          ...(result.responseId ? { responseId: result.responseId } : {}),
          ...(result.reasoningChars !== undefined
            ? { reasoningChars: result.reasoningChars }
            : {}),
        },
      };
      return reply;
    },
  };
}
