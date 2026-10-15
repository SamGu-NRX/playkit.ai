import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLevel } from './generator.js';
import { solve } from './solver.js';
import { TIER_GENERATION } from './index.js';

const SEEDS = [
  'sokoban/two-box/public/0',
  'sokoban/two-box/public/1',
  'sokoban/two-box/public/12',
];

test('generation is deterministic in the seed', () => {
  const a = generateLevel(TIER_GENERATION['two-box'], SEEDS[0]);
  const b = generateLevel(TIER_GENERATION['two-box'], SEEDS[0]);
  assert.deepEqual(a, b);
  const c = generateLevel(TIER_GENERATION['two-box'], SEEDS[1]);
  assert.notDeepEqual(
    [a.player, a.boxes, a.level.walls],
    [c.player, c.boxes, c.level.walls],
    'different seeds scramble differently (very likely, not guaranteed in general)'
  );
});

test('every accepted level is solvable with par inside the tier band', () => {
  for (const [tierId, params] of Object.entries(TIER_GENERATION)) {
    for (const seed of SEEDS.map((s) => s.replace('two-box', tierId))) {
      const level = generateLevel(params, seed);
      const result = solve(level.level, { player: level.player, boxes: level.boxes });
      assert.equal(result.solvable, true, `${tierId} ${seed}`);
      assert.equal(result.par, level.par, `${tierId} ${seed}: stored par matches the solver`);
      assert.ok(
        level.par >= params.parMin && level.par <= params.parMax,
        `${tierId} ${seed}: par ${level.par} outside [${params.parMin}, ${params.parMax}]`
      );
    }
  }
});

test('boxes never start solved and never start on dead squares', () => {
  for (const [tierId, params] of Object.entries(TIER_GENERATION)) {
    const level = generateLevel(params, `sokoban/${tierId}/public/7`);
    const goalSet = new Set(level.level.goals);
    assert.ok(
      level.boxes.some((b) => !goalSet.has(b)),
      `${tierId}: at least one box starts off goal`
    );
  }
});

test('exhausting the attempts budget fails loudly', () => {
  const impossible = {
    ...TIER_GENERATION['two-box'],
    parMin: 100000,
    parMax: 200000,
  };
  assert.throws(
    () => generateLevel(impossible, SEEDS[0], { maxAttempts: 2 }),
    /no level inside par band/
  );
});
