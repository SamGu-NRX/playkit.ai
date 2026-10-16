import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEpisode } from '../core/runner.js';
import { getGame } from '../games/index.js';
import { createScriptedAgent } from '../harness/dry-run.js';
import {
  CompareRefusedError,
  compareBundles,
  compareTrajectories,
  episodeScoreOf,
  signTestP,
} from './compare.js';
import { EFFICIENCY_CAP_OPTIMAL, EFFICIENCY_CAP_REFERENCE } from '../scoring/score.js';

const game = getGame('tictactoe');

// A fixed replay that never starves: every entry is a legal cell name, the
// episode ends (win, draw or the 20-attempt budget) long before the script
// runs out, and later occupied-cell replies simply land as invalid attempts.
// Independent of committed fixtures, so game-version recalibration cannot
// break these tests.
const OPENING = [
  'a1', 'c1', 'b2', 'c3', 'a3', 'b1', 'c2', 'b3', 'a1', 'b2',
  'c1', 'a2', 'a3', 'c3', 'b1', 'b3', 'c2', 'a2', 'a1', 'b1',
  'c2', 'a3', 'b2', 'c3',
];
const DIVERGING = ['c3', ...OPENING.slice(1)];

/**
 * @param {string[]} script
 * @param {string} seed
 * @returns {Promise<*>}
 */
async function runScripted(script, seed) {
  return runEpisode({
    game,
    tierId: 'perfect-opponent',
    seed,
    agent: createScriptedAgent(script),
  });
}

const identicalA = await runScripted(OPENING, '0');
const identicalB = await runScripted(OPENING, '0');
const swapped = await runScripted(DIVERGING, '0');
const otherSeed = await runScripted(OPENING, '7');

test('two recordings of the same episode report no divergence and full symmetry', async () => {
  const payload = await compareTrajectories(game, identicalA, identicalB, { pathA: 'a', pathB: 'b' });
  assert.equal(payload.format, 'playkit-gauntlet-replay-compare/1');
  assert.equal(payload.mode, 'episode');
  assert.equal(payload.identical, true);
  assert.equal(payload.divergence, null);
  assert.equal(payload.a.attempts, payload.b.attempts);
  assert.equal(payload.a.validActions, payload.b.validActions);
  assert.equal(payload.a.end.reason, identicalA.end.reason);
  // No undo-style action was ever played by either side, so the field is
  // null rather than 0 — the episode alone cannot prove the grammar has one.
  assert.equal(payload.a.undoStyleActions, null);
  assert.equal(payload.game.id, 'tictactoe');
  assert.equal(payload.seed, '0');
});

test('the first differing decision is reported with both sides', async () => {
  const payload = await compareTrajectories(game, identicalA, swapped, { pathA: 'a', pathB: 'b' });
  assert.equal(payload.identical, false);
  assert.notEqual(payload.divergence, null);
  // The opponent may open before the agent (the agent's seat alternates with
  // the seed), so derive the expected index from the steps themselves.
  const canonicalOf = (/** @type {*} */ s) => s.canonical ?? s.action;
  const firstDiff = swapped.steps.findIndex(
    (/** @type {*} */ s, /** @type {number} */ i) => canonicalOf(s) !== canonicalOf(identicalA.steps[i])
  );
  assert.ok(firstDiff >= 0);
  const div = /** @type {NonNullable<typeof payload.divergence>} */ (payload.divergence);
  assert.equal(div.index, firstDiff);
  assert.equal(div.reason, 'actions-differ');
  assert.equal(div.observationMatch, true);
  assert.notEqual(div.a, null);
  assert.notEqual(div.b, null);
  assert.notEqual(div.a?.canonical, div.b?.canonical);
  assert.equal(div.a?.observation.text, div.b?.observation.text);
});

test('identity mismatches are refused and name the field', async () => {
  await assert.rejects(
    () => compareTrajectories(game, identicalA, { ...swapped, tier: 'other-tier' }),
    (/** @type {*} */ err) => err instanceof CompareRefusedError && err.field === 'tier'
  );
  await assert.rejects(
    () => compareTrajectories(game, identicalA, { ...swapped, game: { ...swapped.game, version: '9.9.9' } }),
    (/** @type {*} */ err) => err instanceof CompareRefusedError && err.field === 'version'
  );
});

test('episodeScoreOf replicates the scoring profiles', () => {
  /** Synthetic end records: episodeScoreOf only reads the fields below. */
  /** @param {*} end @returns {*} */
  const withEnd = (end) => /** @type {*} */ ({ end });
  /** @type {*} */
  const outcomeTier = { scoring: 'outcome' };
  assert.equal(
    episodeScoreOf(outcomeTier, identicalA),
    identicalA.end.outcome.normalized[identicalA.agent.seat]
  );
  assert.equal(episodeScoreOf(outcomeTier, withEnd({})), null);

  /** @type {*} */
  const optimalTier = { scoring: 'efficiency', parKind: 'optimal' };
  /** @type {*} */
  const referenceTier = { scoring: 'efficiency', parKind: 'reference' };
  assert.equal(episodeScoreOf(optimalTier, withEnd({ outcome: { solved: true, par: 5 }, agentActions: 10 })), 0.25);
  // Reference caps at 1.15 (RHAE's cap) — a solved-but-slow episode cannot
  // outscore the cap even when the ratio squares far above it.
  assert.equal(
    episodeScoreOf(referenceTier, withEnd({ outcome: { solved: true, par: 5 }, agentActions: 1 })),
    EFFICIENCY_CAP_REFERENCE
  );
  assert.equal(episodeScoreOf(optimalTier, withEnd({ outcome: { solved: true, par: 5 }, agentActions: 1 })), EFFICIENCY_CAP_OPTIMAL);
  assert.equal(episodeScoreOf(optimalTier, withEnd({ outcome: { solved: false }, agentActions: 3 })), 0);
  assert.equal(episodeScoreOf(optimalTier, withEnd({ outcome: { solved: true }, agentActions: 3 })), null);
});

test('signTestP is the two-sided exact binomial, ties dropped', () => {
  assert.equal(signTestP(0, 0), null);
  assert.equal(signTestP(3, 0), 0.25);
  assert.equal(signTestP(0, 3), 0.25);
  assert.equal(signTestP(2, 2), 1);
  assert.equal(signTestP(10, 0), 2 / 1024);
  assert.equal(signTestP(1, 2), 1);
});

test('compareBundles pairs by episode key and reports unpaired and refused', async () => {
  const key = `tictactoe/perfect-opponent/${identicalA.split}/${identicalA.seed}`;
  const staleVersion = { ...swapped, game: { ...swapped.game, version: '0.9.0' } };
  // Same key, different game identity: pairing must refuse it by name rather
  // than silently treating it as unpaired.
  const otherGame = { ...swapped, game: { ...swapped.game, id: 'not-tictactoe' } };

  const payload = await compareBundles(
    new Map([
      [key, { trajectory: identicalA, path: 'a-1' }],
      [`${key}-extra`, { trajectory: identicalB, path: 'a-2' }],
      [`other-game/${key}`, { trajectory: identicalA, path: 'a-3' }],
    ]),
    new Map([
      [key, { trajectory: swapped, path: 'b-1' }],
      [`tictactoe/perfect-opponent/${otherSeed.split}/${otherSeed.seed}`, { trajectory: otherSeed, path: 'b-2' }],
      [`drift/${key}`, { trajectory: staleVersion, path: 'b-3' }],
      [`other-game/${key}`, { trajectory: otherGame, path: 'b-4' }],
    ]),
    { getGameOf: () => game, dirA: 'dir-a', dirB: 'dir-b' }
  );

  assert.equal(payload.format, 'playkit-gauntlet-replay-compare/1');
  assert.equal(payload.mode, 'bundle');
  assert.equal(payload.pairs.length, 1);
  assert.equal(payload.pairs[0].key, key);
  assert.equal(payload.pairs[0].verdict, 'verified');
  assert.equal(payload.pairs[0].versionDrift, null);
  assert.equal(payload.bundles.a.agent, identicalA.agent.id);
  assert.equal(payload.bundles.a.episodes, 3);
  assert.deepEqual(payload.unpaired.a, [`${key}-extra`]);
  assert.equal(payload.unpaired.b.length, 2);
  assert.equal(payload.refused.length, 1);
  assert.equal(payload.refused[0].key, `other-game/${key}`);
  assert.match(payload.refused[0].reason, /refused to compare: game/);
  assert.equal(payload.games.length, 1);
  assert.equal(payload.games[0].pairs, 1);
  assert.equal(payload.games[0].game, 'tictactoe');
  // At most one decisive pair; with n=1 the exact two-sided sign test can
  // never reject, so a decisive pair yields p = 1 and a tie yields null.
  if (payload.games[0].aWins + payload.games[0].bWins > 0) {
    assert.equal(payload.games[0].signTestP, 1);
  } else {
    assert.equal(payload.games[0].signTestP, null);
  }
});

test('version-drifted pairs are scored from the recorded end, never replay-verified', async () => {
  const driftKey = `tictactoe/perfect-opponent/${identicalA.split}/${identicalA.seed}`;
  const staleA = { ...identicalA, game: { ...identicalA.game, version: '0.9.0' } };
  const staleB = { ...swapped, game: { ...swapped.game, version: '0.9.0' } };
  const payload = await compareBundles(
    new Map([[driftKey, { trajectory: staleA, path: 'a' }]]),
    new Map([[driftKey, { trajectory: staleB, path: 'b' }]]),
    { getGameOf: () => game }
  );
  assert.equal(payload.pairs.length, 1);
  assert.equal(payload.pairs[0].verdict, 'end-record');
  assert.deepEqual(payload.pairs[0].versionDrift, { recorded: '0.9.0', current: game.spec.version });
  assert.equal(payload.refused.length, 0);
});
