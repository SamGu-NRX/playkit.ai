/**
 * Integration: every agent wrapper forwards the inner agent's `dispose()`.
 *
 * The runner shuts down the actors it was seated — the agent and the
 * opponents — by calling `dispose()` on each that offers one, in
 * `runEpisode`'s finally block (core/runner.js). Engine-backed baselines
 * (go's GTP client, chess-stockfish's UCI client) hold child processes: a
 * wrapper that returns a new agent object without forwarding `dispose` makes
 * the runner dispose the wrapper — a no-op — while the inner agent's engine
 * process is never told to quit. That is PR #102's `gauntlet estimate` hang:
 * every probe episode on an engine-backed tier leaked one engine child, and
 * the estimate process never exited because the leaked child's open stdio
 * pipe kept the event loop referenced. The skill dial
 * (agents/skill-dial.js) and the community-track assisted agent
 * (community/assisted-agent.js) had the same shape, so `skill:<p>:<engine
 * expert>` leaked one engine per episode too.
 *
 * Each test seats a fake inner agent whose `dispose` is a spy inside one
 * wrapper, runs one episode through `runEpisode`, and requires exactly one
 * dispose call. Red before the forwarding was added: the runner disposed the
 * wrapper, the wrapper had no dispose, and the spy was never called.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runEpisode } from '../../core/runner.js';
import { probeTier } from '../../runs/estimate.js';
import { skillDial } from '../../agents/skill-dial.js';
import { createAssistedAgent } from '../../community/assisted-agent.js';

const FIXTURE_SEED = 'dispose-fixture/mini/public/0';

/** @type {import('../../core/types.js').TierSpec} */
const TIER = {
  id: 'mini',
  rank: 1,
  scoring: 'outcome',
  maxActions: 10,
  publicSeeds: 2,
  params: {},
};

/**
 * A minimal one-seat outcome game: a single legal action, terminal after the
 * first accepted step. Just enough game for runEpisode.
 *
 * @param {() => unknown} [baselineAgent] Optional `baselineAgent` hook, as
 *   `runs/estimate.js` resolveBaseline looks for it.
 */
function makeGame(baselineAgent) {
  return {
    spec: {
      id: 'dispose-fixture',
      version: '1.0.0',
      seats: 1,
      rulesText: 'Take the action. Taking ends the episode.',
      tiers: [TIER],
    },
    ...(baselineAgent ? { baselineAgent } : {}),
    reset: () => ({ done: false }),
    toAct: (/** @type {{ done?: boolean }} */ state) => (state.done ? null : 0),
    observe: () => ({ text: 'take it', data: {} }),
    legalActions: () => ['take'],
    parseAction: (/** @type {*} */ _state, /** @type {*} */ _seat, /** @type {string} */ text) =>
      text === 'take'
        ? { ok: true, action: 'take' }
        : { ok: false, error: `unparseable: ${text}` },
    step: () => ({ done: true }),
    outcome: (/** @type {{ done?: boolean }} */ state) =>
      state.done
        ? { normalized: [1], raw: null, reason: 'solved', solved: true, par: null }
        : null,
    truncate: () => ({ normalized: [0], raw: null, reason: 'budget', solved: false, par: null }),
  };
}

/**
 * A baseline-track agent that always answers `take`, with a dispose spy.
 */
function spyAgent() {
  const calls = { act: 0, dispose: 0 };
  const agent = {
    id: 'spy',
    track: /** @type {'baseline'} */ ('baseline'),
    async act() {
      calls.act += 1;
      return { text: 'take' };
    },
    async dispose() {
      calls.dispose += 1;
    },
  };
  return { agent, calls };
}

/** Cast the fixture to the Game contract runEpisode expects. */
/** @param {ReturnType<typeof makeGame>} game @returns {import('../../core/types.js').Game<*>} */
function asGame(game) {
  return /** @type {import('../../core/types.js').Game<*>} */ (/** @type {*} */ (game));
}

test('the estimate probe wrapper forwards the baseline dispose through runEpisode', async () => {
  const { agent, calls } = spyAgent();
  const game = makeGame(() => agent);
  const probe = await probeTier(
    asGame(game),
    TIER,
    [FIXTURE_SEED],
    'public'
  );
  assert.equal(probe.basis, 'engine-probe', 'the probe played the baseline episode');
  assert.equal(calls.act, 1, 'the probe agent called the baseline');
  assert.equal(
    calls.dispose,
    1,
    'runEpisode disposed the wrapper and the wrapper reached the baseline — an engine-backed baseline must not outlive its probe episode'
  );
});

test('the skill dial forwards the expert dispose through runEpisode', async () => {
  const { agent, calls } = spyAgent();
  const dial = skillDial(agent, 0, { episodeSeed: FIXTURE_SEED });
  const trajectory = await runEpisode({
    game: asGame(makeGame()),
    tierId: 'mini',
    seed: FIXTURE_SEED,
    agent: dial,
  });
  assert.equal(trajectory.end.reason, 'terminal');
  assert.equal(calls.act, 1, 'p=0 plays the expert');
  assert.equal(
    calls.dispose,
    1,
    'the dial must forward the expert dispose — an engine-backed expert must not outlive the episode'
  );
});

test('the community assisted agent forwards the inner dispose through runEpisode', async () => {
  const { agent, calls } = spyAgent();
  const wrapper = createAssistedAgent({ inner: agent });
  const trajectory = await runEpisode({
    game: asGame(makeGame()),
    tierId: 'mini',
    seed: FIXTURE_SEED,
    agent: wrapper,
  });
  assert.equal(trajectory.end.reason, 'terminal');
  assert.equal(calls.act, 1);
  assert.equal(
    calls.dispose,
    1,
    'the wrapper must forward the inner dispose — an engine-backed inner agent must not outlive the episode'
  );
});
