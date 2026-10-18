/**
 * Unit tests for the absolute-fit helpers (rating/absolute-lib.js): the
 * swept-only exclusion predicate — a player is information-free for the
 * anchored fit exactly when they scored or conceded zero points across all
 * their games — and the merge-from carried-settings derivation (a prior
 * results file's levels and games-per-colour describe its saved games, so a
 * refit must restore them instead of keeping the current CLI flags).
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweptOnlyPlayers, carriedSettings } from './absolute-lib.js';

test('a decisive player with wins and losses but no draws is kept', () => {
  // The committed-data shape: sf-elo-1700 went 1-31 in 32 games with no
  // draws, yet the earlier draw-only "mixed evidence" test dropped every one
  // of its games. A win plus a loss is finite-rating evidence; only total
  // sweeps are information-free.
  const games = [
    { a: 'sf-elo-1700', b: 'chess-wood', score: 1 }, // the one win in 32
    ...Array.from({ length: 31 }, (_, i) =>
      i % 2 === 0
        ? { a: 'sf-elo-1700', b: 'chess-wood', score: 0 }
        : { a: 'chess-wood', b: 'sf-elo-1700', score: 1 }
    ),
    { a: 'chess-paper', b: 'chess-wood', score: 0.5 },
  ];
  const swept = sweptOnlyPlayers(games);
  assert.ok(!swept.includes('sf-elo-1700'), 'a 1/32 decisive player has finite evidence');
  assert.ok(!swept.includes('chess-wood'));
  assert.ok(!swept.includes('chess-paper'));
});

test('a player who lost every game is excluded (rating -inf)', () => {
  const games = [
    { a: 'chess-sand', b: 'chess-paper', score: 0 },
    { a: 'chess-paper', b: 'chess-sand', score: 1 },
    { a: 'chess-paper', b: 'chess-wood', score: 0.5 },
  ];
  assert.deepEqual(sweptOnlyPlayers(games), ['chess-sand']);
});

test('a player who won every game is excluded (rating +inf)', () => {
  const games = [
    { a: 'chess-god', b: 'chess-paper', score: 1 },
    { a: 'chess-paper', b: 'chess-god', score: 0 },
    { a: 'chess-paper', b: 'chess-wood', score: 0.25 },
  ];
  assert.deepEqual(sweptOnlyPlayers(games), ['chess-god']);
});

test('draw-only evidence is kept', () => {
  const games = [{ a: 'd', b: 'anchor', score: 0.5 }];
  assert.deepEqual(sweptOnlyPlayers(games), []);
});

test('every information-free player is reported, sorted', () => {
  const games = [
    { a: 'allloss', b: 'anchor', score: 0 },
    { a: 'anchor', b: 'allwin', score: 0 },
    { a: 'anchor', b: 'keep', score: 0.5 },
  ];
  assert.deepEqual(sweptOnlyPlayers(games), ['allloss', 'allwin']);
});

test('no games, no players', () => {
  assert.deepEqual(sweptOnlyPlayers([]), []);
});

test('carried levels and games-per-colour come from the prior meta when they match the saved rungs', () => {
  const prior = {
    meta: { levels: [1500, 1320], gamesPerColour: 8 },
    levels: {
      'sf-elo-1320-vs-chess-wood': {},
      'sf-elo-1320-vs-chess-stockfish-sf-1k': {},
      'sf-elo-1500-vs-chess-wood': {},
      'sf-elo-1500-vs-chess-stockfish-sf-1k': {},
    },
  };
  const carried = carriedSettings(prior);
  assert.deepEqual(carried.levels, [1320, 1500], 'ascending, whatever order the meta kept');
  assert.equal(carried.gamesPerColour, 8);
});

test('prior levels naming rungs with no saved games fall back to deriving from the keys', () => {
  const prior = {
    meta: { levels: [1320, 1500, 9999] },
    levels: {
      'sf-elo-1320-vs-chess-wood': {},
      'sf-elo-1500-vs-chess-wood': {},
    },
  };
  assert.deepEqual(carriedSettings(prior).levels, [1320, 1500]);
});

test('a prior file without meta.levels derives the levels from the saved rungs', () => {
  const prior = {
    levels: {
      'sf-elo-2300-vs-chess-wood': {},
      'sf-elo-1320-vs-chess-stockfish-sf-1k': {},
      'sf-elo-1320-vs-chess-wood': {},
    },
  };
  const carried = carriedSettings(prior);
  assert.deepEqual(carried.levels, [1320, 2300]);
  assert.equal(carried.gamesPerColour, null);
});

test('gamesPerColour passes through only when the prior records a positive integer', () => {
  const keys = { 'sf-elo-1320-vs-chess-wood': {} };
  assert.equal(carriedSettings({ levels: keys }).gamesPerColour, null, 'absent');
  assert.equal(carriedSettings({ meta: {}, levels: keys }).gamesPerColour, null, 'absent meta');
  assert.equal(carriedSettings({ meta: { gamesPerColour: 0 }, levels: keys }).gamesPerColour, null, 'zero');
  assert.equal(carriedSettings({ meta: { gamesPerColour: 2.5 }, levels: keys }).gamesPerColour, null, 'fractional');
  assert.equal(carriedSettings({ meta: { gamesPerColour: '8' }, levels: keys }).gamesPerColour, null, 'string');
  assert.equal(carriedSettings({ meta: { gamesPerColour: 20 }, levels: keys }).gamesPerColour, 20, 'recorded');
});
