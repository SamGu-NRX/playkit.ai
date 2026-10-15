/**
 * Opt-in live test: an OpenAI-compatible chat-completions server on the local
 * machine (llama.cpp llama-server, Ollama, vLLM, ...) plays every tictactoe
 * public seed through runEpisode, and every trajectory verifies.
 *
 * SKIPPED unless both environment variables are set:
 * - GAUNTLET_LOCAL_CHAT_URL  base URL, e.g. http://127.0.0.1:8080
 * - GAUNTLET_LOCAL_CHAT_MODEL model id the server reports, e.g. qwen2.5-1.5b-instruct
 *
 * Optional:
 * - GAUNTLET_LOCAL_CHAT_KEY   name of an env var holding an API key, for
 *   servers that want one; when unset the client sends no Authorization header.
 * - GAUNTLET_LOCAL_CHAT_SEEDS number of public seeds to play (default 8, the
 *   tier's full public split).
 *
 * With the variables unset the file makes zero network calls, like every other
 * test here. Run once with them set (against localhost) and once without to
 * show the skip. See PROVIDERS.md for the exact serve commands.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createModelAgent } from './model-agent.js';
import tictactoe from '../games/tictactoe/index.js';
import { runEpisode } from '../core/runner.js';
import { verifyTrajectory } from '../core/trajectory.js';

const URL_ENV = 'GAUNTLET_LOCAL_CHAT_URL';
const MODEL_ENV = 'GAUNTLET_LOCAL_CHAT_MODEL';
const KEY_ENV = 'GAUNTLET_LOCAL_CHAT_KEY';
const SEEDS_ENV = 'GAUNTLET_LOCAL_CHAT_SEEDS';

const baseUrl = process.env[URL_ENV];
const model = process.env[MODEL_ENV];
const optIn =
  typeof baseUrl === 'string' &&
  baseUrl.length > 0 &&
  typeof model === 'string' &&
  model.length > 0;

const skipReason =
  `opt-in: set ${URL_ENV} and ${MODEL_ENV} to run against a local ` +
  'OpenAI-compatible chat server (see harness/PROVIDERS.md)';

if (!optIn) {
  test('live local model plays every tictactoe public seed through runEpisode (opt-in)', { skip: skipReason }, async () => {
    assert.fail('unreachable: the test only runs when opted in');
  });
}

const seedCount = optIn
  ? Number.isInteger(Number(process.env[SEEDS_ENV])) && Number(process.env[SEEDS_ENV]) > 0
    ? Number(process.env[SEEDS_ENV])
    : tictactoe.spec.tiers[0].publicSeeds
  : 0;

for (let i = 0; i < seedCount; i++) {
  const seed = `tictactoe/perfect-opponent/public/${i}`;
  test(`live local model plays tictactoe public seed ${i} and the trajectory verifies`, { timeout: 20 * 60_000 }, async () => {
    const agent = createModelAgent({
      provider: 'openai-chat',
      model: /** @type {string} */ (model),
      baseUrl: /** @type {string} */ (baseUrl),
      // Optional: when this variable is unset the client sends no auth header.
      apiKeyEnv: KEY_ENV,
      // Small local models can ramble; the cap keeps episodes bounded. The
      // official prompt and turn message are untouched.
      maxOutputTokens: 512,
    });
    const trajectory = await runEpisode({
      game: tictactoe,
      tierId: 'perfect-opponent',
      seed,
      agent,
    });
    const verdict = await verifyTrajectory(tictactoe, trajectory);
    assert.deepEqual(verdict, { ok: true });
    const agentSteps = trajectory.steps.filter((s) => s.by === 'agent');
    const latencies = agentSteps.map((s) => s.ms);
    const promptTokens = agentSteps.map((s) => s.usage?.inputTokens ?? 0);
    const completionTokens = agentSteps.map((s) => s.usage?.outputTokens ?? 0);

    /**
     * @param {number[]} xs
     * @returns {number}
     */
    const mean = (xs) =>
      xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const outcomeNormalized = /** @type {number[]} */ (
      trajectory.end.outcome?.normalized ?? []
    );
    console.log(
      `[live-local] seed ${i}: ${trajectory.end.reason}, ` +
        `outcome ${JSON.stringify(outcomeNormalized)}, ` +
        `${agentSteps.length} agent actions, ${trajectory.end.invalidActions} invalid, ` +
        `mean latency ${mean(latencies).toFixed(0)} ms, ` +
        `mean prompt tokens ${mean(promptTokens).toFixed(0)}, ` +
        `mean completion tokens ${mean(completionTokens).toFixed(0)}`
    );
    assert.equal(trajectory.agent.provider, 'openai-chat');
    assert.equal(trajectory.agent.model, model);
  });
}
