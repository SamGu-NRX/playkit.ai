/**
 * Reference-implementation differential tests for the 2048 fast paths.
 *
 * The expectimax engine (games/2048/baselines.js) runs on lookup tables built
 * from `packSlideLeft` — a 16-bit, 4-bits-per-tile rank encoding — while the
 * official rules run on tile values in `rules.slide`. Nothing previously
 * compared the two (PR #12 review, MEDIUM, issue comment 6199629070: the
 * classic double-merge mutation passed the whole suite), so these tests
 * compare the real packed tables against a naive list-based reference and
 * against `rules.slide`:
 *
 *  1. all 65,536 packed rows, slid both ways, vs the naive slide;
 *  2. 10,000 seeded random boards in all four directions: packed apply,
 *     `rules.slide` and the reference must agree on board, score gained and
 *     whether anything moved;
 *  3. a named anchor row ([2,2,2,2] -> [4,4,0,0], gain 8);
 *  4. the spawn rule against the rules text ("a 2 with probability 0.9"),
 *     not against the exported constant (PR #12 review, LOW).
 *
 * The packed tables are module-private, so this test reads the real
 * `baselines.js` source, strips its `import`/`export` keywords and evaluates
 * it in a function scope to reach the exact code the engine uses. No game
 * file is modified; if the internals are renamed the evaluation throws and
 * this test fails loudly.
 *
 * Domain note: two adjacent 32768 tiles merge to 65536 in the value domain,
 * which the 4-bit encoding cannot hold. The packed path refuses that merge
 * (rank 15 is the cap). Those rows are compared against a cap-aware rank
 * reference and counted; reaching two live 32768s in one line needs 2^16 of
 * board mass, far beyond any tier target, so the cap edge is unreachable in
 * tiered play.
 *
 * Every random sample is drawn from `core/rng.js` with a fixed seed, so the
 * runs are deterministic.
 *
 * @module
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { slide, spawnTile, SPAWN_TWO_PROBABILITY } from '../../games/2048/rules.js';
import { rngFromSeed, streamFromSeed } from '../../core/rng.js';

/** @import { Direction } from '../../games/2048/rules.js' */

/**
 * @typedef {object} PackedTables
 * @property {Uint16Array} resLeft Slid row (toward the low nibble) per row.
 * @property {Uint8Array} movedLeft 1 when the left slide changed the row.
 * @property {Uint16Array} resRight Slid row (toward the high nibble) per row.
 * @property {Uint8Array} movedRight 1 when the right slide changed the row.
 * @property {Float64Array} heur Per-row heuristic.
 */

/**
 * @typedef {object} PackedInternals
 * @property {(ranks: number[]) => number} packSlideLeft
 * @property {(rows: number[], dir: Direction) => number[] | null} moveRows
 * @property {(board: number[][]) => number[] | null} encodeBoard
 * @property {(rows: number[]) => number[]} transpose
 * @property {() => PackedTables} getTables
 */

/**
 * Evaluate the real baselines.js source (imports and export keywords
 * stripped) and hand back its private packed-slide internals.
 *
 * @returns {PackedInternals}
 */
function loadInternals() {
  const file = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../games/2048/baselines.js'
  );
  const source = readFileSync(file, 'utf8');
  const body = source.replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  const internals = /** @type {PackedInternals} */ (
    /** @type {unknown} */ (
      new Function(
        `${body}\n;return { packSlideLeft, moveRows, encodeBoard, transpose, getTables };`
      )()
    )
  );
  return internals;
}

/**
 * Naive list slide toward index 0, written for clarity: drop zeros, merge
 * equal neighbours once (a merged tile cannot merge again this move), pad
 * with zeros. A merge scores the new tile's value.
 *
 * @param {number[]} values The line, nearest-wall first.
 * @returns {{ out: number[], gained: number, moved: boolean }}
 */
function slideList(values) {
  const tiles = values.filter((v) => v !== 0);
  /** @type {number[]} */
  const out = [];
  let gained = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
      out.push(tiles[i] * 2);
      gained += tiles[i] * 2;
      i++; // one merge per tile per move
    } else {
      out.push(tiles[i]);
    }
  }
  while (out.length < values.length) out.push(0);
  const moved = out.some((v, i) => v !== values[i]);
  return { out, gained, moved };
}

/**
 * Rank-domain slide toward index 0 with the encoding cap: merging two
 * rank-15 tiles would need a fifth bit, so the packed domain refuses it
 * (the value domain merges them to 65536). Only used on cap-edge rows.
 *
 * @param {number[]} ranks
 * @returns {number[]}
 */
function capSlideRanks(ranks) {
  const tiles = ranks.filter((r) => r !== 0);
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < tiles.length; i++) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1] && tiles[i] < 15) {
      out.push(tiles[i] + 1);
      i++;
    } else {
      out.push(tiles[i]);
    }
  }
  while (out.length < 4) out.push(0);
  return out;
}

/**
 * Cells of one movement line, nearest the wall first.
 *
 * @param {Direction} dir
 * @param {number} line Row index for horizontal moves, column index for vertical.
 * @returns {Array<[number, number]>} [row, column] pairs, wall first.
 */
function lineCells(dir, line) {
  switch (dir) {
    case 'up':
      return [
        [0, line],
        [1, line],
        [2, line],
        [3, line],
      ];
    case 'down':
      return [
        [3, line],
        [2, line],
        [1, line],
        [0, line],
      ];
    case 'left':
      return [
        [line, 0],
        [line, 1],
        [line, 2],
        [line, 3],
      ];
    case 'right':
      return [
        [line, 3],
        [line, 2],
        [line, 1],
        [line, 0],
      ];
  }
}

/**
 * Naive full-board slide in the tile-value domain.
 *
 * @param {number[][]} board 4x4 tile values.
 * @param {Direction} dir
 * @returns {{ board: number[][], gained: number, moved: boolean }}
 */
function naiveSlide(board, dir) {
  const out = board.map((row) => row.slice());
  let gained = 0;
  let moved = false;
  for (let line = 0; line < 4; line++) {
    const cells = lineCells(dir, line);
    const values = cells.map(([r, c]) => board[r][c]);
    const res = slideList(values);
    if (res.moved) moved = true;
    gained += res.gained;
    for (let i = 0; i < 4; i++) {
      out[cells[i][0]][cells[i][1]] = res.out[i];
    }
  }
  return { board: out, gained, moved };
}

/**
 * Decode one packed 4-bit rank row into tile values.
 *
 * @param {number} row
 * @returns {number[]}
 */
function decodeRow(row) {
  return [0, 1, 2, 3].map((i) => {
    const rank = (row >> (4 * i)) & 15;
    return rank === 0 ? 0 : 2 ** rank;
  });
}

test('all 65,536 packed rows slide identically to the naive reference both ways', () => {
  const { getTables } = loadInternals();
  const tables = getTables();
  let capEdgeLeft = 0;
  let capEdgeRight = 0;
  for (let row = 0; row < 65536; row++) {
    const ranks = [row & 15, (row >> 4) & 15, (row >> 8) & 15, (row >> 12) & 15];
    const values = ranks.map((rank) => (rank === 0 ? 0 : 2 ** rank));
    for (const dir of /** @type {const} */ (['left', 'right'])) {
      const packed = dir === 'left' ? tables.resLeft[row] : tables.resRight[row];
      const movedFlag = dir === 'left' ? tables.movedLeft[row] : tables.movedRight[row];
      const refValues = dir === 'left' ? values : values.slice().reverse();
      const ref = slideList(refValues);
      const outValues = dir === 'left' ? ref.out : ref.out.slice().reverse();
      const fits = outValues.every((v) => v <= 32768);
      if (fits) {
        // Value-domain reference and packed table must agree exactly.
        const outRanks = outValues.map((v) => (v === 0 ? 0 : Math.round(Math.log2(v))));
        const expected =
          outRanks[0] | (outRanks[1] << 4) | (outRanks[2] << 8) | (outRanks[3] << 12);
        assert.equal(packed, expected, `row ${row} slid ${dir}`);
        assert.equal(movedFlag, ref.moved ? 1 : 0, `moved flag for row ${row}, ${dir}`);
      } else {
        // Cap edge: two adjacent 32768 tiles. Compare against the documented
        // cap-aware behaviour instead (see module comment).
        if (dir === 'left') capEdgeLeft++;
        else capEdgeRight++;
        const slidRanks = capSlideRanks(dir === 'left' ? ranks : ranks.slice().reverse());
        // capSlideRanks returns wall-first order; pack left-to-right.
        const refRanks = dir === 'left' ? slidRanks : slidRanks.slice().reverse();
        const expected =
          refRanks[0] | (refRanks[1] << 4) | (refRanks[2] << 8) | (refRanks[3] << 12);
        assert.equal(packed, expected, `cap-edge row ${row} slid ${dir}`);
        assert.equal(movedFlag, expected !== row ? 1 : 0, `cap-edge moved flag row ${row}, ${dir}`);
      }
    }
  }
  // Cap-edge rows: the compacted non-zero ranks contain two adjacent 15s.
  // 736 rows have a line-adjacent pair (3 pair positions, inclusion-
  // exclusion); 31 more have two 15s separated only by zeros, which
  // compaction makes adjacent (exactly-two-15 rows: 1411 total, 644 of them
  // stay separated, 1411 - 644 = 767). Same count both ways by symmetry.
  assert.equal(capEdgeLeft, 767, 'cap-edge rows sliding left');
  assert.equal(capEdgeRight, 767, 'cap-edge rows sliding right');
});

test('named anchor: [2,2,2,2] packs to 0x1111 and slides left to 0x0022', () => {
  const { getTables } = loadInternals();
  const tables = getTables();
  assert.equal(tables.resLeft[0x1111], 0x0022, '[2,2,2,2] left must be [4,4,0,0]');
  assert.equal(tables.movedLeft[0x1111], 1);
  // And the value-domain rule the table mirrors:
  const res = slide(
    [
      [2, 2, 2, 2],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ],
    'left'
  );
  assert.deepEqual(res.board, [
    [4, 4, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  assert.equal(res.gained, 8);
  assert.equal(res.moved, true);
});

test('10,000 seeded random boards: rules.slide, packed apply and reference agree in all four directions', () => {
  const { encodeBoard, moveRows } = loadInternals();
  const rng = streamFromSeed('burst10-2048-board-reference');

  /** Tile ranks 1..14 with a merge-rich low-rank bias (rank 14 max keeps every slide inside the encoding). */
  const randomRank = () => {
    const u = rng.nextFloat();
    if (u < 0.4) return 1;
    if (u < 0.65) return 2;
    if (u < 0.82) return 3;
    if (u < 0.92) return 4;
    if (u < 0.97) return 5;
    if (u < 0.995) return 6;
    return 7 + rng.nextInt(0, 7);
  };

  for (let trial = 0; trial < 10000; trial++) {
    const board = Array.from({ length: 4 }, () =>
      Array.from({ length: 4 }, () => {
        const u = rng.nextFloat();
        return u < 0.4 ? 0 : 2 ** randomRank();
      })
    );
    for (const dir of /** @type {Direction[]} */ (['up', 'right', 'down', 'left'])) {
      const ref = naiveSlide(board, dir);
      const rulesResult = slide(board, dir);
      assert.deepEqual(rulesResult.board, ref.board, `rules.slide board, trial ${trial}, ${dir}`);
      assert.equal(rulesResult.gained, ref.gained, `rules.slide gained, trial ${trial}, ${dir}`);
      assert.equal(rulesResult.moved, ref.moved, `rules.slide moved, trial ${trial}, ${dir}`);
      // The packed path does not track score gain (the engine only reads the
      // slid board), so board and moved flag are what it must reproduce.
      const rows = encodeBoard(board);
      assert.ok(rows !== null, `encoding trial ${trial}`);
      const movedRows = moveRows(rows, dir);
      const packedBoard = movedRows === null ? board : movedRows.map(decodeRow);
      assert.deepEqual(packedBoard, ref.board, `packed board, trial ${trial}, ${dir}`);
      assert.equal(movedRows !== null, ref.moved, `packed moved, trial ${trial}, ${dir}`);
    }
  }
});

test('spawn rule matches the rules text: a 2 with probability 0.9', () => {
  // Pin the exported constant to the rules-text literal. The existing suite
  // compared the distribution against this same constant, which made the test
  // self-referential (PR #12 review, LOW); here the literal is the reference.
  assert.equal(SPAWN_TWO_PROBABILITY, 0.9);

  let rng = rngFromSeed('burst10-2048-spawn');
  const template = [
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 0, 2],
    [4, 0, 2, 0],
  ];
  const runs = 100000;
  let twos = 0;
  for (let i = 0; i < runs; i++) {
    const res = spawnTile(template, rng);
    rng = res.rng;
    /** @type {[number, number] | null} */
    let placedAt = null;
    let placedValue = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (res.board[r][c] !== template[r][c]) {
          assert.ok(placedAt === null, 'spawn changes exactly one cell');
          placedAt = [r, c];
          placedValue = res.board[r][c];
        }
      }
    }
    assert.ok(placedAt !== null, 'spawn placed a tile');
    assert.equal(template[placedAt[0]][placedAt[1]], 0, 'spawn landed on an empty cell');
    assert.ok(placedValue === 2 || placedValue === 4, 'spawned tile is a 2 or a 4');
    if (placedValue === 2) twos++;
  }
  const pTwo = twos / runs;
  // Binomial sd at N=100k is ~0.00095; the tolerance is several sigma wide.
  assert.ok(
    Math.abs(pTwo - 0.9) <= 0.005,
    `spawn-2 frequency ${pTwo} must match the rules-text 0.9`
  );
});
