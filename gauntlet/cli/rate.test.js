/**
 * Unit tests for the `gauntlet rate` building blocks: the Elo ladder file
 * loader (`cli/rate.js`) against hermetic fixture files, and the agent
 * grouping + rating rows the command prints. Subprocess end-to-end coverage
 * lives in test/integration/cli-rate-e2e.test.js.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { groupAndRate, loadLeaderboardLadder, loadRatingLadder } from './rate.js';

const VALID_LADDER = {
  meta: { anchor: { rung: 'chess-paper', rating: 1000 } },
  fit: {
    ratings: { 'chess-paper': 1000, 'chess-stockfish-sf-10k': 2800 },
    intervals: {},
    meta: {},
    error: null,
  },
};

/**
 * A minimal trajectory carrying only the fields `groupAndRate` and
 * `rateAgent` read.
 *
 * @param {string} agent
 * @param {string} gameId
 * @param {string} tier
 * @param {number} mine The agent seat's normalized score.
 */
function trajectory(agent, gameId, tier, mine) {
  return {
    game: { id: gameId },
    tier,
    agent: { id: agent, seat: 0 },
    end: { outcome: { normalized: [mine, 1 - mine] } },
  };
}

test('loadRatingLadder accepts a well-formed ladder-results file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-rate-unit-'));
  try {
    const path = join(dir, 'ladder.json');
    writeFileSync(path, JSON.stringify(VALID_LADDER));
    assert.deepEqual(loadRatingLadder(path), {
      ratings: { 'chess-paper': 1000, 'chess-stockfish-sf-10k': 2800 },
      anchorRung: 'chess-paper',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRatingLadder: a missing file errors with "run rating/ladder.js first"', () => {
  assert.throws(
    () => loadRatingLadder(join(tmpdir(), 'gauntlet-no-such-ladder.json')),
    /run rating\/ladder\.js first/
  );
});

test('loadRatingLadder refuses mangled files loudly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-rate-unit-'));
  try {
    const cases = {
      'bad-json.json': '{not json',
      'no-fit.json': JSON.stringify({ meta: { anchor: { rung: 'chess-paper' } } }),
      'non-numeric.json': JSON.stringify({
        meta: { anchor: { rung: 'chess-paper' } },
        fit: { ratings: { 'chess-paper': 'high' } },
      }),
      'anchor-unknown.json': JSON.stringify({
        meta: { anchor: { rung: 'chess-wood' } },
        fit: { ratings: { 'chess-paper': 1000 }, error: null },
      }),
      'failed-fit.json': JSON.stringify({
        meta: { anchor: { rung: 'chess-paper' } },
        fit: { ratings: { 'chess-paper': 1000 }, error: 'diverged' },
      }),
    };
    for (const [name, body] of Object.entries(cases)) {
      const path = join(dir, name);
      writeFileSync(path, body);
      if (name === 'bad-json.json') {
        assert.throws(() => loadRatingLadder(path), /not valid JSON/);
      } else {
        assert.throws(() => loadRatingLadder(path), /rating\/ladder\.js first/);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadLeaderboardLadder: undefined for a missing file, the package ladder otherwise', () => {
  assert.equal(loadLeaderboardLadder(join(tmpdir(), 'gauntlet-no-such-ladder.json')), undefined);
  // The repo's committed ladder-results file: anchor chess-paper pinned at 1000.
  const ladder = loadLeaderboardLadder();
  assert.ok(ladder, 'the package ships rating/ladder-results.json');
  assert.equal(ladder?.anchorRung, 'chess-paper');
  assert.equal(ladder?.ratings['chess-paper'], 1000);
});

test('groupAndRate pre-filters off-ladder trajectories and rates the rest', () => {
  const ladder = { ratings: VALID_LADDER.fit.ratings, anchorRung: 'chess-paper' };
  const rows = groupAndRate(
    [
      trajectory('mixed', 'chess', 'paper', 1),
      trajectory('mixed', 'chess', 'stockfish-sf-10k', 0),
      trajectory('all-wins', 'chess', 'paper', 1),
      trajectory('all-wins', 'chess', 'paper', 1),
      trajectory('all-wins', 'connect4', 'ladder-1', 1),
      trajectory('off-ladder-only', 'connect4', 'ladder-1', 1),
    ],
    ladder
  );
  assert.deepEqual(
    rows.map((row) => row.agent),
    ['all-wins', 'mixed', 'off-ladder-only']
  );
  const [allWins, mixed, offLadder] = rows;

  // The connect4 win is skipped and reported, not a rateAgent refusal; the
  // two chess-paper wins still diverge.
  assert.equal(allWins.games, 2);
  assert.equal(allWins.skipped, 1);
  assert.deepEqual(allWins.skippedRungs, ['connect4-ladder-1']);
  assert.equal(allWins.rating?.direction, 'wins-everything');
  assert.equal(allWins.rating?.rating, null);

  // A win against the paper anchor and a loss against the sf-10k rung lands
  // strictly between them, with a finite rating.
  assert.equal(mixed.games, 2);
  assert.equal(mixed.skipped, 0);
  assert.equal(mixed.rating?.direction, null);
  assert.ok(typeof mixed.rating?.rating === 'number');
  assert.ok(mixed.rating.rating > 1000 && mixed.rating.rating < 2800);

  // An agent with nothing on the ladder gets a zero-game row, not a throw.
  assert.equal(offLadder.games, 0);
  assert.equal(offLadder.rating, null);
  assert.equal(offLadder.skipped, 1);
});
