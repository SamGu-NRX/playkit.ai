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
 * Reasoning settings (all pages checked 2026-10-16):
 * - Anthropic thinking and effort: https://platform.claude.com/docs/en/build-with-claude/effort
 *   and https://platform.claude.com/docs/en/models/overview — effort is
 *   `output_config: {effort: "low"|"medium"|"high"|"xhigh"|"max"}`; the
 *   documented default is `medium` on Claude Opus 5.5 and Claude Haiku 5.5
 *   and `high` on every other model that supports effort. On the
 *   adaptive-thinking models (the 5.5 generation, Claude Fable 5/5.1, and
 *   Claude Opus 5/4.8/4.7/Sonnet 5) manual budgets
 *   (`thinking: {type: "enabled", budget_tokens: N}`) are not accepted —
 *   HTTP 400. Every model that accepts adaptive thinking (those plus Opus 4.6
 *   and Sonnet 4.6) is sent `thinking: {type: "adaptive"}` unless a manual
 *   budget is set: on Opus 4.8/4.7/4.6 and Sonnet 4.6 a request with no
 *   `thinking` field runs without thinking, while on the 5.x models omitting
 *   it already runs adaptive (Anthropic model-migration guide, Opus 4.7, 4.8
 *   and Opus 5 sections, as bundled in the Claude API skill and read
 *   2026-10-16; live page:
 *   https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking). On models whose rows keep manual mode (the 4.6
 *   generation and earlier) the budget rides on top of the text cap as
 *   before. Thinking tokens count toward max_tokens
 *   and are billed as output tokens;
 *   `usage.output_tokens_details.thinking_tokens` is the breakdown; replies
 *   carry `thinking` and `redacted_thinking` content blocks that are never
 *   part of the reply text. A declined request arrives as HTTP 200 with
 *   `stop_reason: "refusal"` and a `stop_details` object
 *   (https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback).
 * - OpenAI Responses reasoning: https://platform.openai.com/docs/guides/reasoning
 *   — request `reasoning: {effort: "low"|"medium"|"high"|"xhigh"|"max"}`; max_output_tokens
 *   bounds reasoning and answer tokens together; `usage.output_tokens`
 *   includes reasoning tokens and `usage.output_tokens_details
 *   .reasoning_tokens` is the breakdown; an answer cut off mid-reasoning
 *   comes back `status: "incomplete"` with no message item.
 * - Google Gemini OpenAI compatibility: https://ai.google.dev/gemini-api/docs/openai
 *   — chat/completions at
 *   https://generativelanguage.googleapis.com/v1beta/openai/ accepts the
 *   chat-completions body field `reasoning_effort` and maps it to Gemini's
 *   thinking_level / thinking_budget.
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
 * @property {number} [maxOutputTokens] Per-reply cap. Default 4096. For
 *   "anthropic": on models whose capability row keeps manual thinking mode
 *   (the 4.6 generation and earlier) this caps the reply's text and the
 *   request's max_tokens is maxOutputTokens + thinkingBudget (thinking tokens
 *   count toward max_tokens, so the budget rides on top of the text cap). On
 *   the adaptive-thinking models there is no separate budget — max_tokens is
 *   a hard limit on the whole reply, thinking plus text (the docs recommend
 *   starting around 64k at `xhigh`/`max` effort) — so the wire max_tokens is
 *   maxOutputTokens itself.
 * @property {number} [thinkingBudget] Anthropic extended-thinking budget in
 *   tokens, sent as `thinking: {type: "enabled", budget_tokens}`. Provider
 *   "anthropic" only — passing it to another provider is an error, and the
 *   Anthropic minimum budget is 1024. Only models whose capability row
 *   accepts manual mode take it (deprecated on the 4.6 generation); on the
 *   adaptive-thinking models (Claude Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable
 *   5/5.1, Opus 5/4.8/4.7, Sonnet 5) the API rejects manual budgets with
 *   HTTP 400, so constructing the agent throws — use reasoningEffort there.
 *   See resolveAnthropicCapability / ANTHROPIC_CAPABILITIES below.
 * @property {'low' | 'medium' | 'high' | 'xhigh' | 'max'} [reasoningEffort]
 *   Reasoning effort. Provider "anthropic": `output_config: {effort}`, with
 *   the documented per-model levels and default enforced from the capability
 *   table (an unset effort on a model with documented levels is recorded as
 *   "provider-default" in the agent id, so runs at different provider
 *   defaults never merge on a leaderboard). Provider "openai":
 *   `reasoning: {effort}` (the docs' per-model value sets vary; the harness
 *   accepts low/medium/high/xhigh). Provider "openai-chat": the
 *   chat-completions body field `reasoning_effort` (Google's Gemini
 *   OpenAI-compatible endpoint maps low/medium/high to thinking_level).
 *   On provider "anthropic", passing both thinkingBudget and reasoningEffort
 *   is an error: both steer Anthropic thinking.
 * @property {number} [callTimeoutMs] Per-attempt timeout in milliseconds.
 *   Default: no per-attempt timeout. A timed-out attempt counts as a
 *   transport error and retries with the same backoff as a network failure;
 *   the exhaustion error names the model and the timeout. Values that are not
 *   positive finite numbers are ignored (no timeout).
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
 * @property {string} [id] Agent id. Default "<provider>/<model>", plus
 *   ":reasoning-effort=<level>" (or ":reasoning-effort=provider-default")
 *   when the Anthropic model has documented effort levels — the effective
 *   effort is part of the identity, so runs at different effort levels or
 *   different provider defaults never merge on a leaderboard.
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
const UNPARSEABLE_BODY_EXCERPT_CHARS = 200;

// ---------------------------------------------------------------------------
// Anthropic model-capability table.
//
// One row per documented Claude model-id pattern. Each row records what the
// model accepts on the wire, per the Anthropic docs, with the pages and the
// date the row was checked: the accepted thinking modes (manual budget_tokens
// vs. adaptive thinking steered by output_config.effort), the documented
// effort levels and API default, and whether sampling fields
// (temperature/top_p/top_k) are allowed. A `claude-*` model id that matches
// no row is refused at construction with a message naming this table, so a
// new model cannot be silently run with settings it rejects. Ids that are not
// Claude model ids on provider "anthropic" (proxies, stubs) are not tabled
// and keep the permissive default. Where the docs are silent the row records
// the permissive value (sampling allowed) rather than a guess.
//
// Checked 2026-10-16 against:
// - Models overview: https://platform.claude.com/docs/en/models/overview
//   (thinking mode, default effort, prices per model; "Extended thinking is
//   the manual budget_tokens mode on earlier models")
// - Effort: https://platform.claude.com/docs/en/build-with-claude/effort
//   (levels and defaults per model; manual budgets "deprecated on Claude
//   Opus 4.6 and Claude Sonnet 4.6 and not accepted on later models")
// - Claude Opus 5.5 migration guide:
//   https://platform.claude.com/docs/en/models/opus-5-5/migration-guide
//   (adaptive thinking, thinking on every request, max_tokens as a hard limit
//   on the whole reply, 64k recommendation at xhigh/max, sampling rejected)
// - Sonnet 5.5 / Haiku 5.5 model pages (sampling-parameter rejection: a
//   non-default temperature/top_p/top_k returns HTTP 400)
// - Refusals and fallback:
//   https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback

/**
 * @typedef {object} AnthropicModelCapability
 * @property {RegExp} pattern Model-id pattern (an optional `-YYYYMMDD`
 *   snapshot suffix is tolerated on every row).
 * @property {string} name Human-readable model name, for messages.
 * @property {boolean} manualBudgetAccepted Whether `thinking: {type:
 *   "enabled", budget_tokens}` is accepted; false = the model steers thinking
 *   adaptively via output_config.effort and rejects manual budgets with
 *   HTTP 400.
 * @property {boolean} adaptiveThinking Whether the model accepts `thinking:
 *   {type: "adaptive"}` (the 4.6 generation and later). When true the harness
 *   sends it on every request without a manual budget: on Opus 4.8/4.7/4.6
 *   and Sonnet 4.6 a request with no `thinking` field runs without thinking,
 *   and on the 5.x models the explicit field is the documented equivalent of
 *   omitting it.
 * @property {Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'> | null} effortLevels
 *   The documented effort levels; null = effort is not documented for the
 *   model, so reasoningEffort is refused rather than guessed.
 * @property {'low' | 'medium' | 'high' | null} defaultEffort The documented
 *   API default effort; null when effortLevels is null.
 * @property {boolean} samplingFieldsAllowed False only where the docs state
 *   that non-default temperature/top_p/top_k return HTTP 400.
 * @property {string} docs The page(s) the row was verified against.
 * @property {string} checked ISO date of the last doc check.
 */

/** @type {Array<AnthropicModelCapability>} */
export const ANTHROPIC_CAPABILITIES = [
  {
    pattern: /^claude-opus-5-5(?:-\d{8})?$/,
    name: 'Claude Opus 5.5',
    adaptiveThinking: true,
    manualBudgetAccepted: false,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    samplingFieldsAllowed: false,
    docs: 'https://platform.claude.com/docs/en/models/opus-5-5/migration-guide and https://platform.claude.com/docs/en/build-with-claude/effort',
    checked: '2026-10-16',
  },
  {
    pattern: /^claude-sonnet-5-5(?:-\d{8})?$/,
    name: 'Claude Sonnet 5.5',
    adaptiveThinking: true,
    manualBudgetAccepted: false,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    samplingFieldsAllowed: false,
    docs: 'https://platform.claude.com/docs/en/models/sonnet-5-5/overview and https://platform.claude.com/docs/en/build-with-claude/effort',
    checked: '2026-10-16',
  },
  {
    pattern: /^claude-haiku-5-5(?:-\d{8})?$/,
    name: 'Claude Haiku 5.5',
    adaptiveThinking: true,
    manualBudgetAccepted: false,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    samplingFieldsAllowed: false,
    docs: 'https://platform.claude.com/docs/en/models/haiku-5-5/overview and https://platform.claude.com/docs/en/build-with-claude/effort',
    checked: '2026-10-16',
  },
  {
    pattern: /^claude-fable-5-1(?:-\d{8})?$/,
    name: 'Claude Fable 5.1',
    adaptiveThinking: true,
    manualBudgetAccepted: false,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    samplingFieldsAllowed: true,
    docs: 'https://platform.claude.com/docs/en/models/fable-5-1/overview and https://platform.claude.com/docs/en/build-with-claude/effort (sampling: docs silent in the pages checked)',
    checked: '2026-10-16',
  },
  {
    pattern: /^claude-fable-5(?:-\d{8})?$/,
    name: 'Claude Fable 5',
    adaptiveThinking: true,
    manualBudgetAccepted: false,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    samplingFieldsAllowed: true,
    docs: 'https://platform.claude.com/docs/en/models/fable-5/overview and https://platform.claude.com/docs/en/build-with-claude/effort (sampling: docs silent in the pages checked)',
    checked: '2026-10-16',
  },
  {
    pattern: /^claude-opus-5(?:-\d{8})?$/,
    name: 'Claude Opus 5',
    adaptiveThinking: true,
    manualBudgetAccepted: false,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    samplingFieldsAllowed: true,
    docs: 'https://platform.claude.com/docs/en/models/opus-5/overview and https://platform.claude.com/docs/en/build-with-claude/effort (sampling: docs silent in the pages checked)',
    checked: '2026-10-16',
  },
  {
    pattern: /^claude-opus-4-8(?:-\d{8})?$/,
    name: 'Claude Opus 4.8',
    adaptiveThinking: true,
    manualBudgetAccepted: false,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    samplingFieldsAllowed: true,
    docs: 'https://platform.claude.com/docs/en/build-with-claude/effort and https://platform.claude.com/docs/en/models/overview (sampling: docs silent in the pages checked)',
    checked: '2026-10-16',
  },
  {
    pattern: /^claude-opus-4-7(?:-\d{8})?$/,
    name: 'Claude Opus 4.7',
    adaptiveThinking: true,
    manualBudgetAccepted: false,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    samplingFieldsAllowed: true,
    docs: 'https://platform.claude.com/docs/en/build-with-claude/effort and https://platform.claude.com/docs/en/models/overview (sampling: docs silent in the pages checked)',
    checked: '2026-10-16',
  },
  {
    pattern: /^claude-sonnet-5(?:-\d{8})?$/,
    name: 'Claude Sonnet 5',
    adaptiveThinking: true,
    manualBudgetAccepted: false,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    samplingFieldsAllowed: true,
    docs: 'https://platform.claude.com/docs/en/build-with-claude/effort and https://platform.claude.com/docs/en/models/overview (sampling: docs silent in the pages checked)',
    checked: '2026-10-16',
  },
  {
    pattern: /^claude-opus-4-6(?:-\d{8})?$/,
    name: 'Claude Opus 4.6',
    adaptiveThinking: true,
    manualBudgetAccepted: true,
    effortLevels: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    samplingFieldsAllowed: true,
    docs: 'https://platform.claude.com/docs/en/build-with-claude/effort and https://platform.claude.com/docs/en/build-with-claude/extended-thinking (manual budget deprecated)',
    checked: '2026-10-16',
  },
  {
    pattern: /^claude-sonnet-4-6(?:-\d{8})?$/,
    name: 'Claude Sonnet 4.6',
    adaptiveThinking: true,
    manualBudgetAccepted: true,
    effortLevels: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    samplingFieldsAllowed: true,
    docs: 'https://platform.claude.com/docs/en/build-with-claude/effort and https://platform.claude.com/docs/en/build-with-claude/extended-thinking (manual budget deprecated)',
    checked: '2026-10-16',
  },
  {
    pattern: /^claude-opus-4-5(?:-\d{8})?$/,
    name: 'Claude Opus 4.5',
    adaptiveThinking: false,
    manualBudgetAccepted: true,
    effortLevels: null,
    defaultEffort: null,
    samplingFieldsAllowed: true,
    docs: 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking (effort: not documented for this model in the pages checked)',
    checked: '2026-10-16',
  },
  {
    pattern: /^claude-haiku-4-5(?:-\d{8})?$/,
    name: 'Claude Haiku 4.5',
    adaptiveThinking: false,
    manualBudgetAccepted: true,
    effortLevels: null,
    defaultEffort: null,
    samplingFieldsAllowed: true,
    docs: 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking (effort: not documented for this model in the pages checked)',
    checked: '2026-10-16',
  },
  {
    pattern: /^claude-3-7(?:-\d{8})?/,
    name: 'Claude 3.7 (manual extended thinking)',
    adaptiveThinking: false,
    manualBudgetAccepted: true,
    effortLevels: null,
    defaultEffort: null,
    samplingFieldsAllowed: true,
    docs: 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking (older-behaviour fallback row)',
    checked: '2026-10-16',
  },
  {
    pattern: /^claude-(?:[0-9]|instant)/,
    name: 'Claude legacy (pre-thinking model ids)',
    adaptiveThinking: false,
    manualBudgetAccepted: false,
    effortLevels: null,
    defaultEffort: null,
    samplingFieldsAllowed: true,
    docs: 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking (older-behaviour fallback row: no thinking, no effort)',
    checked: '2026-10-16',
  },
];

export const ANTHROPIC_CAPABILITY_DOC_URL =
  'https://platform.claude.com/docs/en/models/overview';

/**
 * Look up the capability row for an Anthropic model id. Returns null for ids
 * that are not Claude model ids (proxies and stubs keep the permissive
 * default); throws for `claude-*` ids that match no row, naming the table so
 * a new model cannot be silently run with settings it may reject.
 *
 * @param {string} model
 * @returns {AnthropicModelCapability | null}
 */
export function resolveAnthropicCapability(model) {
  for (const capability of ANTHROPIC_CAPABILITIES) {
    if (capability.pattern.test(model)) return capability;
  }
  if (/^claude-/i.test(model)) {
    throw new Error(
      `createModelAgent: model ${JSON.stringify(model)} is a Claude id that matches no row in the Anthropic capability table (harness/model-agent.js), so it is refused rather than run with settings the model may reject. Add a row with the model-id pattern, accepted thinking modes, effort levels, default effort, and sampling-field rules, citing the doc URL and the date checked — see ${ANTHROPIC_CAPABILITY_DOC_URL}`
    );
  }
  return null;
}


/**
 * An Error carrying the number of retries the caller performed, so a consumer
 * can tell an exhausted-retry failure from an immediate one (0 when the first
 * answer was not retryable).
 *
 * @param {string} message
 * @param {number} retries
 * @returns {Error}
 */
function retryError(message, retries) {
  const err = new Error(message);
  /** @type {*} */ (err).retries = retries;
  return err;
}

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
 * excerpt of the response body; a 2xx body that does not parse as JSON fails
 * immediately too (a bad answer is final, not retryable), naming the provider,
 * the status and the first 200 characters of the body. Every error thrown
 * carries a numeric `retries` property: the retries performed, 0 when the
 * first answer was not retryable.
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
 * @param {string} [options.model] For timeout error messages only.
 * @param {number} [options.callTimeoutMs] Per-attempt timeout in ms; absent
 *   for no timeout.
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
  model,
  callTimeoutMs,
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
        ...(callTimeoutMs !== undefined
          ? { signal: AbortSignal.timeout(callTimeoutMs) }
          : {}),
      });
    } catch (err) {
      // AbortSignal.timeout rejects with a TimeoutError (or AbortError on
      // older runtimes); an abort here can only be ours — no other signal is
      // ever passed.
      const timedOut =
        callTimeoutMs !== undefined &&
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError');
      const reason = timedOut
        ? `model "${model}" call timed out after ${callTimeoutMs}ms per attempt`
        : err instanceof Error
          ? err.message
          : String(err);
      if (retries >= maxRetries) {
        throw retryError(
          `model agent: ${provider} request failed after ${retries} retr${retries === 1 ? 'y' : 'ies'}: ${reason}`,
          retries
        );
      }
      retries += 1;
      await sleep(retryBaseDelayMs * 2 ** (retries - 1));
      continue;
    }
    if (response.ok) {
      // A 2xx body that is not JSON is a failed answer, not a transport
      // error: it is never retried, and the error names the provider, the
      // status, and the first 200 characters of the body — a bare
      // SyntaxError helps nobody debug a misbehaving proxy.
      let raw = '';
      try {
        raw = await response.text();
      } catch (err) {
        raw = `<unreadable body: ${err instanceof Error ? err.message : String(err)}>`;
      }
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        const excerpt =
          raw.length > UNPARSEABLE_BODY_EXCERPT_CHARS
            ? `${raw.slice(0, UNPARSEABLE_BODY_EXCERPT_CHARS)}…`
            : raw.length > 0
              ? raw
              : '(empty body)';
        throw retryError(
          `model agent: ${provider} returned an unparseable 2xx body (HTTP ${response.status}): ${excerpt}`,
          retries
        );
      }
      return { json, retries };
    }
    const excerpt = await responseExcerpt(response);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable) {
      throw retryError(
        `model agent: ${provider} API returned HTTP ${response.status}: ${excerpt}`,
        retries
      );
    }
    if (retries >= maxRetries) {
      throw retryError(
        `model agent: ${provider} API returned HTTP ${response.status} after ${retries} retr${retries === 1 ? 'y' : 'ies'}: ${excerpt}`,
        retries
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

// Usage honesty: a provider that omits a count (or reports a negative or
// non-numeric one) did not measure it, so the count is null — never 0, which
// would make unreported usage look measured and bill a priced run at $0. A
// reported 0 stays 0.
/**
 * @param {*} value
 * @returns {number | null}
 */
function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Cost from the caller-supplied price file only; null whenever there is no
 * entry, so an unknown price can never masquerade as a known one — and null
 * whenever either token count is unreported, so unknown usage can never
 * masquerade as a spend of zero.
 *
 * @param {PriceFile | undefined} prices
 * @param {string} provider
 * @param {string} model
 * @param {number | null} inputTokens
 * @param {number | null} outputTokens
 * @returns {number | null}
 */
function computeCostUsd(prices, provider, model, inputTokens, outputTokens) {
  if (inputTokens === null || outputTokens === null) return null;
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
 * @property {number} [thinkingBudget] Anthropic extended-thinking budget_tokens;
 *   only on models whose capability row accepts manual mode (checked at
 *   construction); with it set the wire max_tokens is maxOutputTokens +
 *   thinkingBudget.
 * @property {boolean} [adaptiveThinking] Anthropic only: send `thinking:
 *   {type: "adaptive"}`. A set thinkingBudget takes precedence.
 * @property {'low' | 'medium' | 'high' | 'xhigh' | 'max'} [reasoningEffort]
 *   Anthropic (output_config.effort) or OpenAI Responses (reasoning.effort)
 *   reasoning effort — the provider unions coincide at all five levels and
 *   per-model values are validated at construction. Absent when the run
 *   leaves the provider default in place.
 * @property {number} [callTimeoutMs] Per-attempt timeout, or absent for none.
 */

/**
 * One successful provider turn, as the agent records it. `reasoningChars` is
 * set only by the openai-chat client (character count of separately delivered
 * reasoning; the reasoning content itself never enters the reply text).
 * `reasoningTokens` is the provider's reported reasoning/thinking-token
 * breakdown (Anthropic `output_tokens_details.thinking_tokens`, OpenAI
 * `output_tokens_details.reasoning_tokens`, chat servers'
 * `completion_tokens_details.reasoning_tokens`) when it reports one; it is a
 * subset of the reported output total, which is what cost follows.
 *
 * Anthropic declines are HTTP 200 with `stop_reason: "refusal"` and a
 * `stop_details` object; the turn then carries empty text and a `refusal`
 * metadata object ({category, explanation}) so a caller can tell a declined
 * request from a malformed one. The reported usage is kept as-is: whether a
 * pre-output refusal is billed depends on its category, and the runner
 * already treats empty text as an invalid attempt.
 *
 * @typedef {object} ProviderTurnResult
 * @property {string} text
 * @property {number | null} inputTokens Reported input tokens, or null when
 *   the provider did not report them.
 * @property {number | null} outputTokens Reported output tokens, or null when
 *   the provider did not report them.
 * @property {number} retries
 * @property {string | null} responseId
 * @property {number} [reasoningChars]
 * @property {number} [reasoningTokens]
 * @property {{category: string | null, explanation: string | null}} [refusal]
 *   Set when the reply arrived as `stop_reason: "refusal"`.
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
  thinkingBudget,
  adaptiveThinking,
  reasoningEffort,
  params,
  userMessage,
  fetchImpl,
  maxRetries,
  retryBaseDelayMs,
  sleep,
  callTimeoutMs,
}) {
  // Thinking rides inside max_tokens on both thinking modes. On a manual
  // budget (the 4.6 generation and earlier) the wire max_tokens is the text
  // cap plus the budget: Anthropic bills thinking tokens as output and counts
  // them toward max_tokens, so the reply keeps its full text budget on top of
  // the budget — and quoteWorstCaseUsd quotes exactly this sum as the
  // worst-case output. budget_tokens < max_tokens then holds by construction
  // (maxOutputTokens is at least 1). On the adaptive-thinking models there is
  // no separate budget: max_tokens is a hard limit on the whole reply
  // (thinking plus text), so the wire max_tokens is the cap itself and the
  // quoted worst case matches the wire limit one for one.
  const body = {
    ...(params ?? {}),
    model,
    max_tokens: maxOutputTokens + (thinkingBudget ?? 0),
    ...(thinkingBudget !== undefined
      ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } }
      : adaptiveThinking
        ? { thinking: { type: 'adaptive' } }
        : {}),
    // Effort steers how much an adaptive model thinks; the provider default
    // applies when unset. Required protocol fields win over params.
    ...(reasoningEffort !== undefined ? { output_config: { effort: reasoningEffort } } : {}),
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
    model,
    callTimeoutMs,
  });
  const blocks = Array.isArray(/** @type {*} */ (json)?.content)
    ? /** @type {Array<any>} */ (json.content)
    : [];
  // Only text blocks are the reply. `thinking` and `redacted_thinking` blocks
  // are the model's internal reasoning (redacted_thinking.data is opaque and
  // encrypted) and never enter the text the runner parses or carries forward.
  // A refusal arrives as stop_reason "refusal" (no text blocks): empty text,
  // honest usage, and the refusal details recorded as metadata.
  const isRefusal = json?.stop_reason === 'refusal';
  const text = isRefusal
    ? ''
    : blocks
        .filter((/** @type {any} */ b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((/** @type {any} */ b) => b.text)
        .join('\n');
  const thinkingTokens = tokenCount(json?.usage?.output_tokens_details?.thinking_tokens);
  const stopDetails =
    isRefusal && json?.stop_details && typeof json.stop_details === 'object'
      ? /** @type {{category?: unknown, explanation?: unknown}} */ (json.stop_details)
      : null;
  return {
    text,
    inputTokens: tokenCount(json?.usage?.input_tokens),
    outputTokens: tokenCount(json?.usage?.output_tokens),
    retries,
    responseId: typeof json?.id === 'string' ? json.id : null,
    ...(thinkingTokens !== null ? { reasoningTokens: thinkingTokens } : {}),
    ...(isRefusal
      ? {
          refusal: {
            category: typeof stopDetails?.category === 'string' ? stopDetails.category : null,
            explanation:
              typeof stopDetails?.explanation === 'string' ? stopDetails.explanation : null,
          },
        }
      : {}),
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
  reasoningEffort,
  params,
  userMessage,
  fetchImpl,
  maxRetries,
  retryBaseDelayMs,
  sleep,
  callTimeoutMs,
}) {
  const body = {
    ...(params ?? {}),
    model,
    instructions: OFFICIAL_SYSTEM_PROMPT,
    input: userMessage,
    // max_output_tokens bounds reasoning and answer tokens together, so the
    // effort setting cannot push billed output past it and the worst-case
    // quote stays limit.
    max_output_tokens: maxOutputTokens,
    ...(reasoningEffort !== undefined ? { reasoning: { effort: reasoningEffort } } : {}),
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
    model,
    callTimeoutMs,
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
  const reasoningTokens = tokenCount(json?.usage?.output_tokens_details?.reasoning_tokens);
  return {
    text,
    inputTokens: tokenCount(json?.usage?.input_tokens),
    outputTokens: tokenCount(json?.usage?.output_tokens),
    retries,
    responseId: typeof json?.id === 'string' ? json.id : null,
    ...(reasoningTokens !== null ? { reasoningTokens } : {}),
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
 * @property {'low' | 'medium' | 'high' | 'xhigh' | 'max'} [reasoningEffort]
 *   Reasoning effort, sent as the chat-completions reasoning_effort field.
 * @property {number} [callTimeoutMs] Per-attempt timeout, or absent for none.
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
  reasoningEffort,
  params,
  userMessage,
  fetchImpl,
  maxRetries,
  retryBaseDelayMs,
  sleep,
  callTimeoutMs,
}) {
  const body = {
    ...(params ?? {}),
    model,
    max_tokens: maxOutputTokens,
    // The chat-completions reasoning field, as spoken by Google's Gemini
    // OpenAI-compatible endpoint (reasoning_effort → thinking_level /
    // thinking_budget) and other reasoning-capable chat servers.
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
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
  // A base URL that already names the full chat-completions endpoint is
  // honored as-is: some gateways do not serve the /v1/ prefix — Google's
  // Gemini OpenAI-compatible endpoint lives at exactly
  // https://generativelanguage.googleapis.com/v1beta/openai/chat/completions.
  const url = /\/chat\/completions$/.test(baseUrl)
    ? baseUrl
    : joinUrl(baseUrl, '/v1/chat/completions');
  const { json, retries } = await requestWithRetries({
    url,
    headers,
    body,
    fetchImpl,
    maxRetries,
    retryBaseDelayMs,
    sleep,
    provider: 'openai-chat',
    model,
    callTimeoutMs,
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
  const reasoningTokens = tokenCount(json?.usage?.completion_tokens_details?.reasoning_tokens);
  return {
    text,
    inputTokens: tokenCount(json?.usage?.prompt_tokens),
    outputTokens: tokenCount(json?.usage?.completion_tokens),
    retries,
    responseId: typeof json?.id === 'string' ? json.id : null,
    reasoningChars: reasoning.length,
    ...(reasoningTokens !== null ? { reasoningTokens } : {}),
  };
}

/**
 * Build an official-track agent backed by a frontier model. The agent carries
 * its previous reply forward itself: each act() sends exactly one user message
 * built by `buildOfficialTurnMessage` and stores the full reply for the next
 * turn, so context stays bounded on long games.
 *
 * @param {ModelAgentOptions} options
 * @returns {import('../core/types.js').Agent & {
 *   reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' |
 *     'provider-default',
 *   reasoningEffortDefault?: string | null,
 *   thinking?: 'enabled' | 'adaptive' | 'off' | 'provider-default',
 * }} The core Agent plus the effective-effort identity: reasoningEffort is the
 *   run's effort, or the literal "provider-default" when an effort-capable
 *   model runs unset; reasoningEffortDefault is the model row's documented
 *   default (null when the row documents none). Both stay absent on rows
 *   without documented effort levels. thinking is the Anthropic thinking
 *   mode the requests run with (absent on other providers); run.json records
 *   it in its agent record.
 */
export function createModelAgent({
  provider,
  model,
  baseUrl,
  apiKeyEnv,
  maxOutputTokens,
  thinkingBudget,
  reasoningEffort,
  callTimeoutMs,
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
  if (thinkingBudget !== undefined) {
    if (provider !== 'anthropic') {
      throw new Error(
        `createModelAgent: thinkingBudget is the Anthropic extended-thinking setting and only applies to provider "anthropic", got provider ${JSON.stringify(provider)}${provider === 'openai' || provider === 'openai-chat' ? ' (pass reasoningEffort instead)' : ''}`
      );
    }
    if (!Number.isInteger(thinkingBudget) || thinkingBudget < 1024) {
      throw new Error(
        `createModelAgent: thinkingBudget must be an integer >= 1024 (the Anthropic minimum budget_tokens), got ${JSON.stringify(thinkingBudget)}`
      );
    }
  }
  if (reasoningEffort !== undefined) {
    // Per-provider value sets. On anthropic the per-model capability table
    // (below) enforces the documented levels exactly; non-Claude anthropic ids
    // (proxies, stubs) get the permissive superset.
    const allowed =
      provider === 'openai'
        ? ['low', 'medium', 'high', 'xhigh']
        : provider === 'openai-chat'
          ? ['low', 'medium', 'high']
          : ['low', 'medium', 'high', 'xhigh', 'max'];
    if (!allowed.includes(reasoningEffort)) {
      throw new Error(
        `createModelAgent: reasoningEffort for provider ${JSON.stringify(provider)} must be one of ${allowed.map((v) => JSON.stringify(v)).join(', ')}, got ${JSON.stringify(reasoningEffort)}`
      );
    }
    if (provider === 'anthropic' && thinkingBudget !== undefined) {
      throw new Error(
        'createModelAgent: thinkingBudget and reasoningEffort both steer Anthropic thinking — pass one, not both (manual budget mode for pre-4.6 models, adaptive thinking with effort for 4.6 and later)'
      );
    }
  }
  // Per-model capability validation for Claude model ids on provider
  // "anthropic". A `claude-*` id that matches no row is refused inside
  // resolveAnthropicCapability, naming the table, so a new model cannot be
  // silently run with settings it may reject.
  const capability =
    provider === 'anthropic' ? resolveAnthropicCapability(model) : null;
  if (capability) {
    if (thinkingBudget !== undefined && !capability.manualBudgetAccepted) {
      throw new Error(
        `createModelAgent: thinkingBudget is not accepted on model ${JSON.stringify(model)} (${capability.name}): the model rejects manual budget_tokens with HTTP 400${capability.effortLevels ? ' — steer thinking with reasoningEffort instead' : ''}. See the Anthropic capability table in harness/model-agent.js and ${capability.docs} (checked ${capability.checked})`
      );
    }
    if (reasoningEffort !== undefined) {
      if (!capability.effortLevels) {
        throw new Error(
          `createModelAgent: the Anthropic capability table documents no effort levels for model ${JSON.stringify(model)} (${capability.name}), so reasoningEffort is refused rather than guessed. See the table in harness/model-agent.js and ${capability.docs} (checked ${capability.checked})`
        );
      }
      if (!capability.effortLevels.includes(reasoningEffort)) {
        throw new Error(
          `createModelAgent: reasoning effort ${JSON.stringify(reasoningEffort)} is not documented for model ${JSON.stringify(model)} (${capability.name}); the documented levels are ${capability.effortLevels.map((v) => JSON.stringify(v)).join(', ')}. See the Anthropic capability table in harness/model-agent.js and ${capability.docs} (checked ${capability.checked})`
        );
      }
    }
    if (!capability.samplingFieldsAllowed && params) {
      const rejected = ['temperature', 'top_p', 'top_k'].filter((field) =>
        Object.prototype.hasOwnProperty.call(params, field)
      );
      if (rejected.length > 0) {
        throw new Error(
          `createModelAgent: params carries sampling field(s) ${rejected.map((v) => JSON.stringify(v)).join(', ')} but model ${JSON.stringify(model)} (${capability.name}) rejects non-default temperature/top_p/top_k with HTTP 400. Remove them from params and steer behavior with reasoningEffort. See ${capability.docs} (checked ${capability.checked})`
        );
      }
    }
  }
  // The effective effort is part of the agent's identity: an unset effort on a
  // model with documented levels is recorded as "provider-default" (and the
  // documented default is exposed alongside), so runs at different provider
  // defaults or explicit levels never merge on a leaderboard.
  const effectiveEffort =
    reasoningEffort !== undefined
      ? reasoningEffort
      : capability && capability.effortLevels
        ? 'provider-default'
        : undefined;
  // The thinking mode the requests run with, recorded on the agent so a run
  // says whether thinking was on: "enabled" (manual budget_tokens),
  // "adaptive" (thinking: {type: "adaptive"} sent), "off" (a Claude model
  // without adaptive support and no budget: no thinking field, which the docs
  // define as no thinking), or "provider-default" (a non-Claude id on
  // provider "anthropic", such as a proxy, where no field is sent and the
  // server decides). Absent on the other providers.
  /** @type {'enabled' | 'adaptive' | 'off' | 'provider-default' | undefined} */
  const thinkingMode =
    provider !== 'anthropic'
      ? undefined
      : thinkingBudget !== undefined
        ? 'enabled'
        : !capability
          ? 'provider-default'
          : capability.adaptiveThinking
            ? 'adaptive'
            : 'off';
  // The wire effort: undefined leaves the provider default in place.
  const wireEffort =
    effectiveEffort !== undefined && effectiveEffort !== 'provider-default'
      ? effectiveEffort
      : undefined;
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
  const timeoutMs =
    typeof callTimeoutMs === 'number' &&
    Number.isFinite(callTimeoutMs) &&
    callTimeoutMs > 0
      ? callTimeoutMs
      : undefined;
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
    id:
      id ??
      `${provider}/${model}${
        effectiveEffort !== undefined ? `:reasoning-effort=${effectiveEffort}` : ''
      }`,
    track: /** @type {'official'} */ ('official'),
    model,
    provider,
    dryRun: false,
    ...(effectiveEffort !== undefined
      ? {
          reasoningEffort: effectiveEffort,
          reasoningEffortDefault: capability ? capability.defaultEffort : null,
        }
      : {}),
    ...(thinkingMode !== undefined ? { thinking: thinkingMode } : {}),
    quoteWorstCaseUsd(ctx) {
      // Upper bound on one act() call's USD cost, computable before the call
      // starts: the request text is priced at a conservative token estimate
      // (at most one token per two UTF-8 bytes) and the reply at the
      // output-token limit. With a thinking budget the reply's output bound
      // is the wire max_tokens — the text cap plus the budget; on the
      // adaptive-thinking models there is no separate budget and the wire
      // max_tokens is the cap itself (thinking rides inside it) — so the
      // reservation always covers the whole thinking spend. The settled cost
      // always comes from the provider's reported usage, never from this
      // estimate. null without a usable price entry, mirroring computeCostUsd.
      if (!prices) return null;
      const entry = prices[`${provider}/${model}`];
      if (!entry) return null;
      const inputPerMTok = Number(entry.inputPerMTok);
      const outputPerMTok = Number(entry.outputPerMTok);
      if (!Number.isFinite(inputPerMTok) || !Number.isFinite(outputPerMTok)) {
        return null;
      }
      const userMessage = buildOfficialTurnMessage(ctx, previousReply);
      const requestBytes = new TextEncoder().encode(userMessage).length;
      const worstCaseOutputTokens =
        limit + (provider === 'anthropic' ? (thinkingBudget ?? 0) : 0);
      return (
        ((requestBytes / 2) * inputPerMTok + worstCaseOutputTokens * outputPerMTok) / 1_000_000
      );
    },
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
              ...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
              adaptiveThinking: thinkingMode === 'adaptive',
              ...(wireEffort !== undefined ? { reasoningEffort: wireEffort } : {}),
              params,
              userMessage,
              fetchImpl: doFetch,
              maxRetries: retries,
              retryBaseDelayMs: backoff,
              sleep: wait,
              callTimeoutMs: timeoutMs,
            })
          : provider === 'openai'
            ? await callOpenAI({
                baseUrl: base,
                apiKey: /** @type {string} */ (apiKey),
                model,
                maxOutputTokens: limit,
                ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
                params,
                userMessage,
                fetchImpl: doFetch,
                maxRetries: retries,
                retryBaseDelayMs: backoff,
                sleep: wait,
                callTimeoutMs: timeoutMs,
              })
            : await callOpenAIChat({
                baseUrl: base,
                apiKey,
                model,
                maxOutputTokens: limit,
                // The construction-time provider validation restricts
                // openai-chat to low/medium/high, so the narrowed type holds.
                ...(reasoningEffort !== undefined
                  ? {
                      reasoningEffort: /** @type {'low' | 'medium' | 'high'} */ (
                        reasoningEffort
                      ),
                    }
                  : {}),
                params,
                userMessage,
                fetchImpl: doFetch,
                maxRetries: retries,
                retryBaseDelayMs: backoff,
                sleep: wait,
                callTimeoutMs: timeoutMs,
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
          ...(result.reasoningTokens !== undefined
            ? { reasoningTokens: result.reasoningTokens }
            : {}),
          ...(result.refusal ? { refusal: result.refusal } : {}),
        },
      };
      return reply;
    },
  };
}
