/**
 * @fileoverview Board conversion helpers for WASM solver integration.
 */

import { BoardUtils } from "../adapters/index.js";

const BOARD_SIZE = 4;
const MAX_EXPONENT = 15;
const ALL_DIRECTIONS = [0, 1, 2, 3];

function flattenBoard(board) {
  return board.reduce((acc, row) => acc.concat(row), []);
}

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

/**
 * Explicit, validated board-encoding contract (FIX-1).
 *
 * A board's CONTENTS cannot identify its encoding: the tile-value board
 * [[2, 4]] and the exponent board [[2, 4]] are byte-identical but mean
 * different games. Content-based guessing (the removed detectExponentBoard
 * path) therefore mislabeled whole boards. Every encode call now declares
 * its encoding and every cell is validated against it; ambiguous or invalid
 * input fails with a BoardEncodingError instead of being reinterpreted.
 */
export class BoardEncodingError extends Error {
  /**
   * @param {string} code machine-readable failure code:
   *   ENCODING_REQUIRED | ENCODING_UNKNOWN | INVALID_SHAPE |
   *   INVALID_VALUE | AMBIGUOUS_VALUE | INVALID_EXPONENT
   * @param {string} message human-readable detail (names the offending cell)
   */
  constructor(code, message) {
    super(message);
    this.name = "BoardEncodingError";
    this.code = code;
  }
}

const ENCODINGS = ["values", "exponents"];

function resolveEncoding(options) {
  if (!options || options.encoding === undefined) {
    throw new BoardEncodingError(
      "ENCODING_REQUIRED",
      'BoardEncoder: explicit encoding required — pass { encoding: "values" } (tile values like 2, 4, 1024) or { encoding: "exponents" } (nibbles 0..15). Content-based guessing was removed (FIX-1): a board\'s contents cannot identify its encoding.',
    );
  }
  if (!ENCODINGS.includes(options.encoding)) {
    throw new BoardEncodingError(
      "ENCODING_UNKNOWN",
      `BoardEncoder: unknown encoding ${JSON.stringify(options.encoding)} — expected "values" or "exponents"`,
    );
  }
  return options.encoding;
}

function cellLabel(index) {
  return `row ${Math.floor(index / 4)}, col ${index % 4} (flat index ${index})`;
}

/** Validate + encode one cell under the "values" (tile values) contract. */
function encodeValueCell(value, index) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new BoardEncodingError(
      "INVALID_VALUE",
      `BoardEncoder: values encoding requires an integer tile value at ${cellLabel(index)}, got ${JSON.stringify(value)}`,
    );
  }
  if (value === 0) {
    return 0;
  }
  if (value === 1) {
    throw new BoardEncodingError(
      "AMBIGUOUS_VALUE",
      `BoardEncoder: value 1 at ${cellLabel(index)} is ambiguous under values encoding — it encodes to exponent 0, which decodes as an EMPTY cell. Tile values start at 2; pass { encoding: "exponents" } if 1 means the exponent nibble.`,
    );
  }
  if (!isPowerOfTwo(value) || value > 1 << MAX_EXPONENT) {
    throw new BoardEncodingError(
      "INVALID_VALUE",
      `BoardEncoder: value ${value} at ${cellLabel(index)} is not a valid tile value under values encoding — expected 0 or a power of two in [2, ${1 << MAX_EXPONENT}] (4-bit nibble cap)`,
    );
  }
  return Math.round(Math.log2(value));
}

/** Validate + encode one cell under the "exponents" (nibble) contract. */
function encodeExponentCell(value, index) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new BoardEncodingError(
      "INVALID_EXPONENT",
      `BoardEncoder: exponents encoding requires an integer nibble at ${cellLabel(index)}, got ${JSON.stringify(value)}`,
    );
  }
  if (value < 0 || value > MAX_EXPONENT) {
    throw new BoardEncodingError(
      "INVALID_EXPONENT",
      `BoardEncoder: exponent ${value} at ${cellLabel(index)} is out of range under exponents encoding — expected an integer in [0, ${MAX_EXPONENT}]`,
    );
  }
  return value;
}

function exponentToValue(exponent) {
  if (exponent <= 0) {
    return 0;
  }
  if (exponent >= MAX_EXPONENT) {
    return 1 << MAX_EXPONENT;
  }
  return 1 << exponent;
}

export const BoardEncoder = {
  ensureBoard(board) {
    if (!BoardUtils.isValidBoard(board)) {
      throw new Error("BoardEncoder: expected a 4x4 matrix");
    }
    return board.map((row) => row.map((value) => (Number.isFinite(value) ? value : 0)));
  },

  /**
   * Encode a 4x4 board to a row-major array of 4-bit exponents.
   *
   * FIX-1 contract: the encoding is explicit and validated. `options.encoding`
   * is required — "values" (board holds tile values, validated: integer 0 or
   * power of two in [2, 2^15]; value 1 is rejected as ambiguous) or
   * "exponents" (board holds nibbles, validated: integer 0..15). Any
   * ambiguous or invalid cell throws BoardEncodingError with a code naming
   * the failure; nothing is guessed from tile contents and nothing clamps
   * silently.
   *
   * @param {number[][]} board 4x4 matrix
   * @param {{encoding: "values"|"exponents"}} options declared encoding
   * @returns {number[]} 16 exponents, row-major
   */
  toExponentArray(board, options) {
    if (!BoardUtils.isValidBoard(board)) {
      throw new BoardEncodingError("INVALID_SHAPE", "BoardEncoder: expected a 4x4 matrix");
    }
    const encoding = resolveEncoding(options);
    const flatTiles = flattenBoard(board);
    const encodeCell = encoding === "values" ? encodeValueCell : encodeExponentCell;

    return flatTiles.map((value, index) => encodeCell(value, index));
  },

  /**
   * Encode a 4x4 board to a bigint bitboard (4 bits per cell, row-major).
   * Same explicit-encoding contract as toExponentArray.
   */
  toBitboard(board, options) {
    const exponents = this.toExponentArray(board, options);
    return exponents.reduce((acc, value, index) => {
      const exponent = BigInt(value & 0xF);
      const shift = BigInt(index * 4);
      return acc | (exponent << shift);
    }, 0n);
  },

  fromExponentArray(exponents) {
    if (!Array.isArray(exponents) || exponents.length !== BOARD_SIZE * BOARD_SIZE) {
      throw new Error("BoardEncoder: expected 16-element exponent array");
    }

    const rows = [];
    for (let r = 0; r < BOARD_SIZE; r++) {
      const row = [];
      for (let c = 0; c < BOARD_SIZE; c++) {
        const index = r * BOARD_SIZE + c;
        row.push(exponentToValue(exponents[index] ?? 0));
      }
      rows.push(row);
    }
    return rows;
  },

  fromBitboard(bitboard) {
    if (typeof bitboard !== "bigint") {
      throw new Error("BoardEncoder: expected bigint bitboard");
    }

    const exponents = new Array(BOARD_SIZE * BOARD_SIZE).fill(0);
    for (let index = 0; index < exponents.length; index++) {
      const shift = BigInt(index * 4);
      const mask = 0xFn << shift;
      const value = Number((bitboard & mask) >> shift) & 0xF;
      exponents[index] = value;
    }
    return this.fromExponentArray(exponents);
  },

  uniqueDirections(list) {
    const seen = new Set();
    const deduped = [];
    for (const direction of list) {
      if (ALL_DIRECTIONS.includes(direction) && !seen.has(direction)) {
        seen.add(direction);
        deduped.push(direction);
      }
    }

    for (const direction of ALL_DIRECTIONS) {
      if (!seen.has(direction)) {
        deduped.push(direction);
      }
    }

    return deduped.slice(0, ALL_DIRECTIONS.length);
  },
};

