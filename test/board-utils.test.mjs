/**
 * BoardEncoder + pure board utils (src/solver/board-utils.js).
 * Zero-dependency node:test suite. Run:
 *   node --test test/board-utils.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardEncoder, BoardEncodingError } from "../src/solver/board-utils.js";
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
  assert.equal(BoardEncoder.toBitboard(EMPTY, { encoding: "values" }), 0n);
  assert.deepEqual(BoardEncoder.fromBitboard(0n), EMPTY);
});

test("toBitboard: single 2 at each cell -> exponent nibble at its row-major index", () => {
  for (let i = 0; i < 16; i++) {
    const flat = Array(16).fill(0);
    flat[i] = 2; // exponent 1
    assert.equal(BoardEncoder.toBitboard(fromFlat(...flat), { encoding: "values" }), 1n << BigInt(4 * i), `cell ${i}`);
  }
});

test("toBitboard: full board of 2s packs one nibble per cell", () => {
  const full = fromFlat(2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2);
  assert.equal(BoardEncoder.toBitboard(full, { encoding: "values" }), 0x1111111111111111n);
});

test("toBitboard: 2048+ tiles encode as their log2 exponent nibble", () => {
  // 2048 = 2^11 -> nibble 0xB; 16384 = 2^14 -> 0xE; 32768 = 2^15 -> 0xF.
  assert.equal(
    BoardEncoder.toBitboard(fromFlat(2048, 16384, 32768, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), { encoding: "values" }),
    0xfebn,
  );
});

test("toBitboard is deterministic: same input twice, identical bitboard", () => {
  const board = fromFlat(2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 0);
  assert.equal(BoardEncoder.toBitboard(board, { encoding: "values" }), BoardEncoder.toBitboard(board, { encoding: "values" }));
  assert.deepEqual(BoardEncoder.toExponentArray(board, { encoding: "values" }), BoardEncoder.toExponentArray(board, { encoding: "values" }));
});

test("fromBitboard(toBitboard(board)) round-trips values boards (fuzz, tiles <= 2^15)", () => {
  const rng = mulberry32(0xbeef);
  const tiles = [0, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
  for (let iter = 0; iter < 500; iter++) {
    const flat = Array.from({ length: 16 }, () => tiles[Math.floor(rng() * tiles.length)]);
    const board = fromFlat(...flat);
    assert.deepEqual(BoardEncoder.fromBitboard(BoardEncoder.toBitboard(board, { encoding: "values" })), board, `iter ${iter}`);
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

test("values encoding: 65536 (2^16) exceeds the 4-bit nibble cap and fails with INVALID_VALUE (pinned)", () => {
  // The 4-bit nibble cannot hold 2^16. The old encoder silently truncated
  // (65536 decoded back as 32768); the validated contract rejects it.
  const board = fromFlat(65536, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  assert.throws(
    () => BoardEncoder.toBitboard(board, { encoding: "values" }),
    (error) => error instanceof BoardEncodingError && error.code === "INVALID_VALUE",
  );
});

test("toExponentArray: values boards map to log2 exponents, row-major flat (16 entries)", () => {
  const board = fromFlat(0, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 0, 0);
  assert.deepEqual(BoardEncoder.toExponentArray(board, { encoding: "values" }), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 0, 0]);
});

// Superseded: the "CURRENT behavior: content-based guessing misreads" pin
// (board [2,1,...] silently encoded as [1,0,0...]) is gone — that guessing
// path was removed. The FIX-1 tests above pin its replacement: AMBIGUOUS_VALUE.
// FIX-1 regression, enabled: the encoding is an explicit validated contract.
// The old content-based guessing (detectExponentBoard) flipped the WHOLE board
// into "exponent mode" when one tile looked impossible — tile 2 came out as
// exponent 2 (value 4). There is no guessing path anymore: callers declare the
// encoding, and ambiguous or impossible cells fail with a specific
// BoardEncodingError instead of being reinterpreted.
test("toExponentArray (FIX-1): values encoding never guesses — impossible cells fail with a specific error", () => {
  // An impossible tile (3) no longer flips the board into exponent mode —
  // it fails, naming the cell and the value, with code INVALID_VALUE.
  assert.throws(
    () => BoardEncoder.toExponentArray(fromFlat(2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), { encoding: "values" }),
    (error) => error instanceof BoardEncodingError && error.code === "INVALID_VALUE" && /flat index 1/.test(error.message),
  );
  assert.throws(
    () => BoardEncoder.toExponentArray(fromFlat(3, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), { encoding: "values" }),
    (error) => error instanceof BoardEncodingError && error.code === "INVALID_VALUE",
  );
  // The ambiguity case that motivated the contract: tile 1 encodes to
  // exponent 0, identical to empty — rejected as AMBIGUOUS_VALUE, not read
  // as an empty cell and not guessed away.
  assert.throws(
    () => BoardEncoder.toExponentArray(fromFlat(2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), { encoding: "values" }),
    (error) => error instanceof BoardEncodingError && error.code === "AMBIGUOUS_VALUE",
  );
  // Non-integers, negatives, and nibble-cap overflow are invalid too.
  for (const bad of [2.5, -4, 65536, NaN, undefined, "2", null]) {
    assert.throws(
      () => BoardEncoder.toExponentArray(fromFlat(bad, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), { encoding: "values" }),
      (error) => error instanceof BoardEncodingError && error.code === "INVALID_VALUE",
      `cell value ${String(bad)} must fail INVALID_VALUE`,
    );
  }
});

test("toExponentArray (FIX-1): exponents encoding validates nibbles, encodes them verbatim", () => {
  const board = fromFlat(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);
  assert.deepEqual(BoardEncoder.toExponentArray(board, { encoding: "exponents" }), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  // Tile values (powers of two) are INVALID under the exponents contract
  // when they exceed the nibble range: 16 at flat index 0 is not a nibble.
  assert.throws(
    () => BoardEncoder.toExponentArray(fromFlat(16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), { encoding: "exponents" }),
    (error) => error instanceof BoardEncodingError && error.code === "INVALID_EXPONENT",
  );
  for (const bad of [16, -1, 2.5, NaN, "2", undefined]) {
    assert.throws(
      () => BoardEncoder.toExponentArray(fromFlat(bad, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), { encoding: "exponents" }),
      (error) => error instanceof BoardEncodingError && error.code === "INVALID_EXPONENT",
      `exponent ${String(bad)} must fail INVALID_EXPONENT`,
    );
  }
});

test("toExponentArray (FIX-1): encoding parameter is required and unknown encodings fail — no guessing, no default", () => {
  const board = fromFlat(2, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  // A board whose contents COULD be either encoding must not silently pick
  // one: omitting the encoding is itself an error (ENCODING_REQUIRED).
  assert.throws(
    () => BoardEncoder.toExponentArray(board),
    (error) => error instanceof BoardEncodingError && error.code === "ENCODING_REQUIRED",
  );
  assert.throws(
    () => BoardEncoder.toExponentArray(board, {}),
    (error) => error instanceof BoardEncodingError && error.code === "ENCODING_REQUIRED",
  );
  assert.throws(
    () => BoardEncoder.toExponentArray(board, { encoding: "tile-values-please" }),
    (error) => error instanceof BoardEncodingError && error.code === "ENCODING_UNKNOWN",
  );
  assert.throws(
    () => BoardEncoder.toBitboard(board),
    (error) => error instanceof BoardEncodingError && error.code === "ENCODING_REQUIRED",
  );
  // Malformed shape is INVALID_SHAPE, reported before any cell validation.
  assert.throws(
    () => BoardEncoder.toExponentArray([[2, 2], [2, 2]], { encoding: "values" }),
    (error) => error instanceof BoardEncodingError && error.code === "INVALID_SHAPE",
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
