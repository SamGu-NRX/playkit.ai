/**
 * End-to-end tests: runEpisode on tictactoe with (a) the model agent against a
 * local stub server and (b) the scripted agent — each producing a trajectory
 * that verifyTrajectory accepts, with model, provider and dryRun recorded.
 * Offline: node:http on 127.0.0.1 only.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createModelAgent } from './model-agent.js';
import { createScriptedAgent, createReplayAgent } from './dry-run.js';
import tictactoe from '../games/tictactoe/index.js';
import { runEpisode } from '../core/runner.js';
import { verifyTrajectory } from '../core/trajectory.js';
import { sendJson, startStubServer } from './stub-server.js';

const TIER = 'perfect-opponent';
const SEED = 'tictactoe/perfect-opponent/public/0';

/**
 * A provider stub that plays tic-tac-toe: it reads the legal-action list out
 * of the observation text in the user message and answers with the first
 * legal cell. Records every request it saw.
 *
 * @param {'anthropic' | 'openai'} provider
 * @returns {Promise<{ url: string, requests: *, close: () => Promise<void> }>}
 */
async function playingStub(provider) {
  /** @type {*} */
  const requests = [];
  const { url, close } = await startStubServer((req, res, body) => {
    requests.push(body);
    const text =
      provider === 'anthropic'
        ? /** @type {string} */ (body?.messages?.[0]?.content)
        : /** @type {string} */ (body?.input);
    const match = /Legal actions \(\d+, at most 64 so all are listed\): ([a-z0-9, ]+)/.exec(
      String(text)
    );
    if (!match) {
      sendJson(res, 400, { error: { message: 'stub could not find legal actions in the message' } });
      return;
    }
    const cell = match[1].split(',')[0].trim();
    const action = `action: ${cell}`;
    if (provider === 'anthropic') {
      sendJson(res, 200, {
        id: `msg_${requests.length}`,
        type: 'message',
        role: 'assistant',
        model: 'stub-model',
        content: [{ type: 'text', text: action }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100 + requests.length, output_tokens: 5 },
      });
    } else {
      sendJson(res, 200, {
        id: `resp_${requests.length}`,
        object: 'response',
        status: 'completed',
        model: 'stub-model',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: action }],
          },
        ],
        usage: { input_tokens: 50 + requests.length, output_tokens: 4 },
      });
    }
  });
  return { url, requests, close };
}

/**
 * @param {string} provider
 * @param {string} url
 * @returns {*}
 */
function agentOptions(provider, url) {
  return {
    provider: /** @type {'anthropic' | 'openai'} */ (provider),
    model: 'stub-model',
    baseUrl: url,
    apiKeyEnv: 'GAUNTLET_TEST_KEY',
  };
}

test('end to end: model agent (anthropic stub) plays a full episode that verifies', async () => {
  const key = 'GAUNTLET_TEST_KEY';
  const previousKey = process.env[key];
  process.env[key] = 'stub-key-anthropic';
  const stub = await playingStub('anthropic');
  try {
    const agent = createModelAgent(agentOptions('anthropic', stub.url));
    assert.equal(agent.model, 'stub-model');
    assert.equal(agent.provider, 'anthropic');
    assert.equal(agent.dryRun, false);
    const trajectory = await runEpisode({
      game: tictactoe,
      tierId: TIER,
      seed: SEED,
      agent,
    });
    assert.equal(trajectory.agent.id, 'anthropic/stub-model');
    assert.equal(trajectory.agent.model, 'stub-model');
    assert.equal(trajectory.agent.provider, 'anthropic');
    assert.equal(trajectory.agent.dryRun, false);
    assert.equal(trajectory.end.reason, 'terminal');
    const agentSteps = trajectory.steps.filter((s) => s.by === 'agent');
    assert.ok(agentSteps.length >= 3);
    for (const step of agentSteps) {
      assert.equal(step.invalid, false);
      assert.ok(step.usage);
      assert.equal(step.usage.costUsd, null);
      assert.equal(typeof step.reply.meta?.retries, 'number');
    }
    const verdict = await verifyTrajectory(tictactoe, trajectory);
    assert.deepEqual(verdict, { ok: true });
  } finally {
    await stub.close();
  }
});

test('end to end: model agent (openai stub) plays a full episode that verifies', async (t) => {
  const key = 'GAUNTLET_TEST_KEY';
  process.env[key] = 'stub-key-openai';
  const stub = await playingStub('openai');
  try {
    const agent = createModelAgent(agentOptions('openai', stub.url));
    const trajectory = await runEpisode({
      game: tictactoe,
      tierId: TIER,
      seed: SEED,
      agent,
    });
    assert.equal(trajectory.agent.provider, 'openai');
    assert.equal(trajectory.end.reason, 'terminal');
    const verdict = await verifyTrajectory(tictactoe, trajectory);
    assert.deepEqual(verdict, { ok: true });
  } finally {
    await stub.close();
    delete process.env[key];
  }
});

test('end to end: scripted dry-run agent plays a full episode that verifies, with zero usage', async () => {
  const agent = createScriptedAgent((ctx) => {
    const match = /Legal actions \(\d+, at most 64 so all are listed\): ([a-z0-9, ]+)/.exec(
      ctx.observation.text
    );
    assert.ok(match, 'the scripted agent expects the legal-action list in the observation');
    return `action: ${match[1].split(',')[0].trim()}`;
  }, { id: 'scripted-first-cell' });
  assert.equal(agent.dryRun, true);
  const trajectory = await runEpisode({
    game: tictactoe,
    tierId: TIER,
    seed: SEED,
    agent,
  });
  assert.equal(trajectory.agent.id, 'scripted-first-cell');
  assert.equal(trajectory.agent.dryRun, true);
  assert.equal(trajectory.end.reason, 'terminal');
  for (const step of trajectory.steps.filter((s) => s.by === 'agent')) {
    assert.deepEqual(step.usage, { inputTokens: 0, outputTokens: 0, costUsd: null });
  }
  const verdict = await verifyTrajectory(tictactoe, trajectory);
  assert.deepEqual(verdict, { ok: true });
});

test('end to end: a recorded model-agent episode replays offline through the replay agent', async (t) => {
  const key = 'GAUNTLET_TEST_KEY';
  process.env[key] = 'stub-key-anthropic';
  const stub = await playingStub('anthropic');
  try {
    const agent = createModelAgent(agentOptions('anthropic', stub.url));
    const recorded = await runEpisode({
      game: tictactoe,
      tierId: TIER,
      seed: SEED,
      agent,
    });
    const replay = createReplayAgent(recorded);
    const replayed = await runEpisode({
      game: tictactoe,
      tierId: TIER,
      seed: SEED,
      agent: replay,
    });
    assert.equal(replayed.end.reason, recorded.end.reason);
    assert.deepEqual(
      replayed.steps.filter((s) => s.by === 'agent').map((s) => s.action),
      recorded.steps.filter((s) => s.by === 'agent').map((s) => s.action)
    );
    const verdict = await verifyTrajectory(tictactoe, replayed);
    assert.deepEqual(verdict, { ok: true });
  } finally {
    await stub.close();
    delete process.env[key];
  }
});
