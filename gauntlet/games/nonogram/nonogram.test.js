import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../../core/canonical.js';
import { runConformance } from '../../core/conformance.js';
import { runEpisode } from '../../core/runner.js';
import { publicSeed } from '../../core/seeds.js';
import { verifyTrajectory } from '../../core/trajectory.js';
import game, { default as defaultGame } from './index.js';
import { deduceLine, linePatterns, linePatternCount } from './lines.js';
import { blankGrid, clueOfPattern, cluesOfGrid, countSolutions, lineSolve } from './solver.js';
import { puzzleFor } from './generator.js';
import { createEngineAgent, createGreedyAgent } from './baselines.js';

if (defaultGame !== game) throw new Error('default export mismatch');
void defaultGame;

const tiny = game.spec.tiers[0];
const classic = game.spec.tiers[1];
const grand = game.spec.tiers[2];
const probe = game.spec.tiers[3];

/** Convert a '#'/'. '/'x' string to solver cells.
 *
 * @param {string} s
 * @returns {Uint8Array}
 */
function cellsOf(s) {
  const cells = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    cells[i] = s[i] === '#' ? 1 : s[i] === 'x' ? 2 : 0;
  }
  return cells;
}

/** Convert solver cells back to a string ('.' for unknown).
 *
 * @param {Uint8Array} cells
 * @returns {string}
 */
function strOf(cells) {
  return [...cells].map((v) => (v === 1 ? '#' : v === 2 ? 'x' : '.')).join('');
}

test('deduceLine forces cells on hand-checked cases', () => {
  /** @type {[number[], string, string][]} */
  const cases = [
    // [clue, line before, forced after]
    [[3], '.....', '..#..'], // only the centre cell is filled in every placement
    [[5], '.....', '#####'], // clue fills the whole line
    [[2, 2], '.....', '##x##'], // exact fit is unique; the gap is forced crossed
    [[1], '#....', '#xxxx'], // a known fill pins a single run
    [[4], 'x....', 'x####'], // a leading cross leaves one placement
    [[2], 'x.x..', 'xxx##'], // crosses at 0 and 2 leave one placement
    [[1, 1], '#..#', '#xx#'], // fills at both ends fix the interior
    [[4], '.###x', '####x'], // a trailing cross pins the run left
  ];
  for (const [clue, before, after] of cases) {
    const result = deduceLine(clue, cellsOf(before));
    assert.ok(result.ok, `clue ${clue} on ${before} should be consistent`);
    assert.equal(strOf(result.forced), after, `clue ${clue} on ${before}`);
  }
});

test('deduceLine detects contradictions and never mutates its input', () => {
  /** @type {[number[], string][]} */
  const cases = [
    [[3], 'xxx..'], // crosses at 0-2 leave no room for a run of 3
    [[2], '.###.'], // existing run of 3 exceeds the clue
    [[1, 1], '##..'], // adjacent fills cannot satisfy two separated runs
  ];
  for (const [clue, line] of cases) {
    const result = deduceLine(clue, cellsOf(line));
    assert.equal(result.ok, false, `clue ${clue} on ${line} must contradict`);
  }
  const input = cellsOf('.....');
  deduceLine([3], input);
  assert.equal(strOf(input), '.....', 'deduceLine mutated its input');
});

test('linePatternCount matches combinatorial values', () => {
  assert.equal(linePatternCount(5, [3]), 3);
  assert.equal(linePatternCount(5, [2, 2]), 1);
  assert.equal(linePatternCount(5, [1, 1]), 6); // C(4,2) gap placements
  assert.equal(linePatternCount(4, [1, 1]), 3);
  assert.equal(linePatternCount(3, [2]), 2); // ##. and .##
  assert.equal(linePatternCount(2, [2]), 1);
  assert.equal(linePatternCount(2, [3]), 0);
  assert.equal(linePatternCount(3, []), 1);
  assert.equal(linePatternCount(1, [0]), 1);
});

test('linePatterns enumerations are distinct and consistent with their clue', () => {
  /** @type {[number, number[]][]} */
  const cases = [
    [5, [3]],
    [5, [2, 2]],
    [4, [1, 1]],
    [3, []],
    [2, [1]],
  ];
  for (const [length, clue] of cases) {
    const patterns = linePatterns(length, clue);
    assert.equal(patterns.length, linePatternCount(length, clue), `count for ${length} ${clue}`);
    assert.equal(new Set(patterns).size, patterns.length, `duplicates for ${length} ${clue}`);
    for (const pattern of patterns) {
      assert.equal(pattern.length, length);
      const clueForm = clue.length === 0 || (clue.length === 1 && clue[0] === 0) ? [0] : clue;
      assert.deepEqual(clueOfPattern(pattern), clueForm, `pattern ${pattern} for ${length} ${clue}`);
    }
  }
});

test('clueOfPattern and cluesOfGrid round-trip generated puzzles', () => {
  const puzzle = puzzleFor({ rows: 6, cols: 6, density: 0.55, lineSolvable: true, seed: 'round-trip/1' });
  for (let r = 0; r < 6; r++) {
    assert.deepEqual(clueOfPattern(puzzle.solution[r]), puzzle.rowClues[r], `row ${r}`);
  }
  const clues = cluesOfGrid(puzzle.solution);
  assert.deepEqual(clues.rowClues, puzzle.rowClues);
  assert.deepEqual(clues.colClues, puzzle.colClues);
});

test('generation is deterministic per seed and varies across seeds', () => {
  const a = puzzleFor({ rows: 5, cols: 5, density: 0.55, lineSolvable: true, seed: 'det/a' });
  const b = puzzleFor({ rows: 5, cols: 5, density: 0.55, lineSolvable: true, seed: 'det/a' });
  assert.deepEqual(a, b);
  const c = puzzleFor({ rows: 5, cols: 5, density: 0.55, lineSolvable: true, seed: 'det/b' });
  assert.notDeepEqual(a.rowClues, c.rowClues);
});

test('tier grading: line tiers are line-solvable, probe tier is unique but not line-solvable', () => {
  for (const tier of [tiny, classic, grand, probe]) {
    for (let i = 0; i < 5; i++) {
      const seed = publicSeed('nonogram', tier.id, i);
      const state = game.reset(tier, seed);
      const clues = cluesOfGrid(state.solution);
      const line = lineSolve(clues, tier.params.rows, tier.params.cols, blankGrid(tier.params.rows, tier.params.cols));
      if (tier.params.grade === 'line') {
        assert.ok(line.ok && line.solved, `${tier.id} seed ${seed}: line solver must complete the grid`);
      } else {
        assert.ok(line.ok, `${tier.id} seed ${seed}: clues must stay consistent`);
        assert.ok(!line.solved, `${tier.id} seed ${seed}: probe puzzle must not be line-solvable`);
        assert.equal(
          countSolutions(clues, tier.params.rows, tier.params.cols, blankGrid(tier.params.rows, tier.params.cols), 2),
          1,
          `${tier.id} seed ${seed}: puzzle must have exactly one solution`
        );
      }
      assert.equal(lineSolve(clues, tier.params.rows, tier.params.cols, cellsOf(state.solution.join(''))).ok, true);
    }
  }
});

test('observations differ across seeds (clues are the puzzle) and never leak the solution', () => {
  const seeds = ['nonogram/probe/public/0', 'nonogram/probe/public/1', 'other-seed'];
  /** @type {string[]} */
  const fingerprints = [];
  for (const seed of seeds) {
    const state = game.reset(probe, seed);
    const observation = game.observe(state, 0);
    fingerprints.push(canonicalJson(observation));
    const text = observation.text;
    for (const row of state.solution) {
      assert.ok(!text.includes(row), `observation leaked a solution row (${row})`);
      assert.ok(!canonicalJson(observation.data).includes(row));
    }
    assert.ok(!text.includes(seed), 'observation leaked the seed');
    assert.ok(state.marks.every((row) => row.every((mark) => mark === 0)), 'fresh marks are all unknown');
  }
  assert.equal(fingerprints.length, seeds.length);
  assert.ok(new Set(fingerprints).size > 1, 'different puzzles must show different clues');
});

test('observations reveal clues, marks, and remaining budget', () => {
  let state = game.reset(classic, 'nonogram/classic/public/0');
  state = game.step(state, 0, 'fill 1 1');
  state = game.step(state, 0, 'cross 1 2');
  const observation = game.observe(state, 0);
  assert.match(observation.text, /Column clues \(top to bottom per column\):/);
  assert.match(observation.text, /# x /); // row 1 shows the fill and the cross
  assert.match(observation.text, /Actions used \d+ of \d+ \(\d+ left\)/);
  assert.equal(observation.data.actionsRemaining, classic.maxActions - 2);
  assert.equal(observation.data.status, 'playing');
  assert.ok(!canonicalJson(observation.data).includes(state.seed));
});

test('parseAction accepts the canonical action and documented alternates', () => {
  const state = game.reset(tiny, 's');
  for (const [text, expected] of [
    ['fill 1 2', 'fill 1 2'],
    ['fill 1,2', 'fill 1 2'],
    ['fill 1, 2', 'fill 1 2'],
    ['FILL 2 3', 'fill 2 3'],
    ['cross 1 1', 'cross 1 1'],
    ['clear 3 4', 'clear 3 4'],
    ['fill 5 5', 'fill 5 5'],
    ['  fill 1 2  ', 'fill 1 2'],
    ['"fill 1 2"', 'fill 1 2'],
    ['`fill 1 2`', 'fill 1 2'],
    ["'fill 1 2'", 'fill 1 2'],
    ['action: fill 1 2', 'fill 1 2'],
  ]) {
    const parsed = game.parseAction(state, 0, text);
    assert.deepEqual(parsed, { ok: true, action: expected }, `input ${JSON.stringify(text)}`);
  }
  // The first row of this seed's solution is a legal row action.
  const solvedState = game.reset(tiny, 's');
  const pattern = solvedState.solution[0];
  for (const text of [`row 1 ${pattern}`, `ROW 1: ${pattern}`, `row 1,${pattern}`]) {
    const parsed = game.parseAction(solvedState, 0, text);
    assert.deepEqual(parsed, { ok: true, action: `row 1 ${pattern}` }, `input ${JSON.stringify(text)}`);
  }
  for (const bad of [
    '',
    'fill',
    'fill 0 1',
    'fill 1 0',
    'fill 6 1',
    'fill 1 6',
    'fill a 1',
    'fill 1 2 3',
    'row 1',
    'row 0 ##.##',
    'row 6 ##.##',
    'row 1 ##', // wrong length
    'row 1 ##.##extra',
    'fill 1 2x',
    'zzz',
  ]) {
    const parsed = game.parseAction(solvedState, 0, bad);
    assert.equal(parsed.ok, false, `input ${JSON.stringify(bad)} should be rejected`);
    if (!parsed.ok) assert.equal(typeof parsed.error, 'string');
  }
  // A row pattern whose runs contradict the row's clue is rejected at parse time.
  const badPattern = pattern === '#'.repeat(solvedState.cols) ? '#'.repeat(solvedState.cols - 1) + '.' : '#'.repeat(solvedState.cols);
  assert.equal(game.parseAction(solvedState, 0, `row 1 ${badPattern}`).ok, false, 'clue-mismatched row pattern must be rejected');
});

test('step is pure, applies marks, and ends the game solved', () => {
  const tier = tiny;
  const state = game.reset(tier, 'nonogram/tiny/public/0');
  const before = JSON.parse(JSON.stringify(state));
  const next = game.step(state, 0, 'fill 1 1');
  assert.deepEqual(state, before, 'step mutated its input');
  assert.notEqual(next, state);
  assert.equal(next.actions, 1);
  assert.equal(next.marks[0][0], 1, 'fill stores the filled mark');
  assert.equal(game.toAct(next), 0);
  assert.equal(game.outcome(next), null);

  // Complete the grid with row actions straight from the solution.
  let solved = next;
  solved = game.step(solved, 0, 'clear 1 1');
  assert.equal(solved.marks[0][0], 0, 'clear resets a cell');
  for (let r = 1; r <= tier.params.rows; r++) {
    solved = game.step(solved, 0, `row ${r} ${solved.solution[r - 1]}`);
  }
  assert.equal(solved.status, 'solved');
  assert.equal(game.toAct(solved), null);
  const outcome = game.outcome(solved);
  assert.ok(outcome && outcome.solved === true);
  assert.equal(outcome.par, state.par);
  assert.ok(outcome.normalized[0] > 0 && outcome.normalized[0] <= 1);

  // A wrong mark blocks the solve; undoing it completes the grid. Cell
  // actions only — a row action would overwrite the contradicting mark.
  let blocked = game.reset(tier, 'nonogram/tiny/public/0');
  const wrongFill = blocked.solution[0][0] === '#' ? 'cross 1 1' : 'fill 1 1';
  blocked = game.step(blocked, 0, wrongFill);
  for (let r = 0; r < tier.params.rows; r++) {
    for (let c = 0; c < tier.params.cols; c++) {
      if (r === 0 && c === 0) continue;
      if (blocked.solution[r][c] === '#') {
        blocked = game.step(blocked, 0, `fill ${r + 1} ${c + 1}`);
      }
    }
  }
  assert.equal(blocked.status, 'playing', 'a contradicting mark blocks the solve');
  const undo = wrongFill === 'fill 1 1' ? 'clear 1 1' : 'fill 1 1';
  blocked = game.step(blocked, 0, undo);
  assert.equal(blocked.status, 'solved', 'undoing the wrong mark completes the grid');
});

test('step throws GauntletRuleError for non-canonical or malformed actions', () => {
  const state = game.reset(tiny, 's');
  for (const bad of ['fill 0 1', 'row 1 ##', 'zzz', 'fill 1', '']) {
    assert.throws(
      () => game.step(state, 0, bad),
      (/** @type {Error} */ err) => err.name === 'GauntletRuleError',
      `expected GauntletRuleError for ${JSON.stringify(bad)}`
    );
  }
  assert.throws(() => game.step(state, 1, 'fill 1 1'), (/** @type {Error} */ err) => err.name === 'GauntletRuleError');
  const done = game.step(game.reset(tiny, 's'), 0, 'fill 1 1');
  const finished = { ...done, status: /** @type {'solved'} */ ('solved') };
  assert.throws(() => game.step(finished, 0, 'fill 1 1'), (/** @type {Error} */ err) => err.name === 'GauntletRuleError');
});

test('tier budgets cover 5x measured par and rise with rank', () => {
  assert.ok(classic.maxActions >= tiny.maxActions);
  assert.ok(grand.maxActions >= classic.maxActions);
  assert.ok(probe.maxActions >= grand.maxActions);
  for (let i = 0; i < 6; i++) {
    for (const tier of [tiny, classic, grand, probe]) {
      const state = game.reset(tier, publicSeed('nonogram', tier.id, i));
      assert.ok(tier.maxActions >= 5 * state.par, `${tier.id}: budget ${tier.maxActions} < 5x par ${state.par}`);
    }
  }
});

test('engine baseline scores exactly 1.0 on every tier; greedy calibration reported', async () => {
  const SEEDS = 25;
  /** @type {string[]} */
  const report = ['tier | baseline | mean episode score | solved fraction (25 public seeds)'];
  for (const tier of [tiny, classic, grand, probe]) {
    /** @type {[string, (options: { episodeSeed: string }) => import('../../core/types.js').Agent][]} */
    const baselines = [
      ['engine', createEngineAgent],
      ['greedy', createGreedyAgent],
    ];
    for (const [id, create] of baselines) {
      let total = 0;
      let solved = 0;
      for (let i = 0; i < SEEDS; i++) {
        const seed = publicSeed('nonogram', tier.id, i);
        const trajectory = await runEpisode({ game, tierId: tier.id, seed, agent: create({ episodeSeed: seed }) });
        if (i === 0 && id === 'engine') {
          // The engine's first trajectory per tier must replay exactly.
          await assert.doesNotReject(() => verifyTrajectory(game, trajectory));
        }
        const outcome = trajectory.end.outcome;
        assert.ok(outcome, 'episode ended without an outcome');
        assert.ok(trajectory.end.reason === 'terminal' || trajectory.end.reason === 'budget-exhausted');
        const episodeScore = outcome.normalized[0];
        assert.ok(episodeScore >= 0 && episodeScore <= 1);
        total += episodeScore;
        if (outcome.solved) solved++;
        if (id === 'engine') {
          assert.equal(trajectory.end.reason, 'terminal', 'engine must always complete the grid');
          assert.equal(outcome.solved, true);
          assert.equal(episodeScore, 1.0, 'engine scores exactly 1.0');
        } else if (tier.params.grade === 'probe') {
          // The line-only greedy agent must stall on probe-tier puzzles.
          assert.equal(trajectory.end.reason, 'budget-exhausted', 'greedy must exhaust its budget on probe');
          assert.equal(outcome.solved, false);
          assert.equal(episodeScore, 0);
        }
      }
      report.push(`${tier.id} | ${id} | ${(total / SEEDS).toFixed(3)} | ${(solved / SEEDS).toFixed(2)}`);
    }
  }
  console.log(`baseline table:\n${report.join('\n')}`);
});

test('runConformance passes every tier', async () => {
  const report = await runConformance(game);
  assert.equal(report.ok, true);
  assert.equal(report.game, 'nonogram');
  assert.ok(report.checks > 0);
});
