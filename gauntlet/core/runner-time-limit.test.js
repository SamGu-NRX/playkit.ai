import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEpisode } from './runner.js';
import { verifyTrajectory } from './trajectory.js';
import { getGame } from '../games/index.js';

const game = getGame('tictactoe');
const tierId = 'random-opponent';

/**
 * A baseline-track agent that returns the first legal action, sleeping
 * `delayMs` before each reply.
 *
 * @param {number} delayMs
 * @param {{ replies: number }} state
 * @returns {import('./types.js').Agent}
 */
function slowLegalAgent(delayMs, state = { replies: 0 }) {
  return {
    id: 'slow-legal',
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {import('./types.js').TurnContext} */ ctx) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      state.replies += 1;
      return { text: /** @type {string[]} */ (ctx.legalActions)[0] };
    },
  };
}

test('an episode whose agent hangs past the limit ends with reason time-limit and verifies', async () => {
  // First call replies fast (so the trajectory has a real step), the second
  // hangs until the episode's abort signal fires, then settles inside the
  // runner's grace window.
  let calls = 0;
  const agent = {
    id: 'hangs-on-call-2',
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {import('./types.js').TurnContext} */ ctx) {
      calls += 1;
      if (calls === 1) {
        return { text: /** @type {string[]} */ (ctx.legalActions)[0] };
      }
      return new Promise((resolve) => {
        const settle = () => resolve({ text: 'a1', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } });
        if (ctx.signal?.aborted) {
          settle();
          return;
        }
        ctx.signal?.addEventListener('abort', settle, { once: true });
      });
    },
  };
  const trajectory = await runEpisode({
    game,
    tierId,
    seed: 'time-limit-hang',
    agent,
    episodeTimeLimitMs: 120,
    timeLimitGraceMs: 500,
  });
  assert.equal(trajectory.end.reason, 'time-limit');
  assert.equal(trajectory.end.timeLimitMs, 120);
  const elapsedMs = /** @type {number} */ (trajectory.end.elapsedMs);
  assert.ok(elapsedMs >= 120, `elapsed ${elapsedMs} below the limit`);
  assert.ok(trajectory.steps.length >= 1, 'the fast first call is recorded');
  // The game's forfeit outcome: the agent scores 0, every other seat 1.
  const outcome = /** @type {import('./types.js').Outcome} */ (trajectory.end.outcome);
  assert.equal(outcome.normalized[trajectory.agent.seat], 0);
  assert.equal(outcome.raw, null);
  assert.equal(outcome.solved, false);
  assert.equal(outcome.par, null);
  const verdict = await verifyTrajectory(game, trajectory);
  assert.deepEqual(verdict, { ok: true });
});

test('an agent that ignores the abort signal is still bounded by the grace window', async () => {
  const trajectory = await runEpisode({
    game,
    tierId,
    seed: 'time-limit-ignorant',
    agent: slowLegalAgent(30_000),
    episodeTimeLimitMs: 50,
    timeLimitGraceMs: 20,
  });
  assert.equal(trajectory.end.reason, 'time-limit');
  // The runner did not wait out the 30 s call: the episode ended at the
  // limit plus the short grace, not at the call's natural completion.
  assert.ok(/** @type {number} */ (trajectory.end.elapsedMs) < 5000, `elapsed ${trajectory.end.elapsedMs} waited for the call`);
  const verdict = await verifyTrajectory(game, trajectory);
  assert.deepEqual(verdict, { ok: true });
});

test('the deadline also fires between turns under a fast agent', async () => {
  // The agent replies instantly, but the injected clock advances 15 ms per
  // call, so the turn-boundary check passes the limit mid-episode. The real
  // wall clock never reaches the 60 s timer, isolating this path.
  let tick = 0;
  const trajectory = await runEpisode({
    game,
    tierId,
    seed: 'time-limit-between-turns',
    agent: slowLegalAgent(0),
    episodeTimeLimitMs: 60,
    now: () => (tick += 15),
  });
  assert.equal(trajectory.end.reason, 'time-limit');
  assert.ok(trajectory.steps.length >= 1);
  const verdict = await verifyTrajectory(game, trajectory);
  assert.deepEqual(verdict, { ok: true });
});

test('episodes without a limit record no time-limit fields and end naturally', async () => {
  const trajectory = await runEpisode({
    game,
    tierId,
    seed: 'no-limit',
    agent: slowLegalAgent(0),
  });
  assert.equal(trajectory.end.reason, 'terminal');
  assert.equal(trajectory.end.timeLimitMs, undefined);
  assert.equal(trajectory.end.elapsedMs, undefined);
});

test('runEpisode validates the limit and grace options', async () => {
  for (const bad of [0, -5, 1.5, Number.NaN]) {
    await assert.rejects(
      () =>
        runEpisode({
          game,
          tierId,
          seed: 'validation',
          agent: slowLegalAgent(0),
          episodeTimeLimitMs: bad,
        }),
      /episodeTimeLimitMs/
    );
  }
  await assert.rejects(
    () =>
      runEpisode({
        game,
        tierId,
        seed: 'validation',
        agent: slowLegalAgent(0),
        episodeTimeLimitMs: 100,
        timeLimitGraceMs: -1,
      }),
    /timeLimitGraceMs/
  );
});
