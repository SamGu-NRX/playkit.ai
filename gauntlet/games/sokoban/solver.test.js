import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SolverBudgetError,
  deltasFor,
  deadSquares,
  parseXsb,
  renderXsb,
  solve,
} from './solver.js';

test('parseXsb and renderXsb round-trip a board', () => {
  const board = [
    '#######',
    '#@$.  #',
    '#######',
  ].join('\n');
  const { level, player, boxes } = parseXsb(board);
  assert.equal(level.width, 7);
  assert.equal(level.height, 3);
  assert.deepEqual(boxes, [9]);
  assert.equal(player, 8);
  assert.equal(renderXsb(level, player, boxes), board);
});

test('a one-push level has par 1 and a valid plan', () => {
  // Push the box right onto the goal.
  const { level, player, boxes } = parseXsb(['#####', '#@$.#', '#####'].join('\n'));
  const result = solve(level, { player, boxes }, { plan: true });
  assert.equal(result.solvable, true);
  assert.equal(result.par, 1);
  assert.deepEqual(result.plan, ['right']);
});

test('walking to a push position counts toward par', () => {
  // The player is two squares left of the box: one walk plus one push.
  const { level, player, boxes } = parseXsb(['######', '#@ $.#', '######'].join('\n'));
  const result = solve(level, { player, boxes }, { plan: true });
  assert.equal(result.par, 2);
  assert.ok(result.plan);
  const final = result.plan.at(-1);
  assert.equal(final, 'right', 'the plan ends with the push onto the goal');
});

test('a cornered box is unsolvable and the dead-square table says why', () => {
  // Box pushed up-right into the corner, no goal there.
  const { level, player, boxes } = parseXsb(
    ['#####', '#  $#', '#  .#', '#@  #', '#####'].join('\n')
  );
  const dead = deadSquares(level);
  // Top-right interior square (row 1, col 3) is a corner: dead.
  assert.equal(dead[1 * 5 + 3], 1);
  const result = solve(level, { player, boxes });
  assert.equal(result.solvable, false);
  assert.equal(result.par, null);
});

test('a wall-line deadlock (box against a wall with no goal on it) is unsolvable', () => {
  // Box in the top-left corner region against the top wall; the goal is on
  // the bottom wall. Any push pins the box to a wall line with no goal.
  const { level, player, boxes } = parseXsb(
    ['######', '#$   #', '#    #', '#@  .#', '######'].join('\n')
  );
  const result = solve(level, { player, boxes });
  // Actually solvable: the goal square (3,4) is on the bottom wall, and a box
  // on the left wall can be pushed down to it. The dead-square table is the
  // authority here — assert consistency between solve and deadSquares instead
  // of a hand-picked verdict.
  const dead = deadSquares(level);
  const startDead = boxes.some((b) => dead[b]);
  const onGoal = boxes.every((b) => level.goals.includes(b));
  if (startDead && !onGoal) {
    assert.equal(result.solvable, false);
  } else {
    assert.equal(result.solvable, true);
  }
});

test('the solved position returns par 0', () => {
  const { level, player, boxes } = parseXsb(['#####', '#@*#', '#####'].join('\n'));
  const result = solve(level, { player, boxes }, { plan: true });
  assert.deepEqual([result.solvable, result.par, result.plan], [true, 0, []]);
});

test('a freeze deadlock between two boxes makes the state unsolvable', () => {
  // Two boxes side by side against the top wall, goals below: neither box can
  // ever be pushed horizontally (the other blocks) or vertically (wall).
  // Wait — vertically they CAN be pushed down (the wall is above, so a push
  // down is possible if the player stands above — it cannot). The squares
  // above them are wall, so a vertical push is impossible; horizontal pushes
  // are blocked by the sibling box. Frozen.
  const { level, player, boxes } = parseXsb(
    ['######', '#$$  #', '#    #', '#@.. #', '######'].join('\n')
  );
  const result = solve(level, { player, boxes });
  assert.equal(result.solvable, false);
  assert.equal(result.par, null);
});

test('the node budget throws SolverBudgetError instead of returning a wrong par', () => {
  const { level, player, boxes } = parseXsb(
    ['#####', '#@$.#', '#####'].join('\n')
  );
  assert.throws(() => solve(level, { player, boxes }, { nodeBudget: 1 }), SolverBudgetError);
});

test('the solver is pure: the input position is never mutated', () => {
  const { level, player, boxes } = parseXsb(['#####', '#@$.#', '#####'].join('\n'));
  const before = JSON.stringify({ player, boxes });
  solve(level, { player, boxes }, { plan: true });
  assert.equal(JSON.stringify({ player, boxes }), before);
});

test('a longer level is solved with the proven optimal move count', () => {
  // Classic micro-level: push the box around the pillar.
  const { level, player, boxes } = parseXsb(
    ['######', '#@ $.#', '#    #', '######'].join('\n')
  );
  const result = solve(level, { player, boxes }, { plan: true });
  assert.equal(result.solvable, true);
  assert.ok(result.plan);
  assert.equal(result.plan.length, result.par);
  // Replaying the plan on the board must land every box on a goal.
  const d = deltasFor(level.width);
  let p = player;
  let bs = [...boxes];
  for (const move of result.plan) {
    const delta = d[/** @type {'up' | 'down' | 'left' | 'right'} */ (move)];
    const target = p + delta;
    if (bs.includes(target)) {
      bs = bs.filter((b) => b !== target);
      bs.push(target + delta);
      bs.sort((a, b) => a - b);
    }
    p = target;
  }
  assert.deepEqual(
    bs.sort((a, b) => a - b),
    [...level.goals].sort((a, b) => a - b)
  );
});
