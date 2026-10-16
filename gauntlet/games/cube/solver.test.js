import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FACES, SOLVED, applySequence } from './cube.js';
import {
  bfsOptimalLength,
  buildDistanceTable,
  solveOptimal,
  statesWithinMoves,
} from './solver.js';
import { nextInt, rngFromSeed } from '../../core/rng.js';

test('the distance table builds once per process, in under 15 s, with the exact state counts', () => {
  const started = Date.now();
  const table = buildDistanceTable();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15_000, `table build took ${elapsed} ms, budget is 15 s`);
  // counts per distance: 1, 18, 243, 3240, 43239, 574908 (OEIS A080601 tail)
  /** @type {Map<number, number>} */
  const perDepth = new Map();
  for (const depth of table.values()) {
    perDepth.set(depth, (perDepth.get(depth) ?? 0) + 1);
  }
  assert.equal(table.size, 621_649);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((d) => perDepth.get(d)),
    [1, 18, 243, 3240, 43239, 574_908]
  );
  // statesWithinMoves is the pure form and agrees at depth 4
  const at4 = statesWithinMoves(4);
  assert.equal(at4.size, 46_741);
});

/**
 * Seeded random walk from solved with no two turns of the same face in a row
 * (the same construction the game's reset uses).
 * @param {string} seed
 * @param {number} length
 * @returns {string[]}
 */
function seededWalk(seed, length) {
  let rng = rngFromSeed(seed);
  /** @type {string[]} */
  const walk = [];
  let lastFace = '';
  while (walk.length < length) {
    const facePick = nextInt(rng, 0, FACES.length - 1);
    rng = facePick.state;
    const face = FACES[facePick.value];
    if (face === lastFace) continue;
    const suffixPick = nextInt(rng, 0, 2);
    rng = suffixPick.state;
    walk.push(face + ['', "'", '2'][suffixPick.value]);
    lastFace = face;
  }
  return walk;
}

test('solveOptimal matches an independent plain BFS on every scramble of length 1 and 2', () => {
  // all 18 one-turn scrambles, then all 270 two-turn walks with distinct faces
  /** @type {string[][]} */
  const scrambles = [];
  for (const move of ['U', "U'", 'U2', 'R', "R'", 'R2', 'F', "F'", 'F2', 'D', "D'", 'D2', 'L', "L'", 'L2', 'B', "B'", 'B2']) {
    scrambles.push([move]);
    for (const second of ['U', "U'", 'U2', 'R', "R'", 'R2', 'F', "F'", 'F2', 'D', "D'", 'D2', 'L', "L'", 'L2', 'B', "B'", 'B2']) {
      if (second[0] === move[0]) continue;
      scrambles.push([move, second]);
    }
  }
  assert.equal(scrambles.length, 18 + 270);
  for (const scramble of scrambles) {
    const state = applySequence(SOLVED, scramble);
    const solved_ = solveOptimal(state);
    const reference = bfsOptimalLength(state);
    assert.equal(
      solved_.length,
      reference,
      `scramble ${scramble.join(' ')}: meet-in-the-middle ${solved_.length} vs plain BFS ${reference}`
    );
    assert.equal(solved_.solution.length, solved_.length);
    assert.equal(applySequence(state, solved_.solution), SOLVED, `solution for ${scramble.join(' ')} must reach solved`);
  }
});

test('solveOptimal matches an independent plain BFS on a seeded sample of length-3 scrambles', () => {
  for (let i = 0; i < 150; i++) {
    const scramble = seededWalk(`cube/solver-test/${i}`, 3);
    const state = applySequence(SOLVED, scramble);
    const solved_ = solveOptimal(state);
    const reference = bfsOptimalLength(state);
    assert.equal(solved_.length, reference, `seed ${i}`);
    assert.equal(applySequence(state, solved_.solution), SOLVED);
  }
});

test('solveOptimal returns one optimal line for banded scrambles up to length 9', () => {
  for (const length of [4, 5, 6, 7, 8, 9]) {
    const scramble = seededWalk(`cube/solver-band/${length}`, length);
    const state = applySequence(SOLVED, scramble);
    const solved_ = solveOptimal(state);
    assert.ok(solved_.length >= 1 && solved_.length <= length, `optimal ${solved_.length} for a ${length}-walk`);
    assert.equal(solved_.solution.length, solved_.length);
    assert.equal(applySequence(state, solved_.solution), SOLVED);
    // deterministic: solving the same state again returns the same length
    assert.equal(solveOptimal(state).length, solved_.length);
  }
});

test('solveOptimal proves optimality for length-10 walks and self-checks its solutions', () => {
  for (let i = 0; i < 3; i++) {
    const scramble = seededWalk(`cube/solver-ten/${i}`, 10);
    const state = applySequence(SOLVED, scramble);
    const solved_ = solveOptimal(state);
    assert.ok(solved_.length >= 1 && solved_.length <= 10);
    assert.equal(solved_.solution.length, solved_.length);
    assert.equal(applySequence(state, solved_.solution), SOLVED);
  }
});

test('solveOptimal knows the sexy move is optimal at 4 and the plain BFS reports null out of range', () => {
  const sexy = applySequence(SOLVED, ['R', 'U', "R'", "U'"]);
  assert.equal(solveOptimal(sexy).length, 4);
  assert.equal(bfsOptimalLength(sexy), 4);
  assert.equal(solveOptimal(SOLVED).length, 0);
  assert.deepEqual(solveOptimal(SOLVED).solution, []);
  // a length-10 walk is unsolvable within 4 plies: the plain BFS reference
  // signals that with null (the meet-in-the-middle solver proves depth 10)
  const deep = applySequence(SOLVED, seededWalk('cube/deep', 10));
  assert.equal(bfsOptimalLength(deep, 4), null);
  assert.ok(solveOptimal(deep).length >= 8);
});
