/**
 * Sudoku packet tests: game contract, rules, uniqueness, determinism, tier
 * grades, baseline behavior, and outcome scoring. All fixture episodes run
 * through the real `runEpisode` runner against the 25 public seeds per tier.
 *
 * The exhaustive verification (500 puzzles per tier, cross-process soak,
 * mutation controls) lives in `games/sudoku/benchmark.js`.
 *
 * @module
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { runEpisode } from '../../core/runner.js';
import { countSolutions, gradePuzzle } from './solver.js';
import { game } from './index.js';
import { createGreedyAgent, createEngineAgent } from './baselines.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Public seeds per tier, matching the spec's `publicSeeds: 25`. */
const N_PUBLIC = 25;
/** @type {string[]} */
const PUBLIC_SEEDS = Array.from(
  { length: N_PUBLIC },
  (_, n) => `sudoku/public/${n}`
);

/** @param {string} tierId @returns {import('../../core/types.js').TierSpec} */
function tierById(tierId) {
  const tier = game.spec.tiers.find((t) => t.id === tierId);
  assert.ok(tier, `tier ${tierId} exists`);
  return tier;
}

const TIERS = ['mini-4x4', 'easy', 'medium', 'hard'];

test('spec shape: four tiers, ranks, scoring, budgets', () => {
  assert.equal(game.spec.id, 'sudoku');
  assert.deepEqual(
    game.spec.tiers.map((t) => t.id),
    TIERS
  );
  assert.deepEqual(
    game.spec.tiers.map((t) => t.rank),
    [1, 2, 3, 4]
  );
  for (const tier of game.spec.tiers) {
    assert.equal(tier.scoring, 'efficiency');
    assert.equal(tier.parKind, 'optimal');
    assert.equal(tier.publicSeeds, 25);
  }
  assert.deepEqual(
    game.spec.tiers.map((t) => t.maxActions),
    [26, 76, 96, 116]
  );
  // rulesText pins the 1-based labeling contract explicitly.
  assert.match(game.spec.rulesText, /1-based/);
  assert.match(game.spec.rulesText, /place <row> <column> <digit>/);
});

test('reset: deterministic in (tier, seed), fresh deep copy per call', () => {
  const tier = tierById('easy');
  const a = game.reset(tier, 'sudoku/public/0');
  const b = game.reset(tier, 'sudoku/public/0');
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  assert.notEqual(a.cells, b.cells, 'cells array must not be shared');
  // Mutating one copy must not leak into the next.
  a.cells[0] = (a.cells[0] + 1) % 10;
  assert.deepEqual(game.reset(tier, 'sudoku/public/0'), b);
});

test('reset: cross-process determinism (fresh node, no shared state)', () => {
  const script = `
    import { game } from ${JSON.stringify(path.join(HERE, 'index.js'))};
    const tier = game.spec.tiers.find((t) => t.id === 'easy');
    const s = game.reset(tier, 'sudoku/public/0');
    process.stdout.write(JSON.stringify({ givens: s.givens, solution: s.solution, par: s.par }));
  `;
  const child = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    cwd: path.join(HERE, '..', '..'),
  });
  const fromChild = JSON.parse(child);
  const inProc = game.reset(tierById('easy'), 'sudoku/public/0');
  assert.deepEqual(fromChild.givens, inProc.givens);
  assert.deepEqual(fromChild.solution, inProc.solution);
  assert.equal(fromChild.par, inProc.par);
});

test('reset: different seeds give different puzzles', () => {
  const tier = tierById('easy');
  const a = game.reset(tier, 'sudoku/public/0');
  const b = game.reset(tier, 'sudoku/public/1');
  assert.notDeepEqual(a.givens, b.givens);
});

test('uniqueness + grade acceptance on all public seeds', { timeout: 240_000 }, () => {
  const expectations = /** @type {const} */ ({
    'mini-4x4': { size: 4, maxGrade: 0 },
    easy: { size: 9, maxGrade: 0 },
    medium: { size: 9, minGrade: 1, maxGrade: 1 },
    hard: { size: 9, minGrade: 2 },
  });
  for (const tierId of TIERS) {
    const tier = tierById(tierId);
    const want = expectations[/** @type {keyof typeof expectations} */ (tierId)];
    for (const seed of PUBLIC_SEEDS) {
      const s = game.reset(tier, seed);
      assert.equal(s.size, want.size, `${tierId}/${seed}`);
      assert.equal(s.status, 'playing');
      assert.equal(s.par, s.givens.filter((v) => v === 0).length);
      assert.equal(s.clues, s.size * s.size - s.par);
      // The oracle says exactly one solution, and givens agree with it.
      assert.equal(countSolutions(s.givens, s, 2), 1, `${tierId}/${seed}`);
      for (let i = 0; i < s.givens.length; i++) {
        if (s.givens[i]) assert.equal(s.givens[i], s.solution[i]);
      }
      const grade = gradePuzzle(s.givens, s);
      if ('maxGrade' in want) assert.ok(grade <= want.maxGrade, `${tierId}/${seed} grade ${grade}`);
      if ('minGrade' in want) assert.ok(grade >= want.minGrade, `${tierId}/${seed} grade ${grade}`);
    }
  }
});

test('observation hides the solution and labels the grid 1-based', () => {
  const tier = tierById('mini-4x4');
  const s = game.reset(tier, 'sudoku/public/0');
  const obs = game.observe(s, 0);
  assert.equal(JSON.stringify(obs).includes('"solution"'), false);
  assert.equal(JSON.stringify(obs).includes(s.solution.join(',')), false);
  // Grid header carries column labels 1..4 and rows are labelled 1..4.
  const lines = obs.text.split('\n');
  assert.match(lines[2], /1 {2}2 \| 3 {2}4/);
  assert.match(lines[3], /^1 {2}/);
  assert.match(lines[6], /^4 {2}/);
  // Legal actions are canonical, sorted, and match the grammar.
  const legal = game.legalActions(s, 0);
  assert.ok(legal.length > 0);
  assert.deepEqual(legal, [...legal].sort());
  for (const a of legal) assert.match(a, /^(place|erase) \d+ \d+( \d+)?$/);
  assert.match(obs.text, /Legal actions:/);
});

test('parseAction: canonical, alternates, quotes, whitespace, case', () => {
  const tier = tierById('mini-4x4');
  const s = game.reset(tier, 'sudoku/public/0');
  const legal = game.legalActions(s, 0);
  assert.ok(legal[0].startsWith('place'));
  const [r, c, d] = legal[0].split(' ').slice(1);
  for (const text of [
    `place ${r} ${c} ${d}`,
    `  place   ${r}   ${c}   ${d}  `,
    `PLACE ${r} ${c} ${d}`,
    `put ${r} ${c} ${d}`,
    `set ${r} ${c} ${d}`,
    `fill ${r} ${c} ${d}`,
    `"place ${r} ${c} ${d}"`,
    `\`place ${r} ${c} ${d}\``,
  ]) {
    const parsed = game.parseAction(s, 0, text);
    assert.deepEqual(parsed, { ok: true, action: `place ${r} ${c} ${d}` }, text);
  }
  // Erasing an already-empty cell is rejected with a helpful error.
  const firstEmpty = s.givens.findIndex((v) => v === 0);
  const feR = Math.floor(firstEmpty / s.size) + 1;
  const feC = (firstEmpty % s.size) + 1;
  const emptyErase = game.parseAction(s, 0, `erase ${feR} ${feC}`);
  assert.equal(emptyErase.ok, false, 'erase on an empty cell must be rejected');
  if (!emptyErase.ok) assert.match(emptyErase.error, /already empty/);
  // Erase alternates parse against a cell the player has filled: step the
  // first legal place, then parse the erase variants on the new state.
  const [pr, pc] = legal[0].split(' ').slice(1);
  const s2 = game.step(s, 0, legal[0]);
  for (const text of [`erase ${pr} ${pc}`, `clear ${pr} ${pc}`, `remove ${pr} ${pc}`, `delete ${pr} ${pc}`]) {
    const parsed = game.parseAction(s2, 0, text);
    assert.deepEqual(parsed, { ok: true, action: `erase ${pr} ${pc}` }, text);
  }
});

test('parseAction: rejects every malformed or illegal form with a helpful error', () => {
  const tier = tierById('mini-4x4');
  const s = game.reset(tier, 'sudoku/public/0');
  /** @param {string} text @param {RegExp} pattern */
  const rejects = (text, pattern) => {
    const parsed = game.parseAction(s, 0, text);
    assert.equal(parsed.ok, false, text);
    if (!parsed.ok) assert.match(parsed.error, pattern, text);
  };
  rejects('nonsense', /cannot parse/);
  rejects('place 1 1', /cannot parse/);
  rejects('place 1 1 0', /outside the range/);
  rejects(`place 1 1 ${s.size + 1}`, /outside the range/);
  rejects('place 0 1 2', /outside the grid/);
  rejects(`place ${s.size + 1} 1 2`, /outside the grid/);
  rejects('place 1 1 99', /outside the range/);
  rejects('drop 2 2', /cannot parse/);
  // A given clue: place and erase both rejected.
  const given = s.givens.findIndex((v) => v !== 0);
  const gr = Math.floor(given / s.size) + 1;
  const gc = (given % s.size) + 1;
  rejects(`place ${gr} ${gc} 1`, /given clue/);
  rejects(`erase ${gr} ${gc}`, /given clue/);
  // An empty cell cannot be erased.
  const empty = s.givens.findIndex((v) => v === 0);
  const er = Math.floor(empty / s.size) + 1;
  const ec = (empty % s.size) + 1;
  rejects(`erase ${er} ${ec}`, /already empty/);
  // A visible duplicate in the row is rejected as invalid.
  const rowDup = findVisibleDuplicate(s);
  assert.ok(rowDup, 'mini seed 0 has a visible duplicate available');
  if (rowDup) {
    rejects(`place ${rowDup.r} ${rowDup.c} ${rowDup.d}`, /repeats a visible digit/);
  }
});

/**
 * Find a (row, column, digit) that is empty, locally placeable per the
 * grammar's legal list being absent… actually the opposite: a digit that
 * already appears in the target row, so the placement must be rejected.
 *
 * @param {ReturnType<typeof game.reset>} s
 * @returns {{ r: number, c: number, d: number } | null}
 */
function findVisibleDuplicate(s) {
  for (let r = 1; r <= s.size; r++) {
    const rowDigits = [];
    for (let c = 1; c <= s.size; c++) {
      const v = s.cells[(r - 1) * s.size + (c - 1)];
      if (v) rowDigits.push(v);
    }
    for (let c = 1; c <= s.size; c++) {
      const i = (r - 1) * s.size + (c - 1);
      if (s.cells[i]) continue;
      for (const d of rowDigits) {
        if (d !== s.cells[i]) return { r, c, d };
      }
    }
  }
  return null;
}

test('step: pure, applies placements and erasures, rejects illegal actions', () => {
  const tier = tierById('mini-4x4');
  const s = game.reset(tier, 'sudoku/public/0');
  const snapshot = JSON.parse(JSON.stringify(s));
  const legal = game.legalActions(s, 0);
  const placeAction = legal.find((a) => a.startsWith('place'));
  assert.ok(placeAction);
  const [, r, c, d] = placeAction.split(' ');
  const idx = (Number(r) - 1) * s.size + (Number(c) - 1);
  const next = game.step(s, 0, placeAction);
  // Purity: input untouched.
  assert.deepEqual(s, snapshot);
  assert.equal(next.cells[idx], Number(d));
  assert.equal(s.cells[idx], 0);
  // Round-trip: every legal action parses and steps without throwing.
  // step is pure, so every action can be applied to the same base state.
  let stepped = 0;
  for (const a of game.legalActions(s, 0)) {
    const parsed = game.parseAction(s, 0, a);
    assert.deepEqual(parsed, { ok: true, action: a });
    game.step(s, 0, a);
    stepped++;
  }
  assert.ok(stepped > 0);
  // Illegal actions throw GauntletRuleError with the parse error.
  assert.throws(() => game.step(s, 0, 'place 1 1 99'), /outside the range/);
  assert.throws(() => game.step(s, 0, 'nonsense'), /cannot parse/);
  assert.throws(
    () => game.step({ ...s, status: 'solved' }, 0, 'place 1 1 2'),
    /game is over/
  );
});

test('toAct: seat 0 while playing, null when over', () => {
  const tier = tierById('mini-4x4');
  const s = game.reset(tier, 'sudoku/public/0');
  assert.equal(game.toAct(s), 0);
  assert.equal(game.toAct({ ...s, status: 'solved' }), null);
});

test('truncate: method-bound outcome with a partial-credit diagnostic', () => {
  const tier = tierById('easy');
  const s = game.reset(tier, 'sudoku/public/0');
  const outcome = game.truncate(s);
  assert.equal(outcome.solved, false);
  assert.deepEqual(outcome.normalized, [0]);
  assert.match(outcome.reason, /truncated/);
  // Raw tally: on a fresh grid the only correct entries are givens, which
  // are excluded — so raw is 0.
  assert.deepEqual(outcome.raw, [0]);
  const half = s.par >> 1;
  const patched = /** @type {typeof s} */ (
    JSON.parse(JSON.stringify(s))
  );
  let placed = 0;
  for (let i = 0; i < patched.cells.length && placed < half; i++) {
    if (!patched.cells[i]) {
      patched.cells[i] = patched.solution[i];
      placed++;
    }
  }
  const partial = game.truncate(patched);
  assert.deepEqual(partial.raw, [half]);
});

test('engine baseline solves mini, easy and medium at par on all public seeds', { timeout: 300_000 }, async () => {
  for (const tierId of ['mini-4x4', 'easy', 'medium']) {
    const tier = tierById(tierId);
    for (const seed of PUBLIC_SEEDS) {
      const traj = await runEpisode({
        game,
        tierId,
        seed,
        agent: createEngineAgent({ episodeSeed: seed }),
      });
      const outcome = /** @type {import('../../core/types.js').Outcome} */ (traj.end.outcome);
      assert.equal(outcome.solved, true, `${tierId}/${seed}: ${outcome.reason}`);
      assert.deepEqual(outcome.normalized, [1]);
      assert.equal(traj.end.agentActions, outcome.par, `${tierId}/${seed} must land at par`);
      // The 'stuck' ending is unreachable on unique-solution puzzles.
      assert.doesNotMatch(outcome.reason, /does not match/);
    }
  }
});

test('engine baseline solves hard at par on all public seeds, placing only correct digits', { timeout: 300_000 }, async () => {
  // The engine privately solves each unique-solution puzzle and places only
  // correct digits, so it is the tier ladder's ceiling on every tier and the
  // calibration c-check (engine solved fraction >= 0.95) holds on hard too.
  // The tier still discriminates through efficiency: any wrong digit costs an
  // erase plus a place, dropping the episode below 1.0.
  for (const seed of PUBLIC_SEEDS) {
    const traj = await runEpisode({
      game,
      tierId: 'hard',
      seed,
      agent: createEngineAgent({ episodeSeed: seed }),
    });
    const outcome = /** @type {import('../../core/types.js').Outcome} */ (traj.end.outcome);
    assert.equal(outcome.solved, true, `hard/${seed}: ${outcome.reason}`);
    assert.deepEqual(outcome.normalized, [1]);
    assert.equal(
      traj.end.agentActions,
      /** @type {number} */ (outcome.par),
      `hard/${seed} must land exactly at par`
    );
    for (const step of traj.steps) {
      assert.match(step.action, /^place /, `hard/${seed}: the engine only places, never erases`);
    }
    assert.doesNotMatch(outcome.reason, /does not match/);
  }
});

test('greedy baseline: perfect on singles tiers, cannot be trusted on medium/hard', { timeout: 300_000 }, async () => {
  for (const tierId of ['mini-4x4', 'easy']) {
    for (const seed of PUBLIC_SEEDS) {
      const traj = await runEpisode({
        game,
        tierId,
        seed,
        agent: createGreedyAgent({ episodeSeed: seed }),
      });
      const outcome = /** @type {import('../../core/types.js').Outcome} */ (traj.end.outcome);
      assert.equal(outcome.solved, true, `${tierId}/${seed}: ${outcome.reason}`);
      assert.equal(traj.end.agentActions, outcome.par);
    }
  }
  // Medium: grade-1 puzzles eventually leave the greedy agent without a
  // forced cell; its unrepaired guesses usually sink it. Pin a ceiling well
  // below the engine's 25/25 rather than an exact rate.
  let greedySolved = 0;
  for (const seed of PUBLIC_SEEDS) {
    const traj = await runEpisode({
      game,
      tierId: 'medium',
      seed,
      agent: createGreedyAgent({ episodeSeed: seed }),
    });
    const outcome = /** @type {import('../../core/types.js').Outcome} */ (traj.end.outcome);
    if (outcome.solved) {
      greedySolved++;
      assert.deepEqual(outcome.normalized, [1]);
    }
  }
  assert.ok(greedySolved < 25, 'greedy must not solve medium on every seed');
});

test('invalid actions consume budget without changing the grid', { timeout: 60_000 }, async () => {
  const tierId = 'mini-4x4';
  const seed = 'sudoku/public/0';
  const inner = createEngineAgent({ episodeSeed: seed, id: 'saboteur-engine' });
  let turns = 0;
  const agent = {
    id: 'saboteur',
    track: /** @type {'baseline'} */ ('baseline'),
    async act(/** @type {any} */ ctx) {
      turns++;
      if (turns === 1) return { text: 'nonsense' };
      // Mirror the engine from turn 2 on: the one wasted attempt is the
      // nonsense opening.
      return inner.act(ctx);
    },
  };
  const traj = await runEpisode({ game, tierId, seed, agent });
  const outcome = /** @type {import('../../core/types.js').Outcome} */ (traj.end.outcome);
  assert.equal(outcome.solved, true, outcome.reason);
  // Exactly one wasted attempt: par + 1 actions for a par-cell fill.
  assert.equal(traj.end.agentActions, /** @type {number} */ (outcome.par) + 1);
  assert.deepEqual(outcome.normalized, [1]);
});

test('runEpisode trajectory is replay-verified end to end', { timeout: 60_000 }, async () => {
  const tier = tierById('mini-4x4');
  const seed = 'sudoku/public/3';
  const traj = await runEpisode({
    game,
    tierId: 'mini-4x4',
    seed,
    agent: createEngineAgent({ episodeSeed: seed }),
  });
  const outcome = /** @type {import('../../core/types.js').Outcome} */ (traj.end.outcome);
  assert.equal(outcome.solved, true, outcome.reason);
  assert.ok(traj.steps.length > 0);
  // Every recorded action was legal at its step: re-run the same episode
  // and confirm identical action count (runner-level verification covers
  // the legality; determinism makes the replay identical).
  const again = await runEpisode({
    game,
    tierId: 'mini-4x4',
    seed,
    agent: createEngineAgent({ episodeSeed: seed }),
  });
  assert.deepEqual(
    traj.steps.map((/** @type {any} */ s) => s.action),
    again.steps.map((/** @type {any} */ s) => s.action)
  );
});
