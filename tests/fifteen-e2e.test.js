/**
 * @fileoverview End-to-end test: the shared Driver loop, FifteenPuzzleAdapter,
 * and FifteenSolverEngine playing the saved 15-puzzle page in jsdom until the
 * puzzle is solved, plus HUD injection through the existing view.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { Driver } from "../src/driver/driver.js";
import { HUDView } from "../src/hud/view.js";
import { FifteenPuzzleAdapter } from "../src/adapters/fifteen-puzzle-adapter.js";
import { FifteenSolverEngine } from "../src/solver/fifteen-engine.js";
import { loadFixture } from "./jsdom-helper.js";

const OPTIMAL_MOVES = 15; // verified against BFS in fifteen-solver.test.js

test("driver + adapter + engine solve the fixture page end to end", (t) => {
  return new Promise((resolve, reject) => {
    const { document, restore } = loadFixture("fifteen-puzzle-page.html");
    t.after(restore);

    const adapter = new FifteenPuzzleAdapter();
    assert.equal(adapter.canAttach(), true);

    const engine = new FifteenSolverEngine();
    const driver = new Driver({ throttleMs: 30, domChangeTimeoutMs: 20 });
    driver.setAdapter(adapter);
    driver.setSolverEngine(engine);

    const moves = [];
    driver.onMove = (direction, count) => moves.push({ direction, count });
    driver.onError = (error) => {
      driver.stop();
      reject(new Error(`driver error: ${error?.message || error}`));
    };

    const timeout = setTimeout(() => {
      driver.stop();
      reject(
        new Error(
          `driver did not finish the puzzle; played ${moves.length} moves`
        )
      );
    }, 30000);

    driver.onGameOver = () => {
      clearTimeout(timeout);
      driver.stop();
      try {
        assert.ok(adapter.isGameOver(), "adapter reports the puzzle solved");
        assert.deepEqual(adapter.readBoard(), [
          [1, 2, 3, 4],
          [5, 6, 7, 8],
          [9, 10, 11, 12],
          [13, 14, 15, 0],
        ]);
        assert.equal(
          moves.length,
          OPTIMAL_MOVES,
          "driver plays exactly the optimal sequence"
        );
        resolve();
      } catch (error) {
        reject(error);
      }
    };

    driver.start();
  });
});

test("HUD mounts over the fixture page and renders the adapter name", (t) => {
  const { document, restore } = loadFixture("fifteen-puzzle-page.html");
  t.after(restore);

  // The full runtime pulls in WASM assets, so exercise the HUD view the way
  // the runtime controller does: mount, then report game detection.
  const view = new HUDView({});
  view.mount();

  const host = document.querySelector("#ai-2048-solver-hud");
  assert.ok(host, "HUD host element injected into the page");
  assert.ok(view.shadowRoot.querySelector(".hud-panel"), "HUD panel rendered");

  const adapter = new FifteenPuzzleAdapter();
  view.setGameStatus({ text: adapter.getName(), color: "#4ade80" });
  const status = view.shadowRoot.querySelector("#game-status");
  assert.ok(status, "game status element exists in the HUD");
  assert.equal(status.textContent, "FifteenPuzzleAdapter");

  view.destroy();
  assert.equal(document.querySelector("#ai-2048-solver-hud"), null, "HUD removed cleanly");
});
