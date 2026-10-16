#!/usr/bin/env node
/**
 * Stub Anthropic Messages server (127.0.0.1 only).
 *
 * Usage:
 *   node journeys/pilot/stubs/anthropic.mjs --port 8081 \
 *     [--rate-limit-every 5] [--overload-every 13] [--refuse-every 11] [--truncate-every 7]
 *
 * Serves POST /v1/messages with the documented Anthropic Messages response
 * shape: content blocks (thinking + text), stop_reason end_turn / max_tokens
 * (truncated) / refusal, usage.input_tokens / usage.output_tokens with
 * output_tokens_details.thinking_tokens. Overload is HTTP 529 with the
 * documented `overloaded_error` envelope; rate limiting is HTTP 429 with a
 * `retry-after` header. Never makes an outbound request; spends nothing.
 */

import { parseStubArgs, startStub } from './core.mjs';

const options = parseStubArgs(process.argv.slice(2), 'anthropic');
const stub = await startStub(options);
process.stdout.write(`anthropic stub listening on ${stub.url}/v1/messages\n`);
process.on('SIGTERM', () => void stub.close().then(() => process.exit(0)));
process.on('SIGINT', () => void stub.close().then(() => process.exit(0)));
