// Chess-puzzles game tests: registration and spec shape, dataset integrity
// (jsonl <-> generated module, quality filters, per-tier counts), reset and
// observation hygiene (the solution line never leaks), full-solution replay
// of every public seed through the game contract, wrong-move and alternative
// -mate adjudication, eval-sample registration and loader errors, seed
// resolution errors, selection determinism, tier boundaries, an end-to-end
// sampler run on a synthetic zstd dump (determinism, split disjointness,
// outside-repo guard), a baseline episode through the runner, and the
// conformance kit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getGame, listGames } from '../index.js';
import { publicSeed } from '../../core/seeds.js';
import { runConformance } from '../../core/conformance.js';
import { runEpisode } from '../../core/runner.js';
import { createGreedyBaselineAgent } from '../chess/baselines.js';
import chessPuzzlesDefault, {
  chessPuzzles as game,
  GAME_ID,
  playSolutionLine,
  resolvePuzzle,
  stateFromPuzzle,
  qualitySummary,
} from './index.js';
import {
  PER_TIER,
  QUALITY,
  TIERS,
  passesQualityFilters,
  playerMoveCount,
  selectSamples,
  selectionHash,
  tierForRating,
} from './selection.js';
import { PUZZLES } from './data/public.generated.js';
import { PUBLIC_SEEDS, clearEvalPuzzles, getPublicPuzzle, getEvalPuzzle, publicMaxPlayerMoves, registerEvalPuzzles } from './puzzles.js';
import { loadEvalPuzzles } from './eval-loader.node.js';

/** @import { TierSpec } from '../../core/types.js' */
/** @import { DumpRecord, PuzzleRecord } from './selection.js' */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(SCRIPT_DIR, 'data');

/**
 * @param {string} tierId
 * @returns {TierSpec}
 */
function tierOf(tierId) {
  const tier = game.spec.tiers.find((entry) => entry.id === tierId);
  assert.ok(tier, `tier ${tierId} missing from spec`);
  return tier;
}

test('registration: chess-puzzles is registered and resolves from the registry', () => {
  assert.equal(game.spec.id, 'chess-puzzles');
  assert.equal(getGame('chess-puzzles'), chessPuzzlesDefault);
  const ids = listGames().map((entry) => entry.spec.id);
  assert.ok(ids.includes('chess-puzzles'), `chess-puzzles missing from registry, got ${ids.join(', ')}`);
  assert.ok(ids.includes('chess'), 'chess should still be registered');
  assert.ok(ids.includes('tictactoe'), 'tictactoe should still be registered');
});

test('spec shape: six rating tiers, one seat, outcome scoring, shared engine params', () => {
  assert.equal(game.spec.version, '1.0.0');
  assert.equal(game.spec.seats, 1);
  assert.equal(game.spec.information, 'perfect');
  assert.equal(game.spec.stochastic, false);
  assert.equal(game.spec.benchmark, true);
  assert.deepEqual(game.spec.tiers.map((tier) => tier.id), TIERS.map((tier) => tier.id));
  for (const tier of game.spec.tiers) {
    assert.equal(tier.scoring, 'outcome');
    assert.equal(tier.publicSeeds, PUBLIC_SEEDS);
    assert.ok(tier.maxActions > 0 && Number.isInteger(tier.maxActions));
    const band = /** @type {{ min: number, max: number | null }} */ (TIERS.find((entry) => entry.id === tier.id));
    assert.deepEqual(
      { min: tier.params.min, max: tier.params.max },
      { min: band.min, max: band.max },
      `tier ${tier.id} params band drift`
    );
  }
  // The baseline's engine params are the SAME at every tier: the ladder is
  // the puzzles' rating, not the baseline's strength.
  /** @param {typeof game.spec.tiers[number]} tier */
  const engineParams = (tier) =>
    JSON.stringify({ depth: tier.params.depth, nodeBudget: tier.params.nodeBudget, quiescenceMaxPlies: tier.params.quiescenceMaxPlies });
  const first = engineParams(game.spec.tiers[0]);
  for (const tier of game.spec.tiers) {
    assert.equal(engineParams(tier), first, `tier ${tier.id} engine params drift from tier 0`);
  }
});

test('tier budgets: maxActions fits the filter bound and the public sample', () => {
  for (const tier of game.spec.tiers) {
    assert.equal(tier.maxActions, QUALITY.maxPlayerMoves + 2, `tier ${tier.id} budget`);
    assert.ok(tier.maxActions >= publicMaxPlayerMoves(tier.id) + 2, `tier ${tier.id} public fit`);
  }
});

test('dataset: 360 puzzles, 60 per tier, every rating inside its band', () => {
  assert.equal(PUZZLES.length, PER_TIER * TIERS.length);
  const seen = new Set();
  for (const tier of game.spec.tiers) {
    const band = /** @type {{ min: number, max: number | null }} */ (TIERS.find((entry) => entry.id === tier.id));
    let count = 0;
    for (let index = 0; index < PUBLIC_SEEDS; index++) {
      const record = getPublicPuzzle(tier.id, index);
      assert.ok(!seen.has(record.PuzzleId), `duplicate puzzle ${record.PuzzleId}`);
      seen.add(record.PuzzleId);
      assert.ok(record.Rating >= band.min && (band.max === null || record.Rating < band.max), `${record.PuzzleId} rating ${record.Rating} outside ${tier.id}`);
      count++;
    }
    assert.equal(count, PER_TIER, `tier ${tier.id} has ${count} puzzles`);
  }
});

test('dataset: every committed puzzle passes the re-derivable quality filters', () => {
  for (const record of PUZZLES) {
    // Popularity and NbPlays are selection-time-only inputs and are NOT
    // committed per row, so those two filters cannot be re-verified from the
    // file; neutralize them and assert the rest of the filter verbatim.
    const verdict = passesQualityFilters({
      ...record,
      Popularity: QUALITY.minPopularity,
      NbPlays: QUALITY.minNbPlays,
    });
    assert.equal(verdict.ok, true, `${record.PuzzleId}: ${verdict.reason ?? ''}`);
  }
});

test('dataset: public.jsonl and the generated module never drift apart', () => {
  const jsonlPath = path.join(DATA_DIR, 'public.jsonl');
  assert.ok(existsSync(jsonlPath), 'data/public.jsonl is missing; run scripts/sample.js');
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  assert.equal(lines.length, PUZZLES.length);
  lines.forEach((line, index) => {
    const parsed = /** @type {PuzzleRecord} */ (JSON.parse(line));
    assert.deepEqual(parsed, PUZZLES[index], `line ${index} drifted from the generated module`);
  });
});

test('SOURCE.md records provenance: URL, CC0, SHA-256, seed, selection rule', () => {
  const markdown = readFileSync(path.join(DATA_DIR, 'SOURCE.md'), 'utf8');
  for (const needle of [
    'CC0',
    'https://database.lichess.org/',
    'SHA-256',
    'Selection seed',
    'fnv1a64',
    `RatingDeviation <= ${QUALITY.maxRatingDeviation}`,
  ]) {
    assert.ok(markdown.includes(needle), `SOURCE.md missing ${JSON.stringify(needle)}`);
  }
});

test('qualitySummary names all four filters', () => {
  const summary = qualitySummary();
  for (const needle of ['RatingDeviation', 'Popularity', 'NbPlays', 'player moves']) {
    assert.ok(summary.includes(needle), `summary missing ${needle}`);
  }
});

test('reset: public seeds resolve, state starts after the opponent pre-move', () => {
  const tier = tierOf('r0400');
  const seed = publicSeed(GAME_ID, tier.id, 0);
  const state = game.reset(tier, seed);
  const record = resolvePuzzle(tier.id, seed);
  assert.equal(state.puzzleId, record.PuzzleId);
  assert.deepEqual(state.moves, [record.Moves.split(' ')[0]]);
  assert.equal(state.solutionIndex, 1);
  assert.deepEqual(state.solution, record.Moves.split(' '));
  assert.ok(state.moves[0] !== state.solution[1], 'pre-move must not equal the first agent move');
  assert.equal(game.toAct(state), 0);
  // Deterministic: the same seed resets to the same state.
  assert.deepEqual(game.reset(tier, seed), state);
});

test('observation: full board and legal actions, and the solution line never leaks', () => {
  for (const tier of game.spec.tiers) {
    const state = game.reset(tier, publicSeed(GAME_ID, tier.id, 0));
    const observation = game.observe(state, 0);
    assert.ok(observation.text.includes('Side to move'), 'observation should name the side to move');
    // renderBoard (../chess/render.js) draws rank-labelled borders like
    // '+-----------------+' and rank rows like '8 | ...'; assert that shape.
    assert.ok(observation.text.includes('+------') && observation.text.includes('8 |'), 'observation should render the board');
    const legal = game.legalActions(state, 0);
    assert.ok(legal.length > 0);
    if (legal.length <= 64) {
      assert.ok(observation.text.includes('all listed'), 'small legal sets should be listed');
      for (const action of legal.slice(0, 3)) {
        assert.ok(observation.text.includes(action), `observation should list ${action}`);
      }
    }
    // The grader-side line must not appear: neither as keys in data nor as
    // the joined line in any rendered text.
    assert.equal('solution' in observation.data, false);
    assert.equal('solutionIndex' in observation.data, false);
    assert.equal(observation.text.includes(state.solution.join(' ')), false);
    assert.equal(JSON.stringify(observation).includes('"solution"'), false);
  }
});

test('full-solution replay: every public seed of every tier solves through the contract', () => {
  let solved = 0;
  for (const tier of game.spec.tiers) {
    for (let index = 0; index < PUBLIC_SEEDS; index++) {
      const seed = publicSeed(GAME_ID, tier.id, index);
      const final = playSolutionLine(game, tier, seed);
      const outcome = game.outcome(final);
      assert.ok(outcome, `seed ${seed} ended without an outcome`);
      assert.deepEqual(outcome.normalized, [1], `seed ${seed} should solve: ${outcome.reason}`);
      assert.equal(outcome.raw?.[0], 'win');
      assert.ok(final.moves.length === final.solution.length, `seed ${seed} move history length`);
      solved++;
    }
  }
  assert.equal(solved, PER_TIER * TIERS.length);
});

test('replay uses at most the tier budget: solution length fits maxActions', () => {
  for (const tier of game.spec.tiers) {
    for (let index = 0; index < PUBLIC_SEEDS; index++) {
      const record = getPublicPuzzle(tier.id, index);
      const playerMoves = playerMoveCount(record.Moves.split(' '));
      assert.ok(playerMoves <= tier.maxActions, `${record.PuzzleId} needs ${playerMoves} actions, budget ${tier.maxActions}`);
    }
  }
});

test('wrong move: a legal move off the line ends the episode unsolved', () => {
  const tier = tierOf('r0400');
  const state = game.reset(tier, publicSeed(GAME_ID, tier.id, 0));
  const expected = state.solution[state.solutionIndex];
  const legal = game.legalActions(state, 0);
  const offLine = legal.find((action) => action !== expected);
  assert.ok(offLine, 'position should have a legal move off the line');
  const next = game.step(state, 0, /** @type {string} */ (offLine));
  assert.equal(next.termination?.type, 'wrong-move');
  assert.ok(/** @type {string} */ (next.termination?.detail).includes(expected));
  const outcome = game.outcome(next);
  assert.deepEqual(outcome?.normalized, [0]);
  assert.equal(outcome?.raw?.[0], 'loss');
  assert.equal(game.toAct(next), null);
});

test('checkmate exception: any mating move wins, on or off the line', () => {
  // Synthetic mate-in-one with two mating moves (back-rank mates from b1 and
  // c1 against Kg8 with f7/g7/h7 pawns). The line expects b1b8; the test
  // plays c1c8 and must still win.
  const record = /** @type {PuzzleRecord} */ ({
    PuzzleId: 'syntheticTwoMates',
    FEN: '6k1/5ppp/8/8/8/8/6q1/KRR5 b - - 0 1',
    Moves: 'g2g3 b1b8',
    Rating: 1000,
    RatingDeviation: 40,
    Popularity: 100,
    NbPlays: 500,
    Themes: 'mateIn1',
    GameUrl: '',
  });
  const state = stateFromPuzzle(record);
  assert.equal(state.playerColor, 'w');
  const legal = game.legalActions(state, 0);
  assert.ok(legal.includes('b1b8'), 'line move must be legal');
  assert.ok(legal.includes('c1c8'), 'alternative mate must be legal');
  const mate = game.step(state, 0, 'c1c8');
  assert.equal(mate.termination?.type, 'solved');
  assert.ok(/** @type {string} */ (mate.termination?.detail).includes('checkmate'));
  assert.deepEqual(game.outcome(mate)?.normalized, [1]);
  // And a non-mating legal move still ends unsolved even though a mate
  // existed elsewhere.
  const quiet = legal.find((action) => action !== 'b1b8' && action !== 'c1c8');
  assert.ok(quiet, 'position should have a quiet legal move');
  const wrong = game.step(state, 0, /** @type {string} */ (quiet));
  assert.equal(wrong.termination?.type, 'wrong-move');
});

test('invalid attempts: illegal and unparseable actions throw GauntletRuleError', () => {
  const tier = tierOf('r0400');
  const state = game.reset(tier, publicSeed(GAME_ID, tier.id, 0));
  const parsed = game.parseAction(state, 0, 'zz9');
  assert.equal(parsed.ok, false);
  assert.throws(() => game.step(state, 0, 'zz9'));
  assert.throws(() => game.step(state, 0, 'e2e5'));
  assert.throws(() => game.step(state, 1, game.legalActions(state, 0)[0]));
  assert.equal(game.parseAction(state, 1, 'e2e4').ok, false);
});

test('truncation: budget exhaustion scores zero', () => {
  const tier = tierOf('r0400');
  const state = game.reset(tier, publicSeed(GAME_ID, tier.id, 0));
  const outcome = game.truncate(state);
  assert.deepEqual(outcome.normalized, [0]);
  assert.equal(outcome.raw, null);
});

test('eval sample: registration, resolution, and loud errors when absent', async (t) => {
  t.after(() => clearEvalPuzzles());
  const tier = tierOf('r1400');
  const record = /** @type {PuzzleRecord} */ ({
    PuzzleId: 'evalTestPuzzle',
    FEN: '6k1/5ppp/8/8/8/8/6q1/KRR5 b - - 0 1',
    Moves: 'g2g3 b1b8',
    Rating: 1500,
    RatingDeviation: 40,
    Popularity: 100,
    NbPlays: 500,
    Themes: 'mateIn1',
    GameUrl: '',
  });
  assert.throws(() => resolvePuzzle('r1400', 'chess-puzzles/r1400/eval/evalTestPuzzle'), /no eval sample loaded/);
  registerEvalPuzzles([record]);
  assert.equal(getEvalPuzzle('r1400', 'evalTestPuzzle').PuzzleId, 'evalTestPuzzle');
  const state = game.reset(tier, 'chess-puzzles/r1400/eval/evalTestPuzzle');
  assert.equal(state.puzzleId, 'evalTestPuzzle');
  assert.deepEqual(game.outcome(playSolutionLine(game, tier, 'chess-puzzles/r1400/eval/evalTestPuzzle'))?.normalized, [1]);
  assert.throws(() => getEvalPuzzle('r1400', 'missingPuzzle'), /has no puzzle/);
  assert.throws(() => resolvePuzzle('r0400', 'chess-puzzles/r0400/eval/evalTestPuzzle'), /no eval sample loaded for tier "r0400"/);
  clearEvalPuzzles();
  assert.throws(() => getEvalPuzzle('r1400', 'evalTestPuzzle'), /no eval sample loaded/);
});

test('eval seeds: the runner budget fits any filter-compliant puzzle in any tier', async (t) => {
  t.after(() => clearEvalPuzzles());
  // The quality filters admit QUALITY.maxPlayerMoves-length lines in EVERY
  // tier, so the budget must fit them everywhere. A budget derived from the
  // public sample alone (r0400: 5) cannot complete a 6-player-move eval
  // puzzle in r0400 even with perfect play — the runner ends such episodes
  // budget-exhausted. Re-rating a longest-line public record into the
  // smallest tier is exactly that worst case, driven through the real
  // runner where the budget is enforced.
  const source = PUZZLES.find((record) => Math.floor(record.Moves.split(' ').length / 2) === QUALITY.maxPlayerMoves);
  assert.ok(source, 'the public sample should contain a filter-max-length line to reuse');
  registerEvalPuzzles([
    /** @type {PuzzleRecord} */ ({ ...source, PuzzleId: 'budgetTestEval', Rating: 400 }),
  ]);
  // Moves[0] is the opponent's pre-move that reset() applies, so the agent's
  // moves sit at odd indices of the dump line.
  const playerMoves = source.Moves.split(' ').filter((_, index) => index % 2 === 1);
  let next = 0;
  const trajectory = await runEpisode({
    game,
    tierId: 'r0400',
    seed: 'chess-puzzles/r0400/eval/budgetTestEval',
    agent: {
      id: 'line-follower',
      track: /** @type {'baseline'} */ ('baseline'),
      act: async () => ({ text: playerMoves[next++] }),
    },
  });
  assert.deepEqual(
    trajectory.end.outcome?.normalized,
    [1],
    `a perfect line must be completable within the action budget (end reason: ${trajectory.end.reason}, actions: ${trajectory.end.agentActions})`
  );
});

test('eval loader: the Node-only loader registers a jsonl file', async (t) => {
  t.after(() => clearEvalPuzzles());
  const record = /** @type {PuzzleRecord} */ ({
    PuzzleId: 'evalLoaderPuzzle',
    FEN: '6k1/5ppp/8/8/8/8/6q1/KRR5 b - - 0 1',
    Moves: 'g2g3 b1b8',
    Rating: 3000,
    RatingDeviation: 40,
    Popularity: 100,
    NbPlays: 500,
    Themes: '',
    GameUrl: '',
  });
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'chess-puzzles-eval-')), 'eval.jsonl');
  writeFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  const counts = await loadEvalPuzzles(file);
  assert.deepEqual(counts, { total: 1, byTier: { r2600: 1 } });
  assert.equal(getEvalPuzzle('r2600', 'evalLoaderPuzzle').Rating, 3000);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test('seed resolution: malformed seeds fail loudly with the expected shape', () => {
  const tier = tierOf('r0400');
  for (const bad of ['nonsense', 'chess-puzzles/r0400/secret/3', 'chess/r0400/public/3', 'chess-puzzles/badtier/public/3', 'chess-puzzles/r0400/unknownsplit/3', 'chess-puzzles/r0400/public/notanint', '']) {
    assert.throws(() => resolvePuzzle('r0400', bad), /chess-puzzles:/, `seed ${JSON.stringify(bad)} should throw`);
  }
  assert.throws(() => resolvePuzzle('r0400', 'chess-puzzles/r1000/public/0'), /is for tier "r1000"/);
  assert.throws(() => getPublicPuzzle('r0400', PUBLIC_SEEDS), /has public seeds/);
  assert.throws(() => getPublicPuzzle('nosuch', 0), /unknown tier/);
  assert.ok(resolvePuzzle('r0400', 'chess-puzzles/r0400/public/0'));
});

test('selection: deterministic per salt, salt-sensitive, exclusion-aware, loud when short', () => {
  const saltA = selectSamples(PUZZLES, 'salt-a', PER_TIER);
  const saltA2 = selectSamples(PUZZLES, 'salt-a', PER_TIER);
  const saltB = selectSamples(PUZZLES, 'salt-b', PER_TIER);
  for (const tierId of saltA.keys()) {
    assert.deepEqual(
      saltA.get(tierId)?.map((record) => record.PuzzleId),
      saltA2.get(tierId)?.map((record) => record.PuzzleId),
      `tier ${tierId}: the same salt must select the same sample`
    );
  }
  // Different salt: the samples must differ somewhere (with thousands of
  // candidates per tier, identical 60-picks across two salts is impossible
  // in practice).
  const identical = [...saltA.keys()].filter((tierId) =>
    JSON.stringify(saltA.get(tierId)?.map((record) => record.PuzzleId)) ===
    JSON.stringify(saltB.get(tierId)?.map((record) => record.PuzzleId))
  );
  assert.ok(identical.length < TIERS.length, 'a different salt should change at least one tier');
  // Excluding the sample's own ids leaves nothing: with only the committed
  // sample as candidates, a public-excluding selection cannot reach PER_TIER
  // and must fail loudly. True split disjointness is covered by the sampler
  // end-to-end test below, which selects from a larger candidate pool.
  const publicIds = new Set(PUZZLES.map((record) => record.PuzzleId));
  assert.throws(
    () => selectSamples(PUZZLES, 'salt-a', PER_TIER, (record) => publicIds.has(record.PuzzleId)),
    /need/
  );
  // Excluding everything cannot reach PER_TIER either.
  assert.throws(() => selectSamples(PUZZLES, 'salt-a', PER_TIER, () => true), /need/);
  // The selection hash is stable and 16 hex digits.
  assert.equal(selectionHash('salt-a', 'abc').length, 16);
  assert.equal(selectionHash('salt-a', 'abc'), selectionHash('salt-a', 'abc'));
});

test('tier bands: boundaries assign correctly and impossible ratings throw', () => {
  assert.equal(tierForRating(400).id, 'r0400');
  assert.equal(tierForRating(999).id, 'r0400');
  assert.equal(tierForRating(1000).id, 'r1000');
  assert.equal(tierForRating(1399).id, 'r1000');
  assert.equal(tierForRating(1400).id, 'r1400');
  assert.equal(tierForRating(2200).id, 'r2200');
  assert.equal(tierForRating(2599).id, 'r2200');
  assert.equal(tierForRating(2600).id, 'r2600');
  assert.equal(tierForRating(4000).id, 'r2600');
  assert.throws(() => tierForRating(399), /no tier band/);
  assert.throws(() => tierForRating(-5), /no tier band/);
});

test('quality filters: each threshold rejects its own violations', () => {
  /** @returns {DumpRecord} */
  const base = () =>
    /** @type {DumpRecord} */ ({
      PuzzleId: 'filterTest',
      FEN: '6k1/5ppp/8/8/8/8/6q1/KRR5 b - - 0 1',
      Moves: 'g2g3 b1b8',
      Rating: 1000,
      RatingDeviation: 50,
      Popularity: 95,
      NbPlays: 500,
      Themes: '',
      GameUrl: '',
    });
  assert.equal(passesQualityFilters(base()).ok, true);
  const wide = base();
  wide.RatingDeviation = QUALITY.maxRatingDeviation + 1;
  assert.equal(passesQualityFilters(wide).ok, false);
  const unpopular = base();
  unpopular.Popularity = QUALITY.minPopularity - 1;
  assert.equal(passesQualityFilters(unpopular).ok, false);
  const rare = base();
  rare.NbPlays = QUALITY.minNbPlays - 1;
  assert.equal(passesQualityFilters(rare).ok, false);
  const oddLine = base();
  oddLine.Moves = 'g2g3';
  assert.equal(passesQualityFilters(oddLine).ok, false);
  const tooLong = base();
  tooLong.Moves = 'g2g3 b1b8 g2g3 b1b8 g2g3 b1b8 g2g3 b1b8 g2g3 b1b8 g2g3 b1b8 g2g3 b1b8';
  assert.equal(passesQualityFilters(tooLong).ok, false);
  assert.equal(playerMoveCount(tooLong.Moves.split(' ')), 7);
});

test('runner e2e: the greedy baseline plays real episodes to terminal outcomes', async () => {
  const tier = tierOf('r0400');
  const seed = publicSeed(GAME_ID, tier.id, 0);
  const trajectory = await runEpisode({
    game,
    tierId: tier.id,
    seed,
    agent: createGreedyBaselineAgent({ id: 'greedy-test', episodeSeed: seed }),
  });
  assert.equal(trajectory.game.id, GAME_ID);
  assert.equal(trajectory.tier, tier.id);
  assert.equal(trajectory.end.reason, 'terminal');
  assert.ok(trajectory.end.agentActions >= 1);
  assert.ok(trajectory.end.outcome, 'episode should end with an outcome');
  assert.ok(trajectory.end.outcome.normalized.length === 1);
});

test('conformance: chess-puzzles passes the conformance kit on every tier', async () => {
  const report = await runConformance(game, { seedsPerTier: 3 });
  assert.equal(report.ok, true);
  assert.ok(report.checks > 0);
});

// ---------------------------------------------------------------------------
// Sampler end-to-end on a synthetic dump: determinism, split disjointness,
// and the outside-repository guard. Skipped when zstd is unavailable.
// ---------------------------------------------------------------------------

test('sampler: synthetic dump produces identical public samples, disjoint eval, refuses in-repo eval output', async (t) => {
  let zstdOk = true;
  try {
    execFileSync('zstd', ['--version'], { stdio: 'ignore' });
  } catch {
    zstdOk = false;
  }
  if (!zstdOk) {
    t.skip('zstd is not installed');
    return;
  }
  const work = mkdtempSync(path.join(tmpdir(), 'chess-puzzles-sampler-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));

  // Synthetic dump: the synthetic double-mate position repeated with
  // distinct PuzzleIds across all six rating bands, plus rows that violate
  // each quality filter so the rejection counters carry data.
  const ratings = [500, 1200, 1500, 2000, 2300, 2800];
  /** @type {string[]} */
  const csv = ['PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags'];
  let id = 0;
  for (const rating of ratings) {
    for (let i = 0; i < 130; i++) {
      csv.push(
        `syn${String(id).padStart(6, '0')},"6k1/5ppp/8/8/8/8/6q1/KRR5 b - - 0 1","g2g3 b1b8",${rating},40,95,500,mateIn1,https://lichess.org/x,`
      );
      id++;
    }
    // Deliberately rejected rows: high deviation, low popularity, low plays,
    // an illegal line, and a too-long line.
    csv.push(`synBadDev${rating},"6k1/5ppp/8/8/8/8/6q1/KRR5 b - - 0 1","g2g3 b1b8",${rating},999,95,500,mateIn1,,`);
    csv.push(`synBadPop${rating},"6k1/5ppp/8/8/8/8/6q1/KRR5 b - - 0 1","g2g3 b1b8",${rating},40,10,500,mateIn1,,`);
    csv.push(`synBadPlays${rating},"6k1/5ppp/8/8/8/8/6q1/KRR5 b - - 0 1","g2g3 b1b8",${rating},40,95,3,mateIn1,,`);
    csv.push(`synBadLine${rating},"6k1/5ppp/8/8/8/8/6q1/KRR5 b - - 0 1","g2g3 e2e4",${rating},40,95,500,mateIn1,,`);
  }
  const csvPath = path.join(work, 'dump.csv');
  writeFileSync(csvPath, csv.join('\n'), 'utf8');
  const zstPath = path.join(work, 'dump.csv.zst');
  execFileSync('zstd', ['-f', '-q', '-o', zstPath, csvPath]);

  const runSampler = (/** @type {string[]} */ ...extra) =>
    execFileSync(
      'node',
      [path.join(SCRIPT_DIR, 'scripts', 'sample.js'), `--dump=${zstPath}`, ...extra],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString();

  // Public mode, twice: identical bytes both times.
  const dir1 = path.join(work, 'data1');
  const dir2 = path.join(work, 'data2');
  runSampler('--seed=test-seed-public', `--data-dir=${dir1}`);
  runSampler('--seed=test-seed-public', `--data-dir=${dir2}`);
  const jsonl1 = readFileSync(path.join(dir1, 'public.jsonl'), 'utf8');
  const jsonl2 = readFileSync(path.join(dir2, 'public.jsonl'), 'utf8');
  assert.equal(jsonl1, jsonl2, 'the same seed must produce byte-identical samples');
  const publicLines = jsonl1.split('\n').filter((line) => line.trim().length > 0);
  assert.equal(publicLines.length, PER_TIER * ratings.length);
  assert.ok(readFileSync(path.join(dir1, 'SOURCE.md'), 'utf8').includes('test-seed-public'));
  assert.ok(existsSync(path.join(dir1, 'public.generated.js')));

  // Eval mode: disjoint from the public sample of the same dump and seed.
  const saltPath = path.join(work, 'salt.txt');
  writeFileSync(saltPath, 'synthetic-eval-salt', 'utf8');
  const evalPath = path.join(work, 'eval.jsonl');
  runSampler('--seed=test-seed-public', `--salt-file=${saltPath}`, `--eval-out=${evalPath}`);
  const evalLines = readFileSync(evalPath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  assert.equal(evalLines.length, PER_TIER * ratings.length);
  const publicIds = new Set(publicLines.map((line) => JSON.parse(line).PuzzleId));
  for (const line of evalLines) {
    assert.ok(!publicIds.has(JSON.parse(line).PuzzleId), 'eval sample must be disjoint from the public sample');
  }
  // Eval determinism: the same salt reproduces the same eval sample.
  const evalPath2 = path.join(work, 'eval2.jsonl');
  runSampler('--seed=test-seed-public', `--salt-file=${saltPath}`, `--eval-out=${evalPath2}`);
  assert.equal(readFileSync(evalPath, 'utf8'), readFileSync(evalPath2, 'utf8'));

  // The eval sample must refuse to be written inside the repository.
  assert.throws(
    () => runSampler('--seed=test-seed-public', `--salt-file=${saltPath}`, '--eval-out=./inside-repo-eval.jsonl'),
    /OUTSIDE the repository/
  );
});
