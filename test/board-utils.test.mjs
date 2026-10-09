/**
 * BoardEncoder + pure board utils (src/solver/board-utils.js).
 * Zero-dependency node:test suite. Run:
 *   node --test test/board-utils.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardEncoder } from "../src/solver/board-utils.js";
import { mulberry32 } from "./helpers/reference-2048.mjs";

/** 4x4 values board from a row-major flat array (16 entries). */
const fromFlat = (...flat) => [
  flat.slice(0, 4),
  flat.slice(4, 8),
  flat.slice(8, 12),
  flat.slice(12, 16),
];

const EMPTY = fromFlat(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

test("toBitboard: empty board encodes to 0n", () => {
  assert.equal(BoardEncoder.toBitboard(EMPTY), 0n);
  assert.deepEqual(BoardEncoder.fromBitboard(0n), EMPTY);
});

test("toBitboard: single 2 at each cell -> exponent nibble at its row-major index", () => {
  for (let i = 0; i < 16; i++) {
    const flat = Array(16).fill(0);
    flat[i] = 2; // exponent 1
    assert.equal(BoardEncoder.toBitboard(fromFlat(...flat)), 1n << BigInt(4 * i), `cell ${i}`);
  }
});

test("toBitboard: full board of 2s packs one nibble per cell", () => {
  const full = fromFlat(2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2);
  assert.equal(BoardEncoder.toBitboard(full), 0x1111111111111111n);
});

test("toBitboard: 2048+ tiles encode as their log2 exponent nibble", () => {
  // 2048 = 2^11 -> nibble 0xB; 16384 = 2^14 -> 0xE; 32768 = 2^15 -> 0xF.
  assert.equal(
    BoardEncoder.toBitboard(fromFlat(2048, 16384, 32768, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)),
    0xfebn,
  );
});

test("toBitboard is deterministic: same input twice, identical bitboard", () => {
  const board = fromFlat(2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 0);
  assert.equal(BoardEncoder.toBitboard(board), BoardEncoder.toBitboard(board));
  assert.deepEqual(BoardEncoder.toExponentArray(board), BoardEncoder.toExponentArray(board));
});

test("fromBitboard(toBitboard(board)) round-trips values boards (fuzz, tiles <= 2^15)", () => {
  const rng = mulberry32(0xbeef);
  const tiles = [0, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
  for (let iter = 0; iter < 500; iter++) {
    const flat = Array.from({ length: 16 }, () => tiles[Math.floor(rng() * tiles.length)]);
    const board = fromFlat(...flat);
    assert.deepEqual(BoardEncoder.fromBitboard(BoardEncoder.toBitboard(board)), board, `iter ${iter}`);
  }
});

test("fromBitboard: exponent nibbles decode to tile values (pinned known answer)", () => {
  // nibble0 = 1 (tile 2), nibble1 = 2 (tile 4)
  assert.deepEqual(BoardEncoder.fromBitboard(0x21n), fromFlat(2, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
  assert.deepEqual(BoardEncoder.fromBitboard(0n), EMPTY);
});

test("fromBitboard: non-bigint input throws (pinned)", () => {
  assert.throws(() => BoardEncoder.fromBitboard(0), /expected bigint/);
  assert.throws(() => BoardEncoder.fromBitboard("0"), /expected bigint/);
});

test("CURRENT behavior: 65536 (2^16) truncates to exponent 15 and decodes as 32768 (lossy nibble cap)", () => {
  // tileToExponent clamps at MAX_EXPONENT = 15; the 4-bit nibble cannot hold
  // 2^16. Pinned so a future encoder contract change shows up as a diff here.
  const board = fromFlat(65536, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  assert.deepEqual(
    BoardEncoder.fromBitboard(BoardEncoder.toBitboard(board)),
    fromFlat(32768, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  );
});

test("toExponentArray: values boards map to log2 exponents, row-major flat (16 entries)", () => {
  const board = fromFlat(0, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 0, 0);
  assert.deepEqual(BoardEncoder.toExponentArray(board), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 0, 0]);
});

test("CURRENT behavior: content-based guessing misreads exponent-looking values boards (the FIX-1 ambiguity)", () => {
  // detectExponentBoard() is content-based: a board of tiles 2 and 1 (both
  // powers of two) takes the values path, and tile 1 encodes as exponent 0 —
  // indistinguishable from an EMPTY cell. Pinned as-is; see the FIX-1 skip
  // below for the contract that replaces it.
  assert.deepEqual(
    BoardEncoder.toExponentArray(fromFlat(2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)),
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
});

// TODO(FIX-1): after the encoder contract changes to values-only, un-skip and assert toExponentArray treats input as tile VALUES with no content-based guessing; impossible values (not powers of 2) clamp via round(log2) with min 1.
test.skip("toExponentArray (post FIX-1): values-only contract, no content-based guessing", () => {
  // No guessing: tile 2 keeps exponent 1 even when an impossible tile (3)
  // sits elsewhere. TODAY the 3 flips the whole board into "exponent mode"
  // and tile 2 comes out as exponent 2 (value 4) — the misinterpretation.
  assert.deepEqual(
    BoardEncoder.toExponentArray(fromFlat(2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)),
    [1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
  // Impossible values clamp via round(log2): log2(3)~1.58 -> 2, log2(6)~2.58 -> 3.
  assert.deepEqual(
    BoardEncoder.toExponentArray(fromFlat(3, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)),
    [2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
});

test("uniqueDirections: dedupes while preserving first-occurrence order", () => {
  assert.deepEqual(BoardEncoder.uniqueDirections([3, 1, 3, 2, 1]), [3, 1, 2, 0]);
});

test("uniqueDirections: drops out-of-range directions", () => {
  assert.deepEqual(BoardEncoder.uniqueDirections([9, -1, 2]), [2, 0, 1, 3]);
});

test("uniqueDirections: ALWAYS returns all four directions (padding pin)", () => {
  // Current behavior pins the padding family shared with the naive engine's
  // game-over bug — see test/naive-solver.test.mjs TODO(FIX-2).
  assert.deepEqual(BoardEncoder.uniqueDirections([]), [0, 1, 2, 3]);
  assert.deepEqual(BoardEncoder.uniqueDirections([1]), [1, 0, 2, 3]);
});

test("uniqueDirections: non-numeric entries are dropped (pinned)", () => {
  assert.deepEqual(BoardEncoder.uniqueDirections(["2", null, 1]), [1, 0, 2, 3]);
});

test("fromExponentArray: 16 exponents -> 4x4 value grid; wrong lengths throw", () => {
  assert.deepEqual(
    BoardEncoder.fromExponentArray([0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    fromFlat(0, 2, 4, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  );
  assert.throws(() => BoardEncoder.fromExponentArray(new Array(15).fill(0)), /16-element/);
  assert.throws(() => BoardEncoder.fromExponentArray(new Array(17).fill(0)), /16-element/);
  assert.throws(() => BoardEncoder.fromExponentArray(null), /16-element/);
});

test("ensureBoard: shape validation, non-finite coercion to 0, no input mutation (pinned)", () => {
  assert.throws(() => BoardEncoder.ensureBoard(undefined), /expected a 4x4 matrix/);
  assert.throws(() => BoardEncoder.ensureBoard([[2, 2], [2, 2]]), /expected a 4x4 matrix/);
  assert.throws(() => BoardEncoder.ensureBoard([[1, 2, 3], [4, 5, 6], [7, 8, 9], [0, 0, 0]]), /expected a 4x4 matrix/);

  const input = [NaN, undefined, null, "2", 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0];
  const board = fromFlat(...input);
  assert.deepEqual(
    BoardEncoder.ensureBoard(board),
    fromFlat(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0),
  );
  // The original board object is untouched (fresh arrays, values preserved).
  assert.ok(Number.isNaN(board[0][0]));
  assert.equal(board[0][3], "2");
});
