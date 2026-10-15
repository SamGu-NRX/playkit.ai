/**
 * Tests for the committed real-model fixture: a trajectory recorded from an
 * actual open-weight model (Qwen2.5-1.5B-Instruct Q4_K_M via llama.cpp
 * llama-server, provider "openai-chat") playing tictactoe public seed 0. The
 * fixture keeps the real-model path covered offline: no network, no paid API.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import tictactoe from '../games/tictactoe/index.js';
import { runEpisode } from '../core/runner.js';
import { verifyTrajectory } from '../core/trajectory.js';
import { createReplayAgent } from './dry-run.js';

/**
 * @returns {import('../core/types.js').Trajectory}
 */
function loadFixture() {
  const path = new URL('./fixtures/local-tictactoe.json', import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('the committed local-model trajectory verifies against the current game', async () => {
  const trajectory = loadFixture();
  assert.equal(trajectory.format, 'playkit-gauntlet-trajectory/1');
  assert.equal(trajectory.game.id, 'tictactoe');
  assert.equal(trajectory.agent.provider, 'openai-chat');
  assert.equal(trajectory.agent.track, 'official');
  assert.equal(trajectory.agent.dryRun, false);
  // Every agent step carries real usage from the local server, plus the
  // openai-chat meta (retries, reasoningChars) — proof a real model produced it.
  for (const step of trajectory.steps.filter((s) => s.by === 'agent')) {
    assert.ok(step.usage, 'real-model steps record usage');
    assert.equal(typeof step.usage.inputTokens, 'number');
    assert.equal(typeof step.usage.outputTokens, 'number');
    assert.equal(step.usage.costUsd, null); // no price entry, so never a fake 0
    assert.equal(typeof step.reply.meta?.retries, 'number');
    assert.equal(typeof step.reply.meta?.reasoningChars, 'number');
  }
  const verdict = await verifyTrajectory(tictactoe, trajectory);
  assert.deepEqual(verdict, { ok: true });
});

test('the committed local-model trajectory replays offline through the replay agent', async () => {
  const recorded = loadFixture();
  const replay = createReplayAgent(recorded);
  const replayed = await runEpisode({
    game: tictactoe,
    tierId: recorded.tier,
    seed: recorded.seed,
    split: recorded.split,
    agent: replay,
  });
  assert.equal(replayed.agent.provider, 'openai-chat');
  assert.equal(replayed.end.reason, recorded.end.reason);
  assert.deepEqual(replayed.end.outcome, recorded.end.outcome);
  assert.deepEqual(
    replayed.steps.filter((s) => s.by === 'agent').map((s) => s.action),
    recorded.steps.filter((s) => s.by === 'agent').map((s) => s.action)
  );
  const verdict = await verifyTrajectory(tictactoe, replayed);
  assert.deepEqual(verdict, { ok: true });
});
