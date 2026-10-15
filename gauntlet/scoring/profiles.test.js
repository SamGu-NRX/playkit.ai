/**
 * Tests for the scoring profiles layer (`scoring/profiles.js`, the profile
 * plumbing in `score.js` and `leaderboard.js`, and the committed baseline
 * file). Every number is hand-computed; every trajectory comes from the real
 * runner against the fixture games. No network, no paid APIs.
 *
 * @module
 */

/** @import { Agent } from '../core/types.js' */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { score, GauntletRefusalError } from './score.js';
import { leaderboard } from './leaderboard.js';
import { buildSuite } from './suite.js';
import { loadBaselineFile } from './baselines.js';
import {
  BASELINE_FORMAT,
  CHANCE_DENOMINATOR_FLOOR,
  DEFAULT_PROFILE,
  SCORING_PROFILES,
  resolveProfile,
  transformOutcomeEpisode,
  validateBaseline,
} from './profiles.js';
import tictactoe from '../games/tictactoe/index.js';
import connect4 from '../games/connect4/index.js';
import { createRandomAgent } from '../agents/random.js';
import {
  countdown,
  takeOrPass,
  scriptedAgent,
  runSuite,
} from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

/** @import { Game, Trajectory } from '../core/types.js' */

/**
 * Assert a refusal with the named step.
 *
 * @param {() => unknown | Promise<unknown>} call
 * @param {string} step
 * @returns {Promise<void>}
 */
async function assertRefuses(call, step) {
  try {
    await call();
    assert.fail(`expected a ${step} refusal`);
  } catch (error) {
    assert.ok(error instanceof GauntletRefusalError, `expected a GauntletRefusalError, got ${error}`);
    assert.equal(/** @type {GauntletRefusalError} */ (error).step, step);
  }
}

//
// Profile resolution.
//

test('resolveProfile: default is rhae-v1; unknown profiles refuse by name', () => {
  assert.equal(resolveProfile(undefined), DEFAULT_PROFILE);
  assert.equal(resolveProfile(/** @type {*} */ (null)), DEFAULT_PROFILE);
  for (const profile of SCORING_PROFILES) {
    assert.equal(resolveProfile(profile), profile);
  }
  assertRefuses(() => resolveProfile('elo'), 'profile-unknown');
});

//
// The formulas, on hand-computed inputs.
//

test('squared-outcome: e squared, with 0 and 1 fixed points', () => {
  assert.equal(transformOutcomeEpisode('squared-outcome', 0.5), 0.25);
  assert.equal(transformOutcomeEpisode('squared-outcome', 0), 0);
  assert.equal(transformOutcomeEpisode('squared-outcome', 1), 1);
  assert.equal(transformOutcomeEpisode('squared-outcome', 0.25), 0.0625);
});

test('chance-adjusted: (e - r) / (1 - r), clamped at 0', () => {
  // 0.45 above an r of 0.25: (0.45 - 0.25) / 0.75 = 0.2666….
  assert.ok(Math.abs(transformOutcomeEpisode('chance-adjusted', 0.45, 0.25) - (0.45 - 0.25) / (1 - 0.25)) < 1e-12);
  // Below chance clamps to 0, never negative.
  assert.equal(transformOutcomeEpisode('chance-adjusted', 0.2, 0.25), 0);
  // Exactly at chance is 0; a baseline of 0 is the identity.
  assert.equal(transformOutcomeEpisode('chance-adjusted', 0.25, 0.25), 0);
  assert.equal(transformOutcomeEpisode('chance-adjusted', 1, 0), 1);
});

test('chance-adjusted: r at or near 1 refuses by name', () => {
  assertRefuses(() => transformOutcomeEpisode('chance-adjusted', 0.5, 1), 'chance-baseline-degenerate');
  assertRefuses(
    () => transformOutcomeEpisode('chance-adjusted', 0.5, 1 - CHANCE_DENOMINATOR_FLOOR / 2),
    'chance-baseline-degenerate'
  );
  // Just outside the floor is fine.
  assert.ok(Number.isFinite(transformOutcomeEpisode('chance-adjusted', 0.5, 1 - CHANCE_DENOMINATOR_FLOOR * 2)));
});

test('rhae-v1: the episode score is untouched', () => {
  assert.equal(transformOutcomeEpisode('rhae-v1', 0.384028), 0.384028);
});

//
// Byte-identical default output, pinned against the pre-profiles scorer.
// `fixtures.rhae-v1.snapshot.json` is the JSON.stringify of score()'s result
// on these exact episodes, captured before the profiles layer existed.
//

const SNAPSHOT = JSON.parse(readFileSync(join(here, 'fixtures.rhae-v1.snapshot.json'), 'utf8'));
const SNAPSHOT_GAMES = [tictactoe, connect4];
const SNAPSHOT_SUITE = buildSuite(SNAPSHOT_GAMES, { split: 'public', id: 'byte-snapshot-suite' });

/**
 * Replay the snapshot's episodes: the first public seed of every tier of
 * tictactoe and connect4, random agent.
 *
 * @returns {Promise<Trajectory[]>}
 */
async function snapshotTrajectories() {
  const trajectories = [];
  for (const sg of SNAPSHOT_SUITE.games) {
    const game = /** @type {Game<*>} */ (SNAPSHOT_GAMES.find((g) => g.spec.id === sg.id));
    for (const st of sg.tiers) {
      const tier = /** @type {*} */ (game.spec.tiers.find((t) => t.id === st.id));
      const seed = st.seeds[0];
      trajectories.push(
        await runEpisodePublic(game, tier, seed)
      );
    }
  }
  return trajectories;
}

/**
 * @param {Game<*>} game
 * @param {*} tier
 * @param {string} seed
 * @returns {Promise<Trajectory>}
 */
async function runEpisodePublic(game, tier, seed) {
  const { runEpisode } = await import('../core/runner.js');
  return runEpisode({
    game,
    tierId: tier.id,
    seed,
    split: 'public',
    agent: createRandomAgent({ episodeSeed: seed }),
  });
}

test('default output is byte-identical to the pre-profiles scorer', async () => {
  const trajectories = await snapshotTrajectories();
  const result = await score(SNAPSHOT_SUITE, trajectories, SNAPSHOT_GAMES, {
    agent: { id: 'random', track: 'baseline' },
  });
  // No profile block on the default path — the key must not exist at all.
  assert.equal(/** @type {*} */ (result).scoring, undefined);
  assert.equal(JSON.stringify(result), JSON.stringify(SNAPSHOT));
});

test('explicit rhae-v1 scores identically but names the profile', async () => {
  const trajectories = await snapshotTrajectories();
  const result = await score(SNAPSHOT_SUITE, trajectories, SNAPSHOT_GAMES, {
    agent: { id: 'random', track: 'baseline' },
    profile: 'rhae-v1',
  });
  const { scoring, ...rest } = /** @type {*} */ (result);
  assert.deepEqual(scoring, { profile: 'rhae-v1' });
  assert.equal(JSON.stringify(rest), JSON.stringify(SNAPSHOT));
});

//
// score()-level formulas on the take-or-pass outcome fixture: "take" scores
// normalized 1, "pass" scores 0.25, one outcome tier, two public seeds.
//

const TAKE_GAMES = [takeOrPass];
const TAKE_SUITE = buildSuite(TAKE_GAMES, { split: 'public', id: 'profiles-take-suite' });
const TAKE_SEEDS = /** @type {string[]} */ (TAKE_SUITE.games[0].tiers[0].seeds);

/**
 * @param {string[]} responsesPerSeed "take" or "pass" per public seed.
 * @param {string} [agentId] Entry agent id — must match what score() sees.
 * @returns {(gameId: string, tierId: string, seed: string) => Agent}
 */
function scriptedBySeed(responsesPerSeed, agentId = 'agent-mixed') {
  return (gameId, _tierId, seed) => {
    const response = responsesPerSeed[TAKE_SEEDS.indexOf(seed)];
    return scriptedAgent([response], { id: agentId, track: 'community' });
  };
}

/** @type {{ format: string, agent: string, split: string, games: Record<string, unknown> }} */
const TAKE_BASELINE = {
  format: BASELINE_FORMAT,
  agent: 'random',
  split: 'public',
  games: {
    'take-or-pass': {
      id: 'take-or-pass',
      version: '1.0.0',
      benchmark: true,
      tiers: {
        main: { scoring: 'outcome', mean: 0.25, ci95: [0, 0.5], episodes: 2 },
      },
    },
  },
};

test('take-or-pass through every profile, by hand', async () => {
  // One take, one pass: rhae-v1 tier mean is (1 + 0.25) / 2 = 0.625.
  const trajectories = await runSuite(TAKE_SUITE, TAKE_GAMES, scriptedBySeed(['take', 'pass']));
  const rhae = await score(TAKE_SUITE, trajectories, TAKE_GAMES, { agent: { id: 'agent-mixed', track: 'community' } });
  assert.equal(/** @type {number} */ (rhae.games['take-or-pass'].tiers.main.score.value), 0.625);

  // chance-adjusted with r = 0.25: take -> 1, pass -> 0, mean 0.5. The
  // scoring block names the profile and the baseline's hash.
  const chance = await score(TAKE_SUITE, trajectories, TAKE_GAMES, {
    agent: { id: 'agent-mixed', track: 'community' },
    profile: 'chance-adjusted',
    baseline: /** @type {*} */ (TAKE_BASELINE),
    baselineSha256: 'abc123',
  });
  assert.equal(/** @type {number} */ (chance.games['take-or-pass'].tiers.main.score.value), 0.5);
  assert.deepEqual(/** @type {*} */ (chance).scoring, { profile: 'chance-adjusted', baselineSha256: 'abc123' });

  // squared-outcome: 1² and 0.25², mean (1 + 0.0625) / 2 = 0.53125.
  const squared = await score(TAKE_SUITE, trajectories, TAKE_GAMES, {
    agent: { id: 'agent-mixed', track: 'community' },
    profile: 'squared-outcome',
  });
  assert.equal(/** @type {number} */ (squared.games['take-or-pass'].tiers.main.score.value), 0.53125);
  assert.deepEqual(/** @type {*} */ (squared).scoring, { profile: 'squared-outcome' });
});

test('all-take and all-pass entries: chance-adjusted pins an at-chance agent to 0', async () => {
  // Random play on this fixture takes about r = 0.25 of the time; an agent
  // that does exactly as well as that baseline must score 0, not 0.25.
  const passTrajectories = await runSuite(
    TAKE_SUITE,
    TAKE_GAMES,
    scriptedBySeed(['pass', 'pass'], 'agent-pass')
  );
  const chance = await score(TAKE_SUITE, passTrajectories, TAKE_GAMES, {
    agent: { id: 'agent-pass', track: 'community' },
    profile: 'chance-adjusted',
    baseline: /** @type {*} */ (TAKE_BASELINE),
  });
  assert.equal(/** @type {number} */ (chance.games['take-or-pass'].tiers.main.score.value), 0);
});

test('chance-adjusted leaves efficiency tiers untouched', async () => {
  const GAMES = [countdown, takeOrPass];
  const suite = buildSuite(GAMES, { split: 'public', id: 'profiles-eff-suite' });
  const agent = /** @type {(gameId: string, tierId: string, seed: string) => Agent} */ (
    (gameId, _tierId, _seed) =>
    gameId === 'countdown' ? scriptedAgent(['dec'], { id: 'agent-dec' }) : scriptedAgent(['take'], { id: 'agent-dec' })
  );
  const trajectories = await runSuite(suite, GAMES, agent);
  const rhae = await score(suite, trajectories, GAMES, { agent: { id: 'agent-dec', track: 'community' } });
  const chance = await score(suite, trajectories, GAMES, {
    agent: { id: 'agent-dec', track: 'community' },
    profile: 'chance-adjusted',
    baseline: /** @type {*} */ (TAKE_BASELINE),
  });
  assert.deepEqual(chance.games.countdown, rhae.games.countdown);
  assert.deepEqual(/** @type {*} */ (chance).scoring, { profile: 'chance-adjusted' });
});

//
// Refusals.
//

test('chance-adjusted without a baseline refuses by name', async () => {
  const trajectories = await runSuite(TAKE_SUITE, TAKE_GAMES, scriptedBySeed(['take', 'pass']));
  await assertRefuses(
    () =>
      score(TAKE_SUITE, trajectories, TAKE_GAMES, {
        agent: { id: 'agent-mixed', track: 'community' },
        profile: 'chance-adjusted',
      }),
    'profile-baseline-required'
  );
});

test('scoring with a baseline from a different game version refuses by name', async () => {
  const trajectories = await runSuite(TAKE_SUITE, TAKE_GAMES, scriptedBySeed(['take', 'pass']));
  const stale = /** @type {*} */ (
    JSON.parse(JSON.stringify(TAKE_BASELINE))
  );
  stale.games['take-or-pass'].version = '0.9.0';
  await assertRefuses(
    () =>
      score(TAKE_SUITE, trajectories, TAKE_GAMES, {
        agent: { id: 'agent-mixed', track: 'community' },
        profile: 'chance-adjusted',
        baseline: stale,
      }),
    'baseline-version'
  );
});

test('scoring with a baseline missing the tier refuses by name', async () => {
  const trajectories = await runSuite(TAKE_SUITE, TAKE_GAMES, scriptedBySeed(['take', 'pass']));
  const partial = /** @type {*} */ (JSON.parse(JSON.stringify(TAKE_BASELINE)));
  delete partial.games['take-or-pass'].tiers.main;
  await assertRefuses(
    () =>
      score(TAKE_SUITE, trajectories, TAKE_GAMES, {
        agent: { id: 'agent-mixed', track: 'community' },
        profile: 'chance-adjusted',
        baseline: partial,
      }),
    'baseline-tier-missing'
  );
});

test('an r at or near 1 refuses by name through score()', async () => {
  const trajectories = await runSuite(TAKE_SUITE, TAKE_GAMES, scriptedBySeed(['take', 'pass']));
  const degenerate = /** @type {*} */ (JSON.parse(JSON.stringify(TAKE_BASELINE)));
  degenerate.games['take-or-pass'].tiers.main.mean = 1;
  await assertRefuses(
    () =>
      score(TAKE_SUITE, trajectories, TAKE_GAMES, {
        agent: { id: 'agent-mixed', track: 'community' },
        profile: 'chance-adjusted',
        baseline: degenerate,
      }),
    'chance-baseline-degenerate'
  );
});

test('an unknown profile refuses by name through score()', async () => {
  const trajectories = await runSuite(TAKE_SUITE, TAKE_GAMES, scriptedBySeed(['take', 'pass']));
  await assertRefuses(
    () =>
      score(TAKE_SUITE, trajectories, TAKE_GAMES, {
        agent: { id: 'agent-mixed', track: 'community' },
        profile: 'elo',
      }),
    'profile-unknown'
  );
});

//
// The leaderboard: one board, one profile.
//

test('leaderboard: default board carries no scoring block; non-default does', async () => {
  const trajectories = await runSuite(TAKE_SUITE, TAKE_GAMES, scriptedBySeed(['take', 'take']));
  const entry = { agent: { id: 'agent-mixed', track: 'community' }, trajectories };

  const def = await leaderboard(TAKE_SUITE, [entry], TAKE_GAMES);
  assert.equal(/** @type {*} */ (def.leaderboard).scoring, undefined);

  const squared = await leaderboard(TAKE_SUITE, [entry], TAKE_GAMES, {
    profile: 'squared-outcome',
    baselineSha256: 'abc123',
  });
  assert.deepEqual(/** @type {*} */ (squared.leaderboard).scoring, {
    profile: 'squared-outcome',
    baselineSha256: 'abc123',
  });
});

test('leaderboard: entries under different profiles refuse to rank together, naming both', async () => {
  const takeTrajectories = await runSuite(
    TAKE_SUITE,
    TAKE_GAMES,
    scriptedBySeed(['take', 'take'], 'agent-a')
  );
  const passTrajectories = await runSuite(
    TAKE_SUITE,
    TAKE_GAMES,
    scriptedBySeed(['pass', 'pass'], 'agent-b')
  );
  try {
    await leaderboard(TAKE_SUITE, [
      { agent: { id: 'agent-a', track: 'community' }, trajectories: takeTrajectories },
      {
        agent: { id: 'agent-b', track: 'community' },
        trajectories: passTrajectories,
        profile: 'chance-adjusted',
        baseline: /** @type {*} */ (TAKE_BASELINE),
      },
    ], TAKE_GAMES);
    assert.fail('expected a profile-mismatch refusal');
  } catch (error) {
    assert.ok(error instanceof GauntletRefusalError);
    assert.equal(/** @type {GauntletRefusalError} */ (error).step, 'profile-mismatch');
    const message = /** @type {Error} */ (error).message;
    assert.ok(message.includes('agent-a') && message.includes('chance-adjusted') && message.includes('rhae-v1'),
      `the refusal must name the offending entry and both profiles, got: ${message}`);
  }
});

test('leaderboard: a uniform chance-adjusted board ranks without refusal', async () => {
  const passTrajectories = await runSuite(
    TAKE_SUITE,
    TAKE_GAMES,
    scriptedBySeed(['pass', 'pass'], 'agent-pass')
  );
  const takeTrajectories = await runSuite(
    TAKE_SUITE,
    TAKE_GAMES,
    scriptedBySeed(['take', 'take'], 'agent-take')
  );
  const { leaderboard: board } = await leaderboard(TAKE_SUITE, [
    {
      agent: { id: 'agent-take', track: 'community' },
      trajectories: takeTrajectories,
      profile: 'chance-adjusted',
      baseline: /** @type {*} */ (TAKE_BASELINE),
    },
    {
      agent: { id: 'agent-pass', track: 'community' },
      trajectories: passTrajectories,
      profile: 'chance-adjusted',
      baseline: /** @type {*} */ (TAKE_BASELINE),
    },
  ], TAKE_GAMES);
  assert.equal(board.tracks.community[0].agent.id, 'agent-take');
  assert.equal(/** @type {number} */ (board.tracks.community[0].benchmarkScore?.value), 1);
  assert.equal(/** @type {number} */ (board.tracks.community[1].benchmarkScore?.value), 0);
});

//
// The committed baseline file.
//

test('baselines/random-public.json loads, validates, and hashes to its own bytes', () => {
  const path = join(here, 'baselines', 'random-public.json');
  const { baseline, sha256 } = loadBaselineFile(path);
  assert.equal(baseline.format, BASELINE_FORMAT);
  assert.equal(baseline.agent, 'random');
  assert.match(sha256, /^[0-9a-f]{64}$/);
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  assert.equal(sha256, actual);
  validateBaseline(baseline);
});

test('the committed baseline matches the calibration tables', () => {
  const { baseline } = loadBaselineFile(join(here, 'baselines', 'random-public.json'));
  // Spot values read straight off calibration/tables/2048.json.
  const game2048 = /** @type {*} */ (baseline.games['2048']);
  assert.equal(game2048.version, '1.0.0');
  assert.equal(game2048.benchmark, true);
  assert.equal(game2048.tiers.t256.mean, 0.384028);
  assert.equal(game2048.tiers.t2048.episodes, 20);
  // Every calibration game is present, including the smoke game.
  for (const gameId of ['2048', 'chess', 'connect4', 'holdem', 'mastermind', 'minesweeper', 'sliding', 'sokoban', 'tictactoe']) {
    assert.ok(baseline.games[gameId], `baseline is missing game ${gameId}`);
  }
});
