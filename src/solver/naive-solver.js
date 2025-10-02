/**
 * @fileoverview Minimal JS fallback solver used when WASM is unavailable.
 */

import { Direction } from "../adapters/index.js";
import { BoardEncoder } from "./board-utils.js";

const ALL_DIRECTIONS = [Direction.UP, Direction.RIGHT, Direction.DOWN, Direction.LEFT];

function cloneBoard(board) {
  return board.map((row) => [...row]);
}

function rotateBoardClockwise(board) {
  const rotated = Array.from({ length: 4 }, () => Array(4).fill(0));
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      rotated[c][3 - r] = board[r][c];
    }
  }
  return rotated;
}

function rotateBoardCounterClockwise(board) {
  const rotated = Array.from({ length: 4 }, () => Array(4).fill(0));
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      rotated[3 - c][r] = board[r][c];
    }
  }
  return rotated;
}

function mergeLine(values) {
  const filtered = values.filter((value) => value !== 0);
  const merged = [];
  let skip = false;

  for (let i = 0; i < filtered.length; i++) {
    if (skip) {
      skip = false;
      continue;
    }

    const current = filtered[i];
    const next = filtered[i + 1];
    if (next && current === next) {
      merged.push(current * 2);
      skip = true;
    } else {
      merged.push(current);
    }
  }

  while (merged.length < 4) {
    merged.push(0);
  }

  return merged;
}

function moveLeft(board) {
  const result = cloneBoard(board);
  for (let r = 0; r < 4; r++) {
    result[r] = mergeLine(result[r]);
  }
  return result;
}

function moveRight(board) {
  const result = cloneBoard(board);
  for (let r = 0; r < 4; r++) {
    const reversed = [...result[r]].reverse();
    result[r] = mergeLine(reversed).reverse();
  }
  return result;
}

function moveUp(board) {
  const rotated = rotateBoardCounterClockwise(board);
  const moved = moveLeft(rotated);
  return rotateBoardClockwise(moved);
}

function moveDown(board) {
  const rotated = rotateBoardClockwise(board);
  const moved = moveLeft(rotated);
  return rotateBoardCounterClockwise(moved);
}

const MOVE_SIMULATORS = {
  [Direction.LEFT]: moveLeft,
  [Direction.RIGHT]: moveRight,
  [Direction.UP]: moveUp,
  [Direction.DOWN]: moveDown,
};

function boardsEqual(a, b) {
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (a[r][c] !== b[r][c]) {
        return false;
      }
    }
  }
  return true;
}

function findMaxTilePosition(board) {
  let best = { value: 0, row: 0, col: 0 };
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const value = board[r][c];
      if (value > best.value) {
        best = { value, row: r, col: c };
      }
    }
  }
  return best;
}

function directionBiasForPosition(pos) {
  if (pos.row <= 1 && pos.col <= 1) {
    return [Direction.UP, Direction.LEFT, Direction.RIGHT, Direction.DOWN];
  }
  if (pos.row <= 1 && pos.col >= 2) {
    return [Direction.UP, Direction.RIGHT, Direction.LEFT, Direction.DOWN];
  }
  if (pos.row >= 2 && pos.col <= 1) {
    return [Direction.DOWN, Direction.LEFT, Direction.RIGHT, Direction.UP];
  }
  return [Direction.DOWN, Direction.RIGHT, Direction.LEFT, Direction.UP];
}

function wouldChangeBoard(board, direction) {
  const simulator = MOVE_SIMULATORS[direction];
  if (!simulator) {
    return false;
  }
  const next = simulator(board);
  return !boardsEqual(board, next);
}

export class NaiveSolverEngine {
  constructor(config = {}) {
    this.status = "ready";
    this.strategy = {
      bias: config.bias ?? Direction.DOWN,
    };
  }

  async initialize() {
    this.status = "ready";
  }

  async ensureReady() {
    return;
  }

  async getMoveOrder(board) {
    const normalized = BoardEncoder.ensureBoard(board);
    const maxPos = findMaxTilePosition(normalized);
    const priorities = directionBiasForPosition(maxPos);

    const ordered = [];
    for (const direction of priorities) {
      if (wouldChangeBoard(normalized, direction)) {
        ordered.push(direction);
      }
    }

    if (ordered.length === 0) {
      return [...ALL_DIRECTIONS];
    }

    return BoardEncoder.uniqueDirections(ordered);
  }

  async setStrategy(config = {}) {
    if (typeof config.bias === "number") {
      this.strategy.bias = config.bias;
    }
  }

  getStatus() {
    return {
      type: "naive",
      ready: this.status === "ready",
      strategy: { ...this.strategy },
    };
  }
}

