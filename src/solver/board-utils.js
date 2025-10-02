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

function detectExponentBoard(flatTiles) {
  return flatTiles.some((value) => value > 0 && !isPowerOfTwo(value));
}

function tileToExponent(value, treatAsExponent) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const clamped = Math.min(Math.floor(value), 1 << MAX_EXPONENT);
  if (treatAsExponent) {
    return Math.min(clamped, MAX_EXPONENT);
  }

  let exponent = 0;
  let current = clamped;
  while (current > 1 && (current & 1) === 0 && exponent < MAX_EXPONENT) {
    current >>= 1;
    exponent += 1;
  }

  if (current !== 1) {
    const approx = Math.round(Math.log2(clamped));
    return Math.max(0, Math.min(approx, MAX_EXPONENT));
  }

  return exponent;
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

  toExponentArray(board) {
    const normalized = this.ensureBoard(board);
    const flatTiles = flattenBoard(normalized);
    const treatAsExponent = detectExponentBoard(flatTiles);

    return flatTiles.map((value) => tileToExponent(value, treatAsExponent));
  },

  toBitboard(board) {
    const exponents = this.toExponentArray(board);
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

