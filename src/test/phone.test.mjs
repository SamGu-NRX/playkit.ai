/**
 * @fileoverview Phone-sized-screen contract tests for the 2048 overlay helper.
 *
 * The helper was desktop-only until burst14: a fixed 300 px panel, ~31 px
 * buttons, a 24 px collapse control, mouse-only dragging, and a touch
 * "fallback" in the 2048 adapter that fired even when keyboard delivery had
 * already succeeded — on touch-capable browsers (every phone, and phone
 * device emulation) the page binds both keyboard and touch handlers, so every
 * sendMove() moved the board twice. These tests pin the phone fixes:
 *
 *  - small screens: the panel width caps to the viewport and its height caps
 *    with an internally scrollable content area (settings no longer run off
 *    the bottom of a landscape phone);
 *  - coarse pointers: every control reaches the 44 px touch-target floor and
 *    form controls stop iOS focus-zoom (16 px font);
 *  - the header drags with Pointer Events, so a finger can move the HUD;
 *  - the 2048 adapter delivers exactly one move per sendMove() (the touch
 *    swipe is a fallback for keyboard delivery failure, not an addition).
 *
 * Run from the repository root (jsdom resolved like hud-a11y.test.mjs):
 *
 *   node --test src/test/phone.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { symlinkSync, existsSync, mkdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

// Same out-of-repo dependency layout as hud-a11y.test.mjs: jsdom resolves
// through a node_modules symlink into the directory named by NODE_TEST_ROOT.
const repoRoot = resolve(here, "..", "..");
const depsRoot = resolve(repoRoot, process.env.NODE_TEST_ROOT || "../hud-test-deps");
if (!existsSync(resolve(repoRoot, "node_modules"))) {
  mkdirSync(depsRoot, { recursive: true });
  symlinkSync(depsRoot, resolve(repoRoot, "node_modules"), "dir");
}

const { JSDOM } = await import("jsdom");

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.test/2048",
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;

// Import after the DOM globals exist so the modules bind to jsdom.
const { getHUDCSS } = await import("../hud/templates.js");
const { HUDView } = await import("../hud/view.js");
const { Play2048Adapter } = await import("../adapters/play2048-adapter.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Extract the body of a @media block containing `needle` (brace-counted, so
 * nested rules survive). Returns null when the query is absent — the shape
 * every phone-layout test asserts against.
 * @param {string} css
 * @param {string} needle
 * @returns {string|null}
 */
function mediaBlock(css, needle) {
  const at = css.indexOf(needle);
  if (at === -1) return null;
  const open = css.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Extract the rule body for `selector` inside a CSS fragment.
 * @param {string} css
 * @param {string} selector
 * @returns {string|null}
 */
function ruleFor(css, selector) {
  const at = css.indexOf(selector);
  if (at === -1) return null;
  const open = css.indexOf("{", at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/** The phone media block: small viewports or coarse (touch) pointers. */
function phoneBlock() {
  return mediaBlock(getHUDCSS(), "(pointer: coarse)");
}

test("phone layout: panel caps to the viewport and scrolls internally", () => {
  const block = phoneBlock();
  assert.ok(
    block,
    "getHUDCSS() must include a phone media block keyed on (pointer: coarse) — the fixed 300 px panel covers a phone board and its settings run off the bottom in landscape",
  );

  const panel = ruleFor(block, ".hud-panel");
  assert.ok(panel, "phone block must restyle .hud-panel");
  assert.match(panel, /100vw/, "panel width must cap to the viewport width");
  assert.match(panel, /max-height/, "panel height must cap to the viewport height");

  const content = ruleFor(block, ".hud-content");
  assert.ok(content, "phone block must restyle .hud-content");
  assert.match(
    content,
    /overflow-y:\s*auto/,
    "panel content must scroll internally instead of running off screen",
  );

  const collapsed = ruleFor(block, '[data-collapsed="true"]');
  assert.ok(collapsed, "phone block must restyle the collapsed panel");
  assert.match(
    collapsed,
    /height:\s*60px/,
    "collapsed strip must clear the 44 px collapse control",
  );
});

test("phone layout: controls reach the 44px touch-target floor", () => {
  const block = phoneBlock();
  assert.ok(block, "phone media block missing");

  const btn = ruleFor(block, ".hud-btn");
  assert.ok(btn, "phone block must restyle .hud-btn");
  assert.match(btn, /min-height:\s*44px/, "buttons must reach the 44px touch floor");
  assert.match(btn, /min-width:\s*44px/, "buttons must reach the 44px touch floor");

  const collapse = ruleFor(block, ".hud-btn-collapse");
  assert.ok(collapse, "phone block must restyle .hud-btn-collapse");
  assert.match(collapse, /width:\s*44px/, "collapse control must reach the 44px touch floor");
  assert.match(collapse, /height:\s*44px/, "collapse control must reach the 44px touch floor");
});

test("phone layout: form controls stop iOS focus zoom", () => {
  const block = phoneBlock();
  assert.ok(block, "phone media block missing");

  // iOS Safari zooms the page when a form control smaller than 16px is focused.
  const select = ruleFor(block, ".setting-select");
  assert.ok(select, "phone block must restyle .setting-select");
  assert.match(select, /font-size:\s*16px/, "selects must be 16px to stop iOS focus zoom");

  const input = ruleFor(block, ".setting-input");
  assert.ok(input, "phone block must restyle .setting-input");
  assert.match(input, /font-size:\s*16px/, "inputs must be 16px to stop iOS focus zoom");
});

test("header drag: pointer events move the panel", () => {
  const view = new HUDView({});
  view.mount();
  try {
    assert.equal(
      typeof view.boundHandlers.headerPointerDown,
      "function",
      "header drag must be wired for Pointer Events — a mousedown-only header cannot be moved by a finger",
    );

    view.boundHandlers.headerPointerDown({
      clientX: 100,
      clientY: 100,
      target: { closest: () => null },
      preventDefault() {},
    });
    assert.equal(view.isDragging, true, "pointerdown on the header starts a drag");

    const before = view.panel.style.left;
    view.boundHandlers.documentPointerMove({ clientX: 150, clientY: 140 });
    assert.notEqual(
      view.panel.style.left,
      before,
      "pointermove must move the panel",
    );

    view.boundHandlers.documentPointerUp({});
    assert.equal(view.isDragging, false, "pointerup ends the drag");
  } finally {
    view.destroy();
  }
});

test("header drag: pointercancel ends a drag cleanly", () => {
  const view = new HUDView({});
  view.mount();
  try {
    view.boundHandlers.headerPointerDown({
      clientX: 10,
      clientY: 10,
      target: { closest: () => null },
      preventDefault() {},
    });
    assert.equal(view.isDragging, true);

    view.boundHandlers.documentPointerCancel({});
    assert.equal(
      view.isDragging,
      false,
      "a cancelled touch (scroll takeover) must not leave the panel stuck dragging",
    );
    assert.equal(view.panel.classList.contains("dragging"), false);
  } finally {
    view.destroy();
  }
});

test("2048 adapter: one move per sendMove on touch-capable browsers", async () => {
  const adapter = new Play2048Adapter();
  let keyboard = 0;
  let touch = 0;
  adapter._dispatchKeyboardEvent = () => {
    keyboard++;
    // The real page's keyboard_input_manager preventDefaults every mapped key,
    // so a delivered keydown is CLAIMED (defaultPrevented) — the f09 sendMove
    // contract falls back to touch only on a throw or an unclaimed keydown.
    // A stub returning undefined models an unclaimed key and must fall back.
    return true;
  };
  adapter._simulateTouch = () => {
    touch++;
  };

  adapter.sendMove(0);
  await sleep(40);

  assert.equal(keyboard, 1, "keyboard delivery happens once");
  assert.equal(
    touch,
    0,
    "touch swipe must not fire when keyboard delivery succeeds — touch-capable browsers bind both handlers, so firing both moves the board twice per sendMove()",
  );

  // Fallback path: when keyboard delivery throws, the touch swipe takes over.
  adapter._dispatchKeyboardEvent = () => {
    throw new Error("no keyboard delivery in this environment");
  };
  adapter.sendMove(2);
  await sleep(40);

  assert.equal(touch, 1, "touch swipe is the fallback when keyboard delivery throws");
});
