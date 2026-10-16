/**
 * @fileoverview Fail-first jsdom tests for auto-detection retry (burst12 autodetect packet)
 *
 * A user opening a 2048 page must get "Game: Play2048Adapter" and an enabled
 * Auto-solve without clicking Detect Game. The old runtime probed exactly once
 * at init (`src/runtime/runtime.js:89`), so a game whose tiles are created by
 * page JavaScript after load stayed "Not detected".
 *
 * These tests exercise the Runtime directly against jsdom. jsdom is installed
 * OUTSIDE the repository (no root package.json / test runner in the repo):
 *
 *   cd /home/user/work && npm init -y && npm i jsdom
 *   cd <repo> && node --test src/test/autodetect.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Latent bug shim (unfixed here: src/adapters/ is outside this packet's paths):
// `export { X } from "./adapter-registry.js"` (src/adapters/index.js:15) creates
// NO local binding, so detectGame() at :22 references a free variable. Inside the
// esbuild bundle the reference resolves; under raw node ESM it throws
// ReferenceError. Export the registry as a global so this test exercises bundled
// behavior. Filed in the PR's Next-packets list with file:line.
import { globalAdapterRegistry as shimRegistry } from "../adapters/adapter-registry.js";
globalThis.globalAdapterRegistry = shimRegistry;

const GAME_MARKUP =
  '<div class="game-container">' +
  '<div class="tile-container">' +
  '<div class="tile tile-2 tile-position-0-0"><div class="tile-inner">2</div></div>' +
  "</div></div>";

const EXTENSION_OPTIONS = {
  autoInit: false, // extension mode: detection only, never starts solving
  enableHUD: false,
  enableVisibilityHandling: false,
  enableMutationObserver: true,
};

/**
 * Swap in a fresh jsdom document for the duration of one test so the runtime
 * (and its MutationObserver-based retry) observe that DOM, not node's.
 */
async function withRuntime(options, fn) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://127.0.0.1:8099/2048/",
    pretendToBeVisual: true,
  });

  const saved = new Map();
  const globals = ["document", "window", "MutationObserver", "localStorage", "navigator"];
  for (const key of globals) {
    saved.set(key, Object.prototype.hasOwnProperty.call(globalThis, key) ? globalThis[key] : undefined);
    globalThis[key] = dom.window[key];
  }

  try {
    const { Runtime } = await import("../runtime/runtime.js");
    const runtime = new Runtime({ ...EXTENSION_OPTIONS, ...options });
    await fn(runtime, dom);
    // destroy() so retry timers never leak into the next test
    if (typeof runtime.destroy === "function") {
      runtime.destroy();
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete globalThis[key];
      } else {
        globalThis[key] = value;
      }
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("game markup inserted 500 ms after init is detected without a click", async () => {
  await withRuntime(
    { autoDetectRetryDebounceMs: 50, autoDetectRetryTimeoutMs: 5000 },
    async (runtime, dom) => {
      await runtime.init();
      assert.equal(runtime.currentAdapter, null, "no game at init");

      let probeCalls = 0;
      const originalDetect = runtime.detectGame.bind(runtime);
      runtime.detectGame = () => {
        probeCalls++;
        return originalDetect();
      };

      // The page's own JS builds the board after load: simulate that.
      await sleep(500);
      dom.window.document.body.insertAdjacentHTML("beforeend", GAME_MARKUP);

      // No explicit detectGame() call anywhere: the mutation-driven retry must
      // find the game on its own.
      await sleep(700);
      assert.ok(runtime.currentAdapter, "adapter attached after late markup");
      assert.equal(runtime.currentAdapter.getName(), "Play2048Adapter");
      assert.ok(probeCalls >= 1, "retry probed at least once");
      assert.equal(runtime.isRunning, false, "extension mode must not start solving");
      assert.equal(runtime.driver, null, "extension mode must not set up the driver");
    }
  );
});

test("retry stops probing after the bounded window closes", async () => {
  await withRuntime(
    { autoDetectRetryDebounceMs: 30, autoDetectRetryTimeoutMs: 200 },
    async (runtime, dom) => {
      await runtime.init();
      assert.equal(runtime.currentAdapter, null);

      await sleep(450); // window (200 ms) is long closed
      dom.window.document.body.insertAdjacentHTML("beforeend", GAME_MARKUP);
      await sleep(400);

      assert.equal(
        runtime.currentAdapter,
        null,
        "no retries after the bounded window"
      );
    }
  );
});

test("a game present at init is still detected by the one-shot path", async () => {
  await withRuntime(
    { autoDetectRetryDebounceMs: 30, autoDetectRetryTimeoutMs: 5000 },
    async (runtime, dom) => {
      dom.window.document.body.insertAdjacentHTML("beforeend", GAME_MARKUP);
      await runtime.init();
      assert.ok(runtime.currentAdapter, "adapter attached at init");
      assert.equal(runtime.currentAdapter.getName(), "Play2048Adapter");
    }
  );
});

test("rapid mutations are debounced into few probes", async () => {
  await withRuntime(
    { autoDetectRetryDebounceMs: 120, autoDetectRetryTimeoutMs: 4000 },
    async (runtime, dom) => {
      await runtime.init();

      let probeCalls = 0;
      const originalDetect = runtime.detectGame.bind(runtime);
      runtime.detectGame = () => {
        probeCalls++;
        return originalDetect();
      };

      for (let i = 0; i < 8; i++) {
        const el = dom.window.document.createElement("div");
        el.textContent = "noise-" + i;
        dom.window.document.body.appendChild(el);
        await sleep(10);
      }
      await sleep(400);

      assert.ok(
        probeCalls <= 4,
        `expected debounced probes, got ${probeCalls}`
      );
    }
  );
});
