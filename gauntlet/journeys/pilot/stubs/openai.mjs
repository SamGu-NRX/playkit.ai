#!/usr/bin/env node
/**
 * Stub OpenAI Responses server (127.0.0.1 only).
 *
 * Usage:
 *   node journeys/pilot/stubs/openai.mjs --port 8082 \
 *     [--rate-limit-every 5] [--overload-every 13] [--refuse-every 11] [--truncate-every 7]
 *
 * Serves POST /v1/responses with the documented Responses API shape: output
 * items (reasoning + message), status completed / incomplete with
 * incomplete_details.reason "max_output_tokens" (truncated), a refusal
 * content part, usage.input_tokens / usage.output_tokens with
 * output_tokens_details.reasoning_tokens. Overload is HTTP 503. Never makes
 * an outbound request; spends nothing.
 */

import { parseStubArgs, startStub } from './core.mjs';

const options = parseStubArgs(process.argv.slice(2), 'openai');
const stub = await startStub(options);
process.stdout.write(`openai responses stub listening on ${stub.url}/v1/responses\n`);
process.on('SIGTERM', () => void stub.close().then(() => process.exit(0)));
process.on('SIGINT', () => void stub.close().then(() => process.exit(0)));
