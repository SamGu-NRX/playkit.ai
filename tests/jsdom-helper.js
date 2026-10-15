/**
 * @fileoverview Shared jsdom fixture loader for the 15-puzzle tests.
 *
 * Loads an HTML fixture with inline scripts running (the game harness that
 * replays the site's arrow-key semantics) and exposes its document as the
 * globals the adapter modules expect.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

/**
 * Load a fixture and install its DOM as the ambient document.
 * @param {string} name fixture file name in tests/fixtures/
 * @param {{runScripts?: boolean}} options
 * @returns {{dom: JSDOM, window: Window, document: Document, restore: () => void}}
 */
export function loadFixture(name, options = {}) {
  const filePath = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  const html = readFileSync(filePath, "utf8");
  const dom = new JSDOM(html, {
    runScripts: options.runScripts === false ? undefined : "dangerously",
    pretendToBeVisual: true,
    url: "https://lorecioni.github.io/fifteen-puzzle-game/",
  });

  const window = dom.window;

  // jsdom ignores the non-standard keyCode/which init keys; the site's real
  // handlers (and the shared adapter code) read them, so surface them.
  const NativeKeyboardEvent = window.KeyboardEvent;
  window.KeyboardEvent = class extends NativeKeyboardEvent {
    constructor(type, init = {}) {
      super(type, init);
      if (typeof init.keyCode === "number") {
        Object.defineProperty(this, "keyCode", { value: init.keyCode });
      }
      if (typeof init.which === "number") {
        Object.defineProperty(this, "which", { value: init.which });
      }
    }
  };

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    KeyboardEvent: globalThis.KeyboardEvent,
  };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.KeyboardEvent = window.KeyboardEvent;

  return {
    dom,
    window,
    document: window.document,
    restore() {
      if (previous.window === undefined) delete globalThis.window;
      else globalThis.window = previous.window;
      if (previous.document === undefined) delete globalThis.document;
      else globalThis.document = previous.document;
      if (previous.KeyboardEvent === undefined) delete globalThis.KeyboardEvent;
      else globalThis.KeyboardEvent = previous.KeyboardEvent;
      window.close();
    },
  };
}

/** Wait for `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
