/**
 * @fileoverview Adapter for classic 15-puzzle (sliding tile) web games.
 *
 * Modeled on https://lorecioni.github.io/fifteen-puzzle-game/ and compatible
 * pages: a #tiles-container holds .tile elements carrying their value in a
 * `num` attribute (or text) and their cell in CSS coordinates (the site sets
 * inline left/top on every move). Note that this site only writes the
 * `position-X-Y` class at tile creation and never updates it on moves, so
 * board reading is geometry-first: inline style left/top win, and the
 * position class is only a fallback for pages that keep it accurate.
 *
 * Moves follow the tile-movement convention: Direction.LEFT slides the tile
 * to the right of the blank leftward, matching the arrow-key handlers of the
 * target sites. See src/solver/fifteen-solver.js.
 */

import { Adapter, Direction, BoardUtils } from "./adapter.js";
import { FifteenSolverEngine } from "../solver/fifteen-engine.js";

const SIZE = 4;
// Values a genuine 15-puzzle tile can have. Deliberately disjoint from
// anything above 15 so a 2048 board (whose tiles are powers of two, and any
// board with 10+ distinct tiles must include a value >= 16) can never
// satisfy the detection rule below.
const MAX_TILE_VALUE = 15;
// A 15-puzzle in progress holds 15 distinct tiles; requiring 10 distinct
// values keeps animation ghosts and sparse grids from attaching.
const MIN_DISTINCT_TILES = 10;
// Tolerance for clustering pixel coordinates into columns/rows (px).
const CLUSTER_TOLERANCE_PX = 20;

export class FifteenPuzzleAdapter extends Adapter {
  constructor() {
    super();
    this.keyMap = {
      [Direction.UP]: "ArrowUp",
      [Direction.RIGHT]: "ArrowRight",
      [Direction.DOWN]: "ArrowDown",
      [Direction.LEFT]: "ArrowLeft",
    };
    this.keyCodeMap = {
      [Direction.UP]: 38,
      [Direction.RIGHT]: 39,
      [Direction.DOWN]: 40,
      [Direction.LEFT]: 37,
    };
    this._engine = null;
  }

  /**
   * True when the page holds a grid of numbered tiles that looks like a
   * 15-puzzle and not like any 2048 variant: at least 10 distinct values in
   * 1..15, no duplicates, every tile placed in a 4x4 cell.
   */
  canAttach() {
    try {
      const tiles = this._findTiles();
      if (tiles.length < MIN_DISTINCT_TILES) return false;

      const values = new Set();
      for (const tile of tiles) {
        if (tile.value < 1 || tile.value > MAX_TILE_VALUE) return false;
        if (tile.row === null || tile.col === null) return false;
        values.add(tile.value);
      }
      return values.size >= MIN_DISTINCT_TILES;
    } catch (error) {
      console.warn("FifteenPuzzleAdapter: canAttach failed:", error);
      return false;
    }
  }

  /**
   * Current board as a 4x4 matrix, 0 = blank.
   * @returns {number[][]|null}
   */
  readBoard() {
    try {
      const tiles = this._findTiles();
      if (tiles.length === 0) return null;

      const board = BoardUtils.createEmptyBoard();
      let placed = 0;
      for (const tile of tiles) {
        if (tile.row === null || tile.col === null) continue;
        if (tile.row < 0 || tile.row >= SIZE || tile.col < 0 || tile.col >= SIZE) {
          continue;
        }
        // Highest value wins if two tiles overlap in one cell (animations).
        board[tile.row][tile.col] = Math.max(
          board[tile.row][tile.col],
          tile.value
        );
        placed++;
      }
      return placed > 0 ? board : null;
    } catch (error) {
      console.warn("FifteenPuzzleAdapter: Failed to read board:", error);
      return null;
    }
  }

  /**
   * Send a move as arrow keys. Direction semantics: the tile slides in the
   * given direction (ArrowRight moves the tile left of the blank rightward).
   * @param {0|1|2|3} dir
   */
  sendMove(dir) {
    try {
      const key = this.keyMap[dir];
      const keyCode = this.keyCodeMap[dir];
      if (!key) return;

      const target = document.body || document;
      const keydownEvent = new KeyboardEvent("keydown", {
        key,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
      });
      const keyupEvent = new KeyboardEvent("keyup", {
        key,
        keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(keydownEvent);
      target.dispatchEvent(keyupEvent);
    } catch (error) {
      console.warn("FifteenPuzzleAdapter: Failed to send move:", error);
    }
  }

  /**
   * The target site counts moves; that is the natural score here.
   * @returns {number|null}
   */
  getScore() {
    try {
      const selectors = ["#score-point .num", '[id*="score"] .num', ".moves"];
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (!element) continue;
        const parsed = BoardUtils.parseTileValue(element.textContent);
        if (parsed > 0 || element.textContent.trim() === "0") {
          return parsed;
        }
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * The puzzle is over when every tile sits at its goal position.
   * @returns {boolean}
   */
  isGameOver() {
    const board = this.readBoard();
    if (!board) return false;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const expected = r * SIZE + c + 1;
        const value = board[r][c];
        if (r === SIZE - 1 && c === SIZE - 1) {
          if (value !== 0) return false;
        } else if (value !== expected) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * This game needs its own solver (a sliding puzzle cannot be driven by
   * 2048 move heuristics), so the adapter supplies its engine and the
   * runtime prefers it over the shared 2048 solver manager.
   * @returns {FifteenSolverEngine}
   */
  getPreferredSolverEngine() {
    if (!this._engine) {
      this._engine = new FifteenSolverEngine();
    }
    return this._engine;
  }

  /**
   * Collect tiles: {value, row, col} with row/col from CSS geometry when
   * available (inline style left/top, then bounding rects), falling back to
   * position-X-Y classes for pages that keep them accurate.
   * @private
   * @returns {Array<{value:number, row:number|null, col:number|null}>}
   */
  _findTiles() {
    const elements = this._tileElements();

    // First pass: parse values and raw pixel coordinates.
    const raw = [];
    for (const element of elements) {
      const value = this._extractTileValue(element);
      if (value < 1 || value > MAX_TILE_VALUE) continue;
      raw.push({ value, element });
    }
    if (raw.length === 0) return [];

    // Second pass: resolve cells. Geometry first (inline style, then rect).
    const coords = raw.map((tile) => ({
      value: tile.value,
      x: this._readPixel(tile.element, "left"),
      y: this._readPixel(tile.element, "top"),
    }));

    const xs = coords.map((tile) => tile.x);
    const ys = coords.map((tile) => tile.y);
    const geometryUsable =
      xs.every((v) => v !== null) &&
      ys.every((v) => v !== null) &&
      new Set(xs.map((v) => Math.round(v))).size > 1 &&
      new Set(ys.map((v) => Math.round(v))).size > 1;

    if (geometryUsable) {
      const colCoords = clusterCoordinates(xs);
      const rowCoords = clusterCoordinates(ys);
      if (colCoords.length <= SIZE && rowCoords.length <= SIZE) {
        return coords.map((tile) => ({
          value: tile.value,
          row: nearestClusterIndex(rowCoords, tile.y),
          col: nearestClusterIndex(colCoords, tile.x),
        }));
      }
    }

    // Fallback: position-X-Y classes (accurate on pages that update them).
    return raw.map((tile) => ({
      value: tile.value,
      ...this._cellFromPositionClass(tile.element),
    }));
  }

  /**
   * Tile elements for 15-puzzle style pages: .tile nodes carrying a value.
   * The strict .tile selector avoids the tile-container wrappers, and the
   * value guard (1..15) is what keeps real 2048 boards out.
   * @private
   */
  _tileElements() {
    return Array.from(document.querySelectorAll(".tile"));
  }

  _readPixel(element, property) {
    try {
      const inline = element.style && element.style[property];
      if (inline) {
        const parsed = parseFloat(inline);
        if (!Number.isNaN(parsed)) return parsed;
      }
      const rect = element.getBoundingClientRect();
      if (rect && rect.width > 0) {
        return property === "left" ? rect.left : rect.top;
      }
    } catch (error) {
      // Geometry unavailable; caller falls back to position classes.
    }
    return null;
  }

  /**
   * Resolve the 0-based cell from a position-X-Y class token.
   * @private
   */
  _cellFromPositionClass(element) {
    try {
      const classes = Array.from(element.classList);
      const token = classes.find((cls) => /^position-\d+-\d+$/.test(cls));
      if (!token) return { row: null, col: null };
      const match = token.match(/^position-(\d+)-(\d+)$/);
      // The target site numbers cells 1-based as position-row-col.
      const row = parseInt(match[1], 10) - 1;
      const col = parseInt(match[2], 10) - 1;
      return { row, col };
    } catch (error) {
      return { row: null, col: null };
    }
  }

  /**
   * Tile value: `num` attribute (target site), then data-value, then text.
   * @private
   */
  _extractTileValue(element) {
    try {
      const numAttr = element.getAttribute && element.getAttribute("num");
      if (numAttr) {
        const parsed = BoardUtils.parseTileValue(numAttr);
        if (parsed > 0) return parsed;
      }
      if (element.dataset && element.dataset.value) {
        const parsed = BoardUtils.parseTileValue(element.dataset.value);
        if (parsed > 0) return parsed;
      }
      return BoardUtils.parseTileValue(element.textContent);
    } catch (error) {
      return 0;
    }
  }

  /**
   * Adapter name shown in the HUD status line.
   * @returns {string}
   */
  getName() {
    return "FifteenPuzzleAdapter";
  }
}

/**
 * Group pixel coordinates into up to 4 clusters (one per column/row) and
 * return sorted cluster means. Values within CLUSTER_TOLERANCE_PX of the
 * current cluster join it; larger gaps start a new one.
 * @param {number[]} values
 * @returns {number[]}
 */
function clusterCoordinates(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters = [];
  let current = { sum: sorted[0], count: 1, mean: sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - current.mean <= CLUSTER_TOLERANCE_PX) {
      current.sum += sorted[i];
      current.count++;
      current.mean = current.sum / current.count;
    } else {
      clusters.push(current.mean);
      current = { sum: sorted[i], count: 1, mean: sorted[i] };
    }
  }
  clusters.push(current.mean);
  return clusters;
}

/**
 * Index of the cluster a coordinate belongs to (0-based grid row/col).
 * @param {number[]} clusters sorted cluster means
 * @param {number} value coordinate
 * @returns {number}
 */
function nearestClusterIndex(clusters, value) {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < clusters.length; i++) {
    const distance = Math.abs(clusters[i] - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

