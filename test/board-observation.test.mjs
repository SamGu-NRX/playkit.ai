/**
 * Zero-dependency node:test suite for the adapter observation contract.
 *
 * Pins FIX-7 (bench finding, vanish scenario): an adapter must never return
 * a fabricated board. When the board DOM is removed or replaced, readBoard()
 * reports null (unobservable) — never an all-zero board, never a stale read
 * from detached elements. Downstream (naive solver, WASM, driver) therefore
 * only ever acts on actually-observed boards.
 *
 * Run: node --test test/board-observation.test.mjs
 */

import assert from "node:assert/strict";
import { test, describe, beforeEach, afterEach } from "node:test";

import { Play2048Adapter } from "../src/adapters/play2048-adapter.js";
import { GenericAdapter } from "../src/adapters/generic-adapter.js";
import { BoardUtils } from "../src/adapters/adapter.js";

// ---------------------------------------------------------------------------
// Minimal document double exposing only what the adapters read.
// ---------------------------------------------------------------------------

class FakeClassList {
  constructor(tokens) {
    this.tokens = new Set(tokens);
  }
  contains(t) {
    return this.tokens.has(t);
  }
  *[Symbol.iterator]() {
    yield* this.tokens;
  }
}

class FakeElement {
  constructor(className = "", text = "") {
    this.className = className;
    this.classList = new FakeClassList(className.split(/\s+/).filter(Boolean));
    this.textContent = text;
    this.innerText = text;
    this.isConnected = true;
  }
}

/**
 * Install a global document double. `tileContainer`/`gameContainer` answer
 * the structure probes; `tiles` answer `.tile` queries.
 */
function installDocument({ tileContainer = null, gameContainer = null, tiles = [] } = {}) {
  const containers = {
    ".tile-container": tileContainer,
    ".game-container": gameContainer,
  };
  globalThis.document = {
    querySelector(sel) {
      // Match compound class selectors like ".game-container.game-over".
      const tokens = sel.split(".").filter(Boolean);
      for (const el of [tileContainer, gameContainer]) {
        if (el && tokens.every((t) => el.classList.contains(t))) return el;
      }
      return null;
    },
    querySelectorAll(sel) {
      return sel === ".tile" ? tiles : [];
    },
  };
  return globalThis.document;
}

function tile(value, row, col) {
  // play2048.co convention: 1-based COL-ROW position classes.
  return new FakeElement(`tile tile-${value} tile-position-${col + 1}-${row + 1}`, String(value));
}

const REFERENCE_BOARD = [
  [2, 0, 0, 0],
  [0, 4, 0, 0],
  [0, 0, 2, 0],
  [0, 0, 0, 8],
];

describe("Play2048Adapter.readBoard observation contract", () => {
  let adapter;
  beforeEach(() => {
    adapter = new Play2048Adapter();
  });
  afterEach(() => {
    delete globalThis.document;
  });

  test("board structure removed => null (unobservable), never a zero board", () => {
    installDocument({}); // vanish: containers and tiles all gone
    assert.equal(adapter.readBoard(), null);
  });

  test("board structure removed with prior game state => still null", () => {
    // Simulates the bench vanish scenario: the engine still holds a real
    // board, but the DOM that represented it is detached.
    installDocument({});
    assert.equal(adapter.readBoard(), null);
  });

  test("container present, zero tiles => structurally observable empty board", () => {
    // A transient empty board (e.g. mid-restart) with intact structure is a
    // legitimate observation.
    installDocument({ tileContainer: new FakeElement("tile-container") });
    assert.deepEqual(adapter.readBoard(), BoardUtils.createEmptyBoard());
  });

  test("tiles parse into the grid by position classes", () => {
    installDocument({
      tileContainer: new FakeElement("tile-container"),
      tiles: REFERENCE_BOARD.flatMap((row, r) =>
        row.map((v, c) => (v ? tile(v, r, c) : null)).filter(Boolean),
      ),
    });
    assert.deepEqual(adapter.readBoard(), REFERENCE_BOARD);
  });

  test("tiles exist but none parse => null (unrepresentable layout)", () => {
    installDocument({
      tileContainer: new FakeElement("tile-container"),
      tiles: [new FakeElement("tile mystery-tile", "")],
    });
    assert.equal(adapter.readBoard(), null);
  });

  test("isGameOver true only with the .game-over overlay", () => {
    const gameEl = new FakeElement("container game-container");
    installDocument({
      tileContainer: new FakeElement("tile-container"),
      gameContainer: gameEl,
      tiles: [],
    });
    assert.equal(adapter.isGameOver(), false);
    gameEl.classList = new FakeClassList(["container", "game-container", "game-over"]);
    assert.equal(adapter.isGameOver(), true);
  });
});

describe("GenericAdapter stale-cache contract", () => {
  let adapter;
  beforeEach(() => {
    adapter = new GenericAdapter();
  });
  afterEach(() => {
    delete globalThis.document;
  });

  test("cached board elements are not served once their container is detached", () => {
    // Prime the cache with a (pretend) previous detection whose container has
    // since been removed from the DOM.
    const detachedContainer = new FakeElement("game-board");
    detachedContainer.isConnected = false;
    const staleElements = Array.from({ length: 16 }, (_, i) =>
      new FakeElement("grid-cell", i === 0 ? "2" : i === 1 ? "4" : ""),
    );
    adapter._cachedGameContainer = detachedContainer;
    adapter._cachedBoardElements = staleElements;
    adapter._lastScanTime = Date.now(); // well inside the cache window

    // Fresh scan finds nothing (board DOM removed entirely).
    installDocument({});

    // Without the fix the cache would serve the detached elements as a live
    // board (fabricated observation). Contract: null.
    assert.equal(adapter.readBoard(), null);
  });

  test("cache stays valid while the container remains connected", () => {
    const container = new FakeElement("game-board");
    const elements = Array.from({ length: 16 }, (_, i) =>
      new FakeElement("grid-cell", i === 0 ? "2" : i === 1 ? "4" : ""),
    );
    adapter._cachedGameContainer = container;
    adapter._cachedBoardElements = elements;
    adapter._lastScanTime = Date.now();

    installDocument({}); // would find nothing on a fresh scan

    // Cached read still works: values come from the 16 cached cells.
    const board = adapter.readBoard();
    assert.equal(BoardUtils.isValidBoard(board), true);
    assert.equal(board[0][0], 2);
    assert.equal(board[0][1], 4);
  });
});
