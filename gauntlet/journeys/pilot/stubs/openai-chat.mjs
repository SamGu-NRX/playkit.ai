#!/usr/bin/env node
/**
 * Stub OpenAI-compatible chat-completions server (127.0.0.1 only) — the wire
 * behind the `openai-chat` provider, which is how Google's Gemini
 * OpenAI-compatible endpoint is reached.
 *
 * Usage:
 *   node journeys/pilot/stubs/openai-chat.mjs --port 8083 \
 *     [--rate-limit-every 5] [--overload-every 13] [--refuse-every 11] [--truncate-every 7]
 *
 * Serves POST /v1/chat/completions with the documented chat-completions
 * shape: choices[].message with content plus reasoning_content, finish_reason
 * stop / length (truncated) / content_filter-style refusal via
 * message.refusal, usage.prompt_tokens / usage.completion_tokens with
 * completion_tokens_details.reasoning_tokens. Overload is HTTP 503. Never
 * makes an outbound request; spends nothing.
 */

import { parseStubArgs, startStub } from './core.mjs';

const options = parseStubArgs(process.argv.slice(2), 'openai-chat');
const stub = await startStub(options);
process.stdout.write(`openai-chat stub listening on ${stub.url}/v1/chat/completions\n`);
process.on('SIGTERM', () => void stub.close().then(() => process.exit(0)));
process.on('SIGINT', () => void stub.close().then(() => process.exit(0)));
