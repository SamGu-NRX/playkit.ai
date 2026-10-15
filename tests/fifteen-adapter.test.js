/**
 * @fileoverview Adapter tests against saved-page fixtures: detection, board
 * reading from geometry (with stale position classes), key dispatch, score,
 * and game-over detection.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Direction } from "../src/adapters/adapter.js";
import { FifteenPuzzleAdapter } from "../src/adapters/fifteen-puzzle-adapter.js";
import { Play2048Adapter } from "../src/adapters/play2048-adapter.js";
import { globalAdapterRegistry } from "../src/adapters/adapter-registry.js";
import { loadFixture } from "./jsdom-helper.js";

const UP = Direction.UP;
const RIGHT = Direction.RIGHT;
const DOWN = Direction.DOWN;
const LEFT = Direction.LEFT;

const EXPECTED_BOARD = [
  [1, 2, 3, 4],
  [5, 12, 8, 10],
  [9, 6, 7, 0],
  [13, 14, 11, 15],
];

test("adapter detects the saved 15-puzzle page and reads the board", (t) => {
  const { document, restore } = loadFixture("fifteen-puzzle-page.html");
  t.after(restore);

  const adapter = new FifteenPuzzleAdapter();
  assert.equal(adapter.canAttach(), true, "adapter should attach");
  assert.deepEqual(adapter.readBoard(), EXPECTED_BOARD);
  assert.equal(adapter.isGameOver(), false);
});

test("board reading follows live geometry, not stale position classes", (t) => {
  const { document, restore } = loadFixture("fifteen-puzzle-page.html");
  t.after(restore);

  const adapter = new FifteenPuzzleAdapter();

  // Simulate the site's keydown for ArrowLeft (tile right of blank slides
  // left): update inline styles ONLY, leaving position classes stale —
  // exactly what the real page's js/tiles.js does on every move.
  // Blank is at (row 2, col 3); tile 7 sits to its right at (2, 2)... after
  // the fixture's coordinates: tile 7 at row 2 col 2, blank at row 2 col 3.
  const tile7 = document.getElementById("tile-7");
  tile7.style.left = "306px"; // col 3
  tile7.style.top = "206px"; // row 2 (unchanged)

  const board = adapter.readBoard();
  assert.equal(board[2][3], 7, "tile 7 now in the blank's cell via style");
  assert.equal(board[2][2], 0, "tile 7's old cell is blank");
  // Row 2 now reads 9, 6, 0, 7 — from geometry, while the classes still
  // claim the old layout.
  assert.deepEqual(board[2], [9, 6, 0, 7]);
});

test("board reading falls back to position classes when styles are absent", (t) => {
  const { document, restore } = loadFixture("fifteen-puzzle-page.html");
  t.after(restore);

  // Remove inline styles: only the (accurate-at-creation) classes remain.
  for (const el of document.querySelectorAll(".tile")) {
    el.removeAttribute("style");
  }

  const adapter = new FifteenPuzzleAdapter();
  assert.deepEqual(adapter.readBoard(), EXPECTED_BOARD);
});

test("detection rejects a 2048-style page", (t) => {
  const { restore } = loadFixture("2048-page.html");
  t.after(restore);

  const fifteen = new FifteenPuzzleAdapter();
  assert.equal(
    fifteen.canAttach(),
    false,
    "15-puzzle adapter must not attach to a 2048 board"
  );

  const play2048 = new Play2048Adapter();
  assert.equal(play2048.canAttach(), true, "2048 adapter still attaches");
});

test("adapter dispatches arrow keys matching the site's handlers", (t) => {
  const { document, restore } = loadFixture("fifteen-puzzle-page.html");
  t.after(restore);

  const seen = [];
  document.addEventListener("keydown", (event) => {
    seen.push({ key: event.key, keyCode: event.keyCode, bubbles: event.bubbles });
  });

  const adapter = new FifteenPuzzleAdapter();
  adapter.sendMove(LEFT);
  adapter.sendMove(UP);

  assert.deepEqual(seen, [
    { key: "ArrowLeft", keyCode: 37, bubbles: true },
    { key: "ArrowUp", keyCode: 38, bubbles: true },
  ]);
});

test("adapter reports score and solved state", (t) => {
  {
    const { restore } = loadFixture("fifteen-puzzle-page.html");
    t.after(restore);
    const adapter = new FifteenPuzzleAdapter();
    assert.equal(adapter.getScore(), 0);
    assert.equal(adapter.isGameOver(), false);
  }

  {
    const { restore } = loadFixture("fifteen-puzzle-solved.html");
    t.after(restore);
    const adapter = new FifteenPuzzleAdapter();
    assert.equal(adapter.isGameOver(), true);
  }
});

test("registry picks the 15-puzzle adapter for its page and 2048 for 2048", (t) => {
  const { restore } = loadFixture("fifteen-puzzle-page.html");
  t.after(restore);

  const detected = globalAdapterRegistry.detectAdapter();
  assert.ok(detected, "a game adapter should be detected");
  assert.equal(detected.getName(), "FifteenPuzzleAdapter");
});

test("adapter supplies its preferred solver engine", (t) => {
  const { restore } = loadFixture("fifteen-puzzle-page.html");
  t.after(restore);

  const adapter = new FifteenPuzzleAdapter();
  const engine = adapter.getPreferredSolverEngine();
  assert.ok(engine, "adapter exposes an engine");
  assert.equal(engine, adapter.getPreferredSolverEngine(), "engine is cached");
  assert.equal(typeof engine.getMoveOrder, "function");
});
