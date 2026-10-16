import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slide,
  emptyCells,
  placeTile,
  spawnTile,
  observationForBoard,
  maxTile,
  DIRECTIONS,
  SPAWN_TWO_PROBABILITY,
} from './rules.js';
import { rngFromSeed } from '../../core/rng.js';

test('hand-scored fixtures: [2,2,4,4] left gives [4,8,0,0] and gains 12', () => {
  const board = [
    [2, 2, 4, 4],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const result = slide(board, 'left');
  assert.deepEqual(result.board, [
    [4, 8, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  assert.equal(result.gained, 12);
  assert.equal(result.moved, true);
});

test('hand-scored fixtures: [2,2,2,2] left gives [4,4,0,0] and gains 8', () => {
  const board = [
    [2, 2, 2, 2],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const result = slide(board, 'left');
  assert.deepEqual(result.board[0], [4, 4, 0, 0]);
  assert.equal(result.gained, 8);
});

test('no tile merges twice in one move', () => {
  // The new 4 from the 2+2 merge must not merge with the existing 4.
  const one = slide(
    [
      [2, 2, 4, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    'left'
  );
  assert.deepEqual(one.board[0], [4, 4, 0, 0]);
  assert.equal(one.gained, 4);
  // And 4,4,8 must not chain into a 16.
  const two = slide(
    [
      [4, 4, 8, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    'left'
  );
  assert.deepEqual(two.board[0], [8, 8, 0, 0]);
  assert.equal(two.gained, 8);
});

test('tiles nearest the wall merge first', () => {
  const result = slide(
    [
      [2, 2, 2, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    'left'
  );
  assert.deepEqual(result.board[0], [4, 2, 0, 0]);
  assert.equal(result.gained, 4);
  const mirrored = slide(
    [
      [0, 2, 2, 2],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    'right'
  );
  assert.deepEqual(mirrored.board[0], [0, 0, 2, 4]);
  assert.equal(mirrored.gained, 4);
});

test('each direction on an asymmetric board', () => {
  const board = [
    [2, 0, 0, 0],
    [0, 4, 0, 0],
    [0, 0, 8, 0],
    [0, 0, 0, 16],
  ];
  assert.deepEqual(slide(board, 'left').board, [
    [2, 0, 0, 0],
    [4, 0, 0, 0],
    [8, 0, 0, 0],
    [16, 0, 0, 0],
  ]);
  assert.deepEqual(slide(board, 'right').board, [
    [0, 0, 0, 2],
    [0, 0, 0, 4],
    [0, 0, 0, 8],
    [0, 0, 0, 16],
  ]);
  assert.deepEqual(slide(board, 'up').board, [
    [2, 4, 8, 16],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  assert.deepEqual(slide(board, 'down').board, [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [2, 4, 8, 16],
  ]);
  for (const dir of DIRECTIONS) {
    assert.equal(slide(board, dir).gained, 0, `${dir} gains nothing here`);
    assert.equal(slide(board, dir).moved, true, `${dir} moves this board`);
  }
});

test('a no-op slide reports moved false, gains nothing, and does not mutate input', () => {
  const board = [
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ];
  for (const dir of DIRECTIONS) {
    const result = slide(board, dir);
    assert.equal(result.moved, false, `${dir} is a no-op on a locked checkerboard`);
    assert.equal(result.gained, 0);
    assert.deepEqual(result.board, board);
    assert.notEqual(result.board, board, 'slide returns a fresh board');
  }
  assert.deepEqual(board, [
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ]);
});

test('emptyCells lists row-major [row, column] pairs', () => {
  const board = [
    [2, 0, 0, 4],
    [0, 0, 0, 0],
    [0, 0, 8, 0],
    [0, 0, 0, 0],
  ];
  assert.deepEqual(emptyCells(board), [
    [0, 1],
    [0, 2],
    [1, 0],
    [1, 1],
    [1, 2],
    [1, 3],
    [2, 0],
    [2, 1],
    [2, 3],
    [3, 0],
    [3, 1],
    [3, 2],
    [3, 3],
  ]);
  assert.deepEqual(emptyCells([[4, 4], [4, 4]]), []);
});

test('placeTile puts a value on a copy', () => {
  const board = [
    [0, 0],
    [0, 0],
  ];
  const placed = placeTile(board, 1, 1, 2);
  assert.deepEqual(placed, [
    [0, 0],
    [0, 2],
  ]);
  assert.deepEqual(board, [
    [0, 0],
    [0, 0],
  ]);
  assert.throws(() => placeTile(board, 5, 0, 2), RangeError);
  assert.throws(() => placeTile(board, 0, -1, 2), RangeError);
});

test('spawnTile draws value first, then a uniformly chosen empty cell', () => {
  const board = [
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const spawned = spawnTile(board, rngFromSeed('spawn-test'));
  assert.deepEqual(board, [
    [2, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const deltas = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (spawned.board[r][c] !== board[r][c]) deltas.push([r, c, spawned.board[r][c]]);
    }
  }
  assert.equal(deltas.length, 1, 'exactly one tile spawns');
  assert.ok([2, 4].includes(deltas[0][2]), 'the spawned tile is a 2 or a 4');
  // Deterministic: the same rng state spawns the same tile.
  const again = spawnTile(board, rngFromSeed('spawn-test'));
  assert.deepEqual(again.board, spawned.board);
  assert.deepEqual(again.rng, spawned.rng);
});

test('spawn value and cell distributions over 10,000 seeded draws', () => {
  const draws = 10000;
  let twos = 0;
  let fours = 0;
  /** @type {number[]} */
  const cellCounts = new Array(16).fill(0);
  for (let i = 0; i < draws; i++) {
    const empty = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    const spawned = spawnTile(empty, rngFromSeed(`2048/spawn/${i}`));
    let placed = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const v = spawned.board[r][c];
        if (v !== 0) {
          placed++;
          cellCounts[r * 4 + c]++;
          if (v === 2) twos++;
          else if (v === 4) fours++;
        }
      }
    }
    assert.equal(placed, 1);
  }
  const pTwo = twos / draws;
  assert.ok(
    Math.abs(pTwo - SPAWN_TWO_PROBABILITY) < 0.02,
    `P(spawn 2) = ${pTwo}, expected ${SPAWN_TWO_PROBABILITY} within 0.02`
  );
  assert.equal(twos + fours, draws);
  // Uniform cells: expected 625 each; 3-sigma is about 73, allow 100.
  for (let cell = 0; cell < 16; cell++) {
    assert.ok(
      Math.abs(cellCounts[cell] - draws / 16) < 100,
      `cell ${cell} drew ${cellCounts[cell]} times, expected ~${draws / 16}`
    );
  }
});

test('maxTile and observationForBoard', () => {
  const board = [
    [2, 4, 0, 0],
    [0, 0, 0, 0],
    [0, 1024, 0, 0],
    [0, 0, 0, 0],
  ];
  assert.equal(maxTile(board), 1024);
  const observation = observationForBoard(board, 20214);
  assert.equal(typeof observation.text, 'string');
  assert.ok(observation.text.includes('Score: 20214'));
  assert.ok(observation.text.includes('1024'));
  assert.deepEqual(observation.data, { board, score: 20214 });
  assert.notEqual(observation.data.board, board);
});
