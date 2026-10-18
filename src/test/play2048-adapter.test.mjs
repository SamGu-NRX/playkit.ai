/**
 * @fileoverview Fail-first jsdom tests for the 2048 adapter's keyboard -> touch
 * fallback (burst17 harness packet, f09).
 *
 * sendMove() used to fall back to the touch path only when the keyboard
 * dispatch THREW; an ineffective synthetic keydown (touch-only pages,
 * keyboard-deaf clones) does not throw, so the solver's move was silently
 * dropped every tick. _dispatchKeyboardEvent now returns whether the page
 * claimed the keydown (defaultPrevented — the vendored reference page's
 * keyboard_input_manager.js preventDefaults exactly the keys it maps), and
 * sendMove falls back to touch on a throw OR an unclaimed keydown. On
 * dual-binding pages the claimed keydown suppresses touch, so the historical
 * double-move cannot return.
 *
 * The tests import the adapter DIRECTLY from ../adapters/play2048-adapter.js,
 * not via src/adapters/index.js, whose re-export binding drop is a disclosed
 * latent bug outside this packet's scope (see autodetect.test.mjs).
 *
 * jsdom is installed OUTSIDE the repository (no root package.json / test
 * runner in the repo):
 *
 *   cd /home/user/work && npm init -y && npm i jsdom
 *   cd <repo> && node --test src/test/play2048-adapter.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

import { Play2048Adapter } from "../adapters/play2048-adapter.js";
import { Direction } from "../adapters/adapter.js";

const GAME_MARKUP =
  '<div class="game-container">' +
  '<div class="tile-container">' +
  '<div class="tile tile-2 tile-position-1-1"><div class="tile-inner">2</div></div>' +
  "</div></div>";

/**
 * Swap in a fresh jsdom document plus the globals the adapter touches. The
 * touch path needs Touch/TouchEvent, which jsdom lacks: Touch is a plain
 * carrier class; TouchEvent extends the jsdom window's Event and copies the
 * touches lists from the init dict so page listeners can observe them.
 */
function setupDom() {
  const dom = new JSDOM(
    "<!doctype html><html><body>" + GAME_MARKUP + "</body></html>"
  );
  const saved = new Map();
  const globals = [
    "window",
    "document",
    "KeyboardEvent",
    "Event",
    "Touch",
    "TouchEvent",
  ];
  for (const key of globals) {
    saved.set(
      key,
      Object.prototype.hasOwnProperty.call(globalThis, key)
        ? globalThis[key]
        : undefined
    );
  }
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.Event = dom.window.Event;
  globalThis.Touch = class Touch {
    constructor(init) {
      Object.assign(this, init);
    }
  };
  globalThis.TouchEvent = class TouchEvent extends dom.window.Event {
    constructor(type, init = {}) {
      super(type, init);
      this.touches = init.touches ?? [];
      this.changedTouches = init.changedTouches ?? [];
    }
  };
  return {
    dom,
    restore() {
      for (const [key, value] of saved) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

/** A listener that counts named events into a counter object. */
function countListener(counter, name) {
  return () => {
    counter[name] += 1;
  };
}

test(
  "keyboard handled: sendMove delivers exactly one keyboard event and no touch events",
  () => {
    const env = setupDom();
    try {
      const counter = { keydown: 0, touchstart: 0, touchend: 0 };
      const keydownListener = (event) => {
        counter.keydown += 1;
        if (
          ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(
            event.key
          )
        ) {
          event.preventDefault();
        }
      };
      document.addEventListener("keydown", keydownListener);
      const container = document.querySelector(".game-container");
      container.addEventListener("touchstart", countListener(counter, "touchstart"));
      container.addEventListener("touchend", countListener(counter, "touchend"));

      new Play2048Adapter().sendMove(Direction.UP);

      assert.deepEqual(counter, { keydown: 1, touchstart: 0, touchend: 0 });
    } finally {
      env.restore();
    }
  }
);

test(
  "keyboard unclaimed: sendMove dispatches the keydown and falls back to touch",
  async () => {
    const env = setupDom();
    try {
      const counter = { keydown: 0, touchstart: 0, touchend: 0 };
      // Records but does NOT preventDefault — no handler claims the key.
      document.addEventListener("keydown", countListener(counter, "keydown"));
      const container = document.querySelector(".game-container");
      container.addEventListener("touchstart", countListener(counter, "touchstart"));
      container.addEventListener("touchend", countListener(counter, "touchend"));

      new Play2048Adapter().sendMove(Direction.DOWN);

      assert.equal(counter.keydown, 1, "the keydown was dispatched");
      // The adapter defers touchend ~50 ms after touchstart.
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(
        counter.touchstart,
        1,
        "the unclaimed keydown fell back to touchstart"
      );
      assert.equal(counter.touchend, 1, "the deferred touchend fired");
    } finally {
      env.restore();
    }
  }
);

test("dispatch throws: sendMove still runs the touch fallback", () => {
  const env = setupDom();
  try {
    const counter = { touchstart: 0 };
    const container = document.querySelector(".game-container");
    container.addEventListener("touchstart", countListener(counter, "touchstart"));

    // The keyboard path reads document.activeElement first, so a throwing
    // getter makes the dispatch throw — the touch fallback must still run.
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get() {
        throw new Error("activeElement unavailable");
      },
    });
    try {
      new Play2048Adapter().sendMove(Direction.LEFT);
    } finally {
      // Remove the instance shadow; jsdom's own accessor shines through again.
      delete document.activeElement;
    }

    assert.equal(counter.touchstart, 1, "the touch fallback ran");
  } finally {
    env.restore();
  }
});
