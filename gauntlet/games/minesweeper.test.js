import { test } from 'node:test';
import assert from 'node:assert/strict';
import game, { createBoard } from './minesweeper/index.js';
import { createDeductionAgent, createProbabilityAgent } from './minesweeper/baselines.js';
import { FLAG, HIDDEN, logicalPass, mineProbabilities, neighborLists } from './minesweeper/solver.js';
import { runConformance } from '../core/conformance.js';
import { runEpisode } from '../core/runner.js';
import { GauntletRuleError } from '../core/errors.js';

/**
 * @param {string} id
 * @returns {import('../core/types.js').TierSpec}
 */
const tier = (id) => {
  const found = game.spec.tiers.find((/** @type {{ id: string }} */ t) => t.id === id);
  if (!found) throw new Error(`missing tier ${id}`);
  return found;
};

test('reset is deterministic in (tier, seed) and survives a JSON round trip', () => {
  for (const id of ['beginner', 'intermediate', 'expert', 'torus']) {
    const a = game.reset(tier(id), 'seed-one');
    const b = game.reset(tier(id), 'seed-one');
    assert.deepEqual(a, b, `${id}: same seed must give the same board`);
    assert.deepEqual(JSON.parse(JSON.stringify(a)), a, `${id}: state must be plain JSON`);
  }
  const other = game.reset(tier('beginner'), 'seed-two');
  assert.notDeepEqual(game.reset(tier('beginner'), 'seed-one'), other);
});

test('every generated board is clearable by pure deduction from its opening', () => {
  // The acceptance test is the product: replay it here for a spread of
  // seeds and tiers, independently of the generator's own loop.
  for (const [id, seeds] of /** @type {[string, string[]][]} */ ([
    ['beginner', ['s1', 's2', 's3', 's4', 's5']],
    ['intermediate', ['s1', 's2', 's3']],
    ['expert', ['s1', 's2']],
    ['torus', ['s1', 's2', 's3']],
  ])) {
    const t = tier(id);
    for (const seed of seeds) {
      const state = game.reset(t, seed);
      assert.equal(state.status, 'playing');
      const neighbors = neighborLists(state.rows, state.cols, state.wrap);
      const view = state.revealed.map((revealed, i) =>
        revealed ? state.counts[i] : HIDDEN
      );
      const safeTotal = state.rows * state.cols - state.minesTotal;
      let revealedCount = state.revealed.filter(Boolean).length;
      for (;;) {
        const { safe, mines } = logicalPass(view, neighbors, state.minesTotal);
        if (safe.length === 0 && mines.length === 0) break;
        for (const m of mines) view[m] = FLAG;
        for (const s of safe) {
          if (view[s] !== HIDDEN) continue;
          const stack = [s];
          while (stack.length > 0) {
            const i = /** @type {number} */ (stack.pop());
            if (view[i] !== HIDDEN) continue;
            view[i] = state.counts[i];
            revealedCount++;
            if (state.counts[i] === 0) {
              for (const j of neighbors[i]) if (view[j] === HIDDEN) stack.push(j);
            }
          }
        }
      }
      assert.equal(
        revealedCount,
        safeTotal,
        `${id}/${seed}: deduction must clear the whole board (attempts=${state.attempts})`
      );
    }
  }
});

test('the opening is already revealed and the observation leaks no hidden information', () => {
  const state = game.reset(tier('beginner'), 'seed-one');
  assert.ok(state.revealed.some(Boolean), 'the opening zero cell is revealed');
  const observation = game.observe(state, 0);
  const dataJson = JSON.stringify(observation.data);
  assert.ok(!dataJson.includes('"mines"'), 'observation data must not carry the mine list');
  assert.ok(!dataJson.includes('"counts"'), 'observation data must not carry the count grid');
  const view = /** @type {number[]} */ (observation.data.view);
  assert.equal(view.length, state.rows * state.cols);
  for (let i = 0; i < view.length; i++) {
    if (state.revealed[i]) {
      assert.equal(view[i], state.counts[i], `revealed cell ${i} shows its count`);
    } else {
      assert.equal(view[i], HIDDEN, `hidden cell ${i} reads as hidden on a fresh board`);
    }
  }
  assert.match(observation.text, /10 mines/);
  assert.match(observation.text, /reveal <row> <column>/, 'the grammar hint is present for long legal lists');
});

test('observation data carries only public fields', () => {
  for (const params of [
    { rows: 4, cols: 4, mines: 2, wrap: false },
    { rows: 4, cols: 4, mines: 2, wrap: true },
  ]) {
    const state = createBoard(params, [0, 1], 15);
    assert.deepEqual(
      Object.keys(game.observe(state, 0).data).sort(),
      ['cols', 'minesRemaining', 'minesTotal', 'revealedSafe', 'rows', 'status', 'totalSafe', 'view', 'wrap'].sort()
    );
  }
});

test('neighborLists: plain grid corners have 3 neighbours, torus corners have 8', () => {
  const plain = neighborLists(3, 3, false);
  assert.equal(plain[0].length, 3);
  assert.equal(plain[4].length, 8);
  assert.deepEqual(plain[0], [1, 3, 4]);
  const torus = neighborLists(3, 3, true);
  assert.equal(torus[0].length, 8);
  assert.deepEqual([...torus[0]].sort(), [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((i) => i !== 0));
  assert.deepEqual([...torus[4]].sort(), [0, 1, 2, 3, 5, 6, 7, 8]);
});

test('logicalPass: a flag zeroes out the surrounding numbers', () => {
  // 3x4 grid. One mine at cell 6, already flagged; every neighbour of 6
  // shows its 1. Cells 0, 4, 8 are hidden. After subtracting the flag, each
  // 1 has no remaining mine allowance, so the hidden cells are all safe and
  // nothing is forced to be a mine.
  const neighbors = neighborLists(3, 4, false);
  const view = new Array(12).fill(HIDDEN);
  for (const i of [1, 2, 3, 5, 7, 9, 10, 11]) view[i] = 1;
  view[6] = FLAG;
  const { safe, mines } = logicalPass(view, neighbors, 1);
  assert.deepEqual(mines, [], 'nothing is forced to be a mine');
  for (const cell of [0, 4, 8]) {
    assert.ok(safe.includes(cell), `hidden cell ${cell} is provably safe`);
  }
});

test('logicalPass: the subset rule forces a mine the single-cell rule cannot see', () => {
  // 2x5 grid, top row revealed as 1 2 1, bottom row hidden.
  // Constraints: cell 0 pins {5,6} to 1 mine; cell 1 pins {5,6,7} to 2.
  // The difference {7} must hold 2 - 1 = 1 mine — only subset reasoning
  // sees it. The fixpoint then finishes the position: cell 2's constraint
  // {6,7,8} = 1 clears 6 and 8, and cell 0's {5,6} = 1 with 6 safe pins 5.
  const neighbors = neighborLists(2, 5, false);
  const view = [1, 2, 1, HIDDEN, HIDDEN, HIDDEN, HIDDEN, HIDDEN, HIDDEN, HIDDEN];
  const { safe, mines } = logicalPass(view, neighbors, 2);
  assert.ok(mines.includes(7), 'cell 7 is forced to be a mine by subset reasoning');
  assert.ok(mines.includes(5), 'cell 5 is forced once the fixpoint lands');
  for (const cell of [3, 6, 8]) {
    assert.ok(safe.includes(cell), `cell ${cell} is provably safe after the fixpoint`);
  }
});

test('mineProbabilities: exact fractions on a small frontier', () => {
  // 4x4. Flag at 0, a 3 at cell 5 (its seven hidden neighbours 1,2,4,6,8,
  // 9,10 unflagged) leaves 2 mines among those 7 cells; minesTotal 3
  // matches (2 remaining after the flag). Every 2-of-7 pairing is
  // symmetric, so each frontier cell is 2/7, and the seven cells outside
  // any constraint get the zero leftover.
  const neighbors = neighborLists(4, 4, false);
  const view = new Array(16).fill(HIDDEN);
  view[5] = 3;
  view[0] = FLAG;
  const { probabilities, exact } = mineProbabilities(view, neighbors, 3);
  assert.ok(probabilities, 'the view is consistent');
  assert.ok(exact, 'a 7-cell frontier must enumerate exactly');
  for (const i of [1, 2, 4, 6, 8, 9, 10]) {
    assert.ok(
      Math.abs(/** @type {number} */ (probabilities.get(i)) - 2 / 7) < 1e-9,
      `cell ${i} is 2/7, got ${probabilities.get(i)}`
    );
  }
  for (const i of [3, 7, 11, 12, 13, 14, 15]) {
    assert.equal(probabilities.get(i), 0, `cell ${i} lies outside the frontier with no mines left`);
  }
});

test('parseAction accepts canonical and documented alternate forms', () => {
  // 4x4, mine at cell 5, opening at cell 0 (mine-adjacent, so the opening
  // reveals exactly one cell and cells 2 2 / 3 3 stay hidden).
  const state = createBoard({ rows: 4, cols: 4, mines: 1, wrap: false }, [5], 0);
  assert.equal(state.revealed.filter(Boolean).length, 1);
  for (const [text, expected] of [
    ['reveal 2 2', 'reveal 2 2'],
    ['  reveal  2  2  ', 'reveal 2 2'],
    ['REVEAL 2 2', 'reveal 2 2'],
    ['open 2 2', 'reveal 2 2'],
    ['dig 2 2', 'reveal 2 2'],
    ['`reveal 2 2`', 'reveal 2 2'],
    ['"reveal 2 2"', 'reveal 2 2'],
    ["'reveal 2 2'", 'reveal 2 2'],
    ['flag 3 3', 'flag 3 3'],
    ['mark 3 3', 'flag 3 3'],
  ]) {
    const parsed = game.parseAction(state, 0, text);
    assert.deepEqual(parsed, { ok: true, action: expected }, `input ${JSON.stringify(text)}`);
  }
  const flagged = game.step(state, 0, 'flag 3 3');
  assert.deepEqual(game.parseAction(flagged, 0, 'unflag 3 3'), { ok: true, action: 'unflag 3 3' });
});

test('parseAction rejects unusable input with a usable error message', () => {
  const state = createBoard({ rows: 4, cols: 4, mines: 1, wrap: false }, [5], 0);
  for (const [text, fragment] of [
    ['reveal 9 9', 'outside the 4x4 grid'],
    ['reveal -1 0', 'cannot parse'],
    ['explode 2 2', 'cannot parse'],
    ['reveal 2', 'cannot parse'],
    ['', 'cannot parse'],
    ['chord 2 2', 'not a chord target'],
  ]) {
    const parsed = game.parseAction(state, 0, text);
    assert.equal(parsed.ok, false, `input ${JSON.stringify(text)} must be rejected`);
    if (!parsed.ok) assert.match(parsed.error, new RegExp(fragment));
  }
  const stepped = game.step(state, 0, 'reveal 3 3');
  const parsed = game.parseAction(stepped, 0, 'reveal 3 3');
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.error, /already revealed/);
  // A chord is only legal when the flags around a revealed number match:
  // the 1 at cell 0 has no flags around it.
  const flagged = game.step(state, 0, 'flag 2 0');
  const chordless = game.parseAction(flagged, 0, 'chord 0 0');
  assert.equal(chordless.ok, false);
  if (!chordless.ok) assert.match(chordless.error, /not a chord target/);
});

test('step: mines lose with partial credit, cascades reveal, wins score 1', () => {
  // 4x4, mine at cell 5, opening at cell 15.
  const fresh = createBoard({ rows: 4, cols: 4, mines: 1, wrap: false }, [5], 15);
  assert.equal(fresh.status, 'playing');
  assert.ok(fresh.revealed[15], 'the opening is revealed');
  const openingCount = fresh.revealed.filter(Boolean).length;
  // Stepping on the mine ends the episode at the reached fraction.
  const steppedOnMine = game.step(fresh, 0, 'reveal 1 1');
  assert.equal(steppedOnMine.status, 'lost');
  assert.equal(steppedOnMine.mineAt, 5);
  const outcome = /** @type {*} */ (game.outcome(steppedOnMine));
  assert.equal(outcome.normalized[0], openingCount / 15);
  assert.match(outcome.reason, /mine revealed at row 1, column 1/);
  assert.equal(game.outcome(fresh), null, 'a live board has no outcome yet');
  // Revealing a counted cell uncovers exactly that cell (and any connected
  // zeros), never the mine.
  const safe = game.step(fresh, 0, 'reveal 0 0');
  assert.equal(safe.status, 'playing');
  assert.ok(safe.revealed[0]);
  assert.ok(!safe.revealed[5], 'the mine is never auto-revealed');
});

test('step: flags never end the game, chords sweep proven neighbours', () => {
  // 3x3, mine at 0, opening at the centre (shows its 1) — the centre is
  // already revealed by the opening.
  const state = createBoard({ rows: 3, cols: 3, mines: 1, wrap: false }, [0], 4);
  assert.equal(state.counts[4], 1);
  // Before the flag, chord on the centre is not even legal.
  assert.ok(!game.legalActions(state, 0).includes('chord 1 1'));
  const flagged = game.step(state, 0, 'flag 0 0');
  assert.equal(flagged.status, 'playing', 'flagging is always safe');
  assert.deepEqual(game.outcome(flagged), null);
  const chorded = game.step(flagged, 0, 'chord 1 1');
  for (const i of [1, 2, 3, 5, 6, 7, 8]) {
    assert.ok(chorded.revealed[i], `chord revealed cell ${i}`);
  }
  assert.equal(chorded.status, 'won', 'those were the last safe cells');
  const outcome = /** @type {*} */ (game.outcome(chorded));
  assert.equal(outcome.normalized[0], 1);
  assert.match(outcome.reason, /win/);
  // A wrong flag makes the chord lethal.
  const wrong = createBoard({ rows: 3, cols: 3, mines: 1, wrap: false }, [0], 4);
  const badFlag = game.step(wrong, 0, 'flag 1 0');
  const lethal = game.step(badFlag, 0, 'chord 1 1');
  assert.equal(lethal.status, 'lost');
  assert.equal(lethal.mineAt, 0, 'the chord uncovered the mine at cell 0');
});

test('step is pure and rejects actions outside legalActions', () => {
  // 4x4, mine at cell 5, opening at cell 0: only cell 0 is revealed.
  const state = createBoard({ rows: 4, cols: 4, mines: 1, wrap: false }, [5], 0);
  const snapshot = JSON.stringify(state);
  game.step(state, 0, 'flag 1 1');
  game.step(state, 0, 'reveal 3 3');
  assert.equal(JSON.stringify(state), snapshot, 'step must not mutate its input');
  assert.throws(() => game.step(state, 0, 'reveal 9 9'), GauntletRuleError);
  assert.throws(() => game.step(state, 0, 'explode 1 1'), GauntletRuleError);
  const flagged = game.step(state, 0, 'flag 1 1');
  assert.throws(() => game.step(flagged, 0, 'reveal 1 1'), GauntletRuleError, 'revealing a flagged cell is illegal');
  assert.throws(() => game.step(flagged, 0, 'flag 1 1'), GauntletRuleError, 'double-flagging is illegal');
  const once = game.step(state, 0, 'reveal 3 3');
  assert.throws(() => game.step(once, 0, 'reveal 3 3'), GauntletRuleError, 'double reveal is illegal');
  assert.throws(() => game.step(once, 0, 'unflag 3 3'), GauntletRuleError, 'unflagging an unflagged cell is illegal');
});

test('legalActions are sorted canonical strings covering the right moves', () => {
  const state = createBoard({ rows: 3, cols: 3, mines: 1, wrap: false }, [0], 4);
  const legal = game.legalActions(state, 0);
  assert.deepEqual(legal, [...legal].sort());
  assert.ok(legal.includes('reveal 2 2'));
  assert.ok(legal.includes('flag 2 2'));
  assert.ok(!legal.includes('reveal 1 1'), 'revealed cells have no reveal action');
  assert.ok(!legal.includes('unflag 0 0'), 'unflagged cells have no unflag action');
  assert.deepEqual(game.legalActions({ ...state, status: 'won' }, 0), []);
});

test('the deduction baseline clears beginner and torus episodes end to end', async () => {
  for (const [tierId, seed] of [['beginner', 'e2e-1'], ['torus', 'e2e-1'], ['beginner', 'e2e-2']]) {
    const trajectory = await runEpisode({
      game,
      tierId,
      seed,
      agent: createDeductionAgent({ episodeSeed: seed }),
    });
    const outcome = /** @type {*} */ (trajectory.end.outcome);
    assert.equal(outcome.normalized[0], 1, `${tierId}/${seed}: the deduction baseline must win`);
    assert.ok(trajectory.steps.length > 0);
    for (const step of trajectory.steps) assert.equal(step.invalid, false);
  }
});

test('the probability baseline clears beginner episodes end to end', async () => {
  for (const seed of ['e2e-1', 'e2e-2']) {
    const trajectory = await runEpisode({
      game,
      tierId: 'beginner',
      seed,
      agent: createProbabilityAgent({ episodeSeed: seed }),
    });
    const outcome = /** @type {*} */ (trajectory.end.outcome);
    assert.equal(outcome.normalized[0], 1, `${seed}: the probability baseline must win`);
    for (const step of trajectory.steps) assert.equal(step.invalid, false);
  }
});

test('the probability agent reveals the lowest-probability cell when deduction stalls', async () => {
  // 3x3, mine at 0, centre revealed by the opening showing its 1: eight
  // hidden neighbours, one mine, no flags — every hidden cell is exactly
  // 1/8, so the tie-break by cell index picks the first hidden cell.
  const state = createBoard({ rows: 3, cols: 3, mines: 1, wrap: false }, [0], 4);
  const observation = game.observe(state, 0);
  const agent = createProbabilityAgent({ episodeSeed: 'p' });
  const reply = await agent.act({
    spec: game.spec,
    tier: tier('beginner'),
    seat: 0,
    observation,
    legalActions: game.legalActions(state, 0),
    turn: 1,
    feedback: null,
  });
  assert.equal(reply.text, 'reveal 0 0', 'the tie-break picks the first hidden cell at 1/8');
  assert.deepEqual(game.parseAction(state, 0, reply.text), { ok: true, action: 'reveal 0 0' });
});

test('conformance: the full kit passes on every tier', async () => {
  const report = await runConformance(game);
  assert.ok(report.checks > 100, `expected a substantial check count, got ${report.checks}`);
});
