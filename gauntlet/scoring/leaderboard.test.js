/**
 * Tests for the leaderboard builder (scoring/leaderboard.js). Runs the full
 * fixture suite through the real runner for six entries across the three
 * tracks, including an official-track agent that must pick actions from the
 * observation text alone (no legal-action list) and a tampered entry that is
 * refused outright.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { leaderboard, LEADERBOARD_FORMAT } from './leaderboard.js';
import { buildSuite } from './suite.js';
import { countdown, takeOrPass, makeSlotGame, scriptedAgent, runSuite } from './fixtures.js';
import { createRandomAgent } from '../agents/random.js';
import { score, GauntletRefusalError } from './score.js';

/** @import { Agent } from '../core/types.js' */

const GAMES = [countdown, takeOrPass, makeSlotGame(2)];
const SUITE = buildSuite(GAMES, { split: 'public', id: 'leaderboard-test-suite' });
const gameList = GAMES;

/**
 * Official-track agent: no legal-action list is provided on the official
 * track, so it extracts the choices from the fixture games' observation
 * texts ("... Actions: dec, dec2, wait." / "Choose: take, pass.") and
 * reports usage on every step.
 *
 * @param {string} id
 * @returns {Agent}
 */
function officialAgent(id) {
  /** @type {Agent} */
  return {
    id,
    track: 'official',
    act: async (ctx) => {
      const text = ctx.observation?.text ?? '';
      const match = /(?:Actions|Choose): ([^.]+)\./.exec(text);
      const choice = match ? match[1].trim().split(', ')[0] : 'wait';
      return {
        text: choice,
        usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.002 },
      };
    },
  };
}

test('leaderboard: ranking, tracks, costs, unranked entries, JSON and Markdown', async () => {
  /** @type {Array<{ agent: { id: string, track: 'official' | 'community' | 'baseline' }, trajectories: import('../core/types.js').Trajectory[] }>} */
  const entries = [];

  // Official #1: first-legal agent, reports usage on every step.
  const winnerAgent = officialAgent('frontier-y');
  entries.push({
    agent: { id: 'frontier-y', track: 'official' },
    trajectories: await runSuite(SUITE, gameList, () => winnerAgent),
  });

  // Official #2: always "wait" — forfeits everywhere, still a valid entry.
  entries.push({
    agent: { id: 'frontier-x', track: 'official' },
    trajectories: await runSuite(SUITE, gameList, () =>
      scriptedAgent(['wait'], { id: 'frontier-x', track: 'official' })
    ),
  });

  // Community: takes everything.
  entries.push({
    agent: { id: 'harness-z', track: 'community' },
    trajectories: await runSuite(SUITE, gameList, () =>
      scriptedAgent(['take'], { id: 'harness-z', track: 'community' })
    ),
  });

  // Baseline: the real random agent.
  entries.push({
    agent: { id: 'random', track: 'baseline' },
    trajectories: await runSuite(SUITE, gameList, (gameId, tierId, seed) =>
      createRandomAgent({ episodeSeed: seed })
    ),
  });

  // Dry-run official entry: listed, unranked.
  entries.push({
    agent: { id: 'dry-run', track: 'official' },
    trajectories: await runSuite(SUITE, gameList, () =>
      scriptedAgent(['take'], { id: 'dry-run', track: 'official', dryRun: true })
    ),
  });

  // Partial coverage: unranked, no benchmark score.
  entries.push({
    agent: { id: 'partial', track: 'official' },
    trajectories: await runSuite(SUITE, gameList, () =>
      scriptedAgent(['take'], { id: 'partial', track: 'official' })
    ).then((all) => all.filter((t) => t.game.id === 'take-or-pass')),
  });

  const { leaderboard: board, markdown } = await leaderboard(SUITE, entries, gameList);

  assert.equal(board.format, LEADERBOARD_FORMAT);
  assert.equal(board.suite.id, 'leaderboard-test-suite');
  assert.equal(board.suite.split, 'public');
  assert.equal(board.suite.saltCommitment, null);
  assert.match(board.generatedAt, /^\d{4}-\d{2}-\d{2}T/);

  // Official track: ranked entries by score, then the unranked ones.
  assert.equal(board.tracks.official.length, 4);
  assert.deepEqual(
    board.tracks.official.map((e) => [e.agent.id, e.rank, e.ranked]),
    [
      ['frontier-y', 1, true],
      ['frontier-x', 2, true],
      ['dry-run', null, false],
      ['partial', null, false],
    ]
  );
  assert.match(/** @type {string} */ (board.tracks.official[2].unrankedReason), /dry-run/);
  assert.match(/** @type {string} */ (board.tracks.official[3].unrankedReason), /missing episodes/);
  assert.equal(board.tracks.official[3].benchmarkScore, null);
  // The winner strictly outscores the all-forfeit runner-up.
  const winner = board.tracks.official[0];
  const runnerUp = board.tracks.official[1];
  assert.ok(
    /** @type {number} */ (winner.benchmarkScore?.value) >
      /** @type {number} */ (runnerUp.benchmarkScore?.value),
    'frontier-y should outrank frontier-x'
  );

  // Community and baseline tracks.
  assert.equal(board.tracks.community.length, 1);
  assert.equal(board.tracks.community[0].rank, 1);
  assert.equal(board.tracks.baseline.length, 1);
  assert.equal(board.tracks.baseline[0].rank, 1);

  // Costs: the winner reports usage everywhere; the random baseline reports
  // none, so its cost is unknown.
  assert.equal(typeof winner.costUsd, 'number');
  assert.ok(/** @type {number} */ (winner.costUsd) > 0);
  assert.equal(board.tracks.baseline[0].costUsd, 'unknown');

  // Per-game scores present, cost per episode consistent.
  assert.ok(winner.games.slot && winner.games['take-or-pass']);
  assert.ok(
    Math.abs(
      /** @type {number} */ (winner.costPerEpisodeUsd) -
        /** @type {number} */ (winner.costUsd) / winner.episodes
    ) < 1e-6
  );

  // score-vs-cost series: entries with scores, per track.
  assert.deepEqual(
    board.scoreVsCost.official.map((p) => [p.agent, p.ranked]),
    [
      ['frontier-y', true],
      ['frontier-x', true],
    ]
  );
  assert.deepEqual(board.scoreVsCost.community.map((p) => p.agent), ['harness-z']);
  assert.deepEqual(board.scoreVsCost.baseline.map((p) => p.agent), ['random']);

  // Markdown: one section per track plus the score-vs-cost tables.
  for (const heading of [
    '## Official track',
    '## Community track',
    '## Baseline track',
    '### Score versus cost — official track',
    '### Unranked — official track',
    'frontier-y',
    'missing episodes',
  ]) {
    assert.ok(markdown.includes(heading), `markdown should contain ${JSON.stringify(heading)}`);
  }
});

test('leaderboard: agent labels with Markdown metacharacters render escaped, not as formatting', async () => {
  // An agent id is data, not Markdown: a raw `|` would shift every following
  // table column, `*`/`_` would flip emphasis, a newline would split the row.
  const hostile = 'evil|id\nline *x*_y_';
  const entries = [
    {
      agent: { id: hostile, track: 'official' },
      trajectories: await runSuite(SUITE, gameList, () => officialAgent(hostile)),
    },
  ];
  const { markdown } = await leaderboard(SUITE, entries, gameList);
  assert.ok(
    markdown.includes('evil\\|id<br>line \\*x\\*\\_y\\_'),
    'pipe, newline, star and underscore all render escaped inside one row',
  );
  assert.ok(!markdown.includes('evil|id'), 'the raw id never reaches the Markdown');
});

test('leaderboard: an entry whose trajectories fail verification is refused, not listed', async () => {
  const good = await runSuite(SUITE, gameList, () =>
    scriptedAgent(['take'], { id: 'honest', track: 'community' })
  );
  const tampered = good.map((t) =>
    t.game.id === 'take-or-pass' && t.steps[0].action === 'take'
      ? { ...t, steps: [{ ...t.steps[0], action: 'pass' }] }
      : t
  );
  await assert.rejects(
    () =>
      leaderboard(
        SUITE,
        [{ agent: { id: 'honest', track: 'community' }, trajectories: tampered }],
        gameList
      ),
    (err) => {
      assert.ok(err instanceof GauntletRefusalError);
      assert.match(err.message, /trajectory-verification/);
      return true;
    }
  );
});

test('leaderboard: an unknown track is refused', async () => {
  const trajectories = await runSuite(SUITE, gameList, () =>
    scriptedAgent(['take'], { id: 'someone' })
  );
  await assert.rejects(
    () =>
      leaderboard(
        SUITE,
        [
          {
            agent: { id: 'someone', track: /** @type {*} */ ('rogue') },
            trajectories,
          },
        ],
        gameList
      ),
    /leaderboard\.js\] track/
  );
});

// Reference the imported score helper through the same refusal path the
// leaderboard uses, keeping the import list meaningful.
void score;

test('leaderboard: the chess rating column renders only with a ladder and never changes ranking', async () => {
  const entries = [
    {
      agent: { id: 'frontier-y', track: 'official' },
      trajectories: await runSuite(SUITE, gameList, () => officialAgent('frontier-y')),
    },
    {
      agent: { id: 'harness-z', track: 'community' },
      trajectories: await runSuite(SUITE, gameList, () =>
        scriptedAgent(['take'], { id: 'harness-z', track: 'community' })
      ),
    },
  ];

  const plain = await leaderboard(SUITE, entries, gameList);
  assert.ok(!plain.markdown.includes('Chess rating'), 'no rating column without a ladder');
  assert.ok(plain.leaderboard.tracks.official.every((entry) => entry.rating === undefined));

  // A ladder that knows none of the fixture rungs: the column renders, every
  // cell is '—', and no entry gains a rating.
  const unknownRungs = await leaderboard(SUITE, entries, gameList, {
    ratingLadder: { ratings: { 'chess-paper': 1000 }, anchorRung: 'chess-paper' },
  });
  assert.ok(unknownRungs.markdown.includes('Chess rating (95% CI)'));
  assert.ok(unknownRungs.leaderboard.tracks.official.every((entry) => entry.rating === undefined));
  const unknownRow = unknownRungs.markdown
    .split('\n')
    .find((line) => line.includes('| frontier-y |'));
  assert.ok(unknownRow && unknownRow.trim().endsWith('| — |'));

  // A ladder over the fixture rungs rates both entries — and leaves ranks,
  // ranking eligibility, and scores identical to the ladder-free board.
  const fixtureLadder = {
    ratings: {
      'take-or-pass-main': 1200,
      'countdown-reference-par': 900,
      'countdown-optimal-par': 1500,
      'slot-main': 1100,
    },
    anchorRung: 'take-or-pass-main',
  };
  const rated = await leaderboard(SUITE, entries, gameList, { ratingLadder: fixtureLadder });
  const official = rated.leaderboard.tracks.official;
  assert.ok(
    official.every(
      (entry) => typeof entry.rating?.rating === 'number' && entry.rating.games === entry.episodes
    )
  );
  assert.deepEqual(
    official.map((entry) => [entry.agent.id, entry.rank, entry.ranked, entry.benchmarkScore]),
    plain.leaderboard.tracks.official.map((entry) => [
      entry.agent.id,
      entry.rank,
      entry.ranked,
      entry.benchmarkScore,
    ])
  );
  const ratedRow = rated.markdown.split('\n').find((line) => line.includes('| frontier-y |'));
  assert.ok(ratedRow && !ratedRow.trim().endsWith('| — |'), 'a rated entry shows a rating, not —');
});
