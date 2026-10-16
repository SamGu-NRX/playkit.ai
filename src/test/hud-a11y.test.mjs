/**
 * @fileoverview Accessibility contract tests for the HUD overlay (jsdom).
 *
 * Run outside the repo tree with node --test, e.g.:
 *   NODE_TEST_ROOT=../hud-test-deps node --test src/test/hud-a11y.test.mjs
 * jsdom is resolved through a node_modules symlink into the directory named by
 * NODE_TEST_ROOT (default "../hud-test-deps"); the packages themselves are
 * installed outside the repository.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { symlinkSync, existsSync, mkdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

// Ensure jsdom resolves: the repo has no package.json of its own, so link the
// out-of-repo node_modules (named by NODE_TEST_ROOT) into the repo root. The
// symlink is untracked and node_modules/ is gitignored.
const repoRoot = resolve(here, "..", "..");
const depsRoot = resolve(
  repoRoot,
  process.env.NODE_TEST_ROOT || "../hud-test-deps",
);
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

// Import after the DOM globals exist so the HUD modules bind to jsdom.
const { HUD } = await import("../hud/hud.js");

const TICK_MS = 80; // > the announcer's 20ms re-announce delay
const tick = (ms = TICK_MS) => new Promise((r) => setTimeout(r, ms));

function mountHUD() {
  const hud = new HUD();
  hud.init();
  return hud;
}

function shadow() {
  return document.querySelector("#ai-2048-solver-hud").shadowRoot;
}

function announcerText() {
  return shadow().getElementById("hud-announcer").textContent;
}

function stubAdapter(name = "2048", score = 1024) {
  return {
    getName: () => name,
    getScore: () => score,
    isGameOver: () => false,
    readBoard: () => null,
    sendMove: () => {},
  };
}

test("every settings label is programmatically associated with its control", () => {
  const hud = mountHUD();
  try {
    const labels = [...shadow().querySelectorAll("label.setting-label")];
    assert.equal(labels.length, 5, "all five settings have labels");

    for (const label of labels) {
      const forId = label.getAttribute("for");
      assert.ok(forId, `label "${label.textContent.trim()}" has no for= attribute`);
      const control = shadow().getElementById(forId);
      assert.ok(control, `label for="${forId}" points at a missing element`);
      assert.equal(label.control, control, `label for="${forId}" is not associated`);
    }
  } finally {
    hud.destroy();
  }
});

test("the three selects have an accessible name like Depth and Probability do", () => {
  const hud = mountHUD();
  try {
    for (const id of ["direction-priority", "solver-strategy", "solver-heuristic"]) {
      const select = shadow().getElementById(id);
      assert.ok(select, `#${id} exists`);
      assert.ok(select.labels && select.labels.length >= 1, `#${id} has a label`);
      assert.ok(select.labels[0].textContent.trim().length > 0, `#${id} label has text`);
    }
  } finally {
    hud.destroy();
  }
});

test("collapse button announces its action and expanded state", () => {
  const hud = mountHUD();
  try {
    const btn = shadow().querySelector(".hud-btn-collapse");
    const panel = shadow().querySelector(".hud-panel");

    assert.equal(btn.getAttribute("aria-expanded"), "true", "expanded at mount");
    assert.match(btn.getAttribute("aria-label") || "", /collapse/i, "named action");
    assert.equal(btn.getAttribute("aria-hidden"), null, "button is not hidden from AT");

    btn.click();
    assert.equal(panel.getAttribute("data-collapsed"), "true");
    assert.equal(btn.getAttribute("aria-expanded"), "false");
    assert.match(btn.getAttribute("aria-label") || "", /expand/i);

    btn.click();
    assert.equal(btn.getAttribute("aria-expanded"), "true");
    assert.match(btn.getAttribute("aria-label") || "", /collapse/i);

    // The glyph is decoration; the name comes from aria-label.
    assert.equal(
      shadow().querySelector(".collapse-icon").getAttribute("aria-hidden"),
      "true",
    );
  } finally {
    hud.destroy();
  }
});

test("a polite live region exists, starts empty, and carries announcements", async () => {
  const hud = mountHUD();
  try {
    const announcer = shadow().getElementById("hud-announcer");
    assert.ok(announcer, "live region exists in the shadow root");
    assert.equal(announcer.getAttribute("role"), "status", "polite by role=status");
    assert.equal(announcer.textContent, "", "empty at mount (stable region)");

    hud.announce("Auto-solve started.");
    await tick();
    assert.equal(announcer.textContent, "Auto-solve started.");
  } finally {
    hud.destroy();
  }
});

test("nothing is announced on mount or on repeated status refreshes", async () => {
  const hud = mountHUD();
  try {
    await tick();
    assert.equal(announcerText(), "", "mount is silent");

    hud.currentAdapter = stubAdapter();
    hud.updateStatus();
    await tick();
    assert.match(announcerText(), /2048 detected\./);

    // updateStatus runs after every move; it must not re-announce.
    hud.updateStatus();
    hud.updateStatus();
    await tick();
    assert.equal(announcerText(), "2048 detected.");
  } finally {
    hud.destroy();
  }
});

test("run state transitions are announced: started, paused", async () => {
  const hud = mountHUD();
  try {
    hud.updateRunState(true);
    await tick();
    assert.match(announcerText(), /started/i);

    hud.updateRunState(true); // no transition, no re-announcement
    await tick();
    assert.equal(announcerText(), "Auto-solve started.");

    hud.updateRunState(false);
    await tick();
    assert.match(announcerText(), /paused/i);

    hud.updateRunState(false); // already stopped, silent
    await tick();
    assert.equal(announcerText(), "Auto-solve paused.");
  } finally {
    hud.destroy();
  }
});

test("game over announces the final score at stop", async () => {
  const hud = mountHUD();
  try {
    hud.updateRunState(true);
    await tick();

    hud.currentAdapter = stubAdapter("2048", 2980);
    hud.currentAdapter.isGameOver = () => true;
    await hud.autoSolveLoop();
    await tick();

    assert.match(announcerText(), /Game over\./i);
    assert.match(announcerText(), /2,980/, "final score is announced");
  } finally {
    hud.destroy();
  }
});

test("under the fallback engine Strategy and Heuristic are disabled with a reason", () => {
  const hud = mountHUD();
  try {
    hud.updateSolverStatus({ status: "fallback", mode: "fallback", lastError: "no artifact" });

    const strategy = shadow().getElementById("solver-strategy");
    const heuristic = shadow().getElementById("solver-heuristic");
    const hint = shadow().getElementById("strategy-engine-hint");

    assert.equal(strategy.disabled, true, "Strategy disabled under fallback");
    assert.equal(heuristic.disabled, true, "Heuristic disabled under fallback");
    assert.equal(hint.hidden, false, "the reason is visible");
    assert.match(hint.textContent, /WASM/, "the reason names the WASM solver");
    assert.equal(
      strategy.getAttribute("aria-describedby"),
      "strategy-engine-hint",
      "Strategy describes the reason",
    );
    assert.equal(
      heuristic.getAttribute("aria-describedby"),
      "strategy-engine-hint",
      "Heuristic describes the reason",
    );
  } finally {
    hud.destroy();
  }
});

test("under the WASM engine Strategy and Heuristic are enabled and the hint hides", () => {
  const hud = mountHUD();
  try {
    hud.updateSolverStatus({ status: "fallback", mode: "fallback" });
    hud.updateSolverStatus({
      status: "ready",
      mode: "wasm",
      strategy: { type: "expectimax-depth", heuristic: "corner", depth: 4, probability: 0.0025 },
    });

    const strategy = shadow().getElementById("solver-strategy");
    const heuristic = shadow().getElementById("solver-heuristic");
    const depth = shadow().getElementById("solver-depth");
    const probability = shadow().getElementById("solver-probability");
    const hint = shadow().getElementById("strategy-engine-hint");

    assert.equal(strategy.disabled, false, "Strategy enabled under WASM");
    assert.equal(heuristic.disabled, false, "Heuristic enabled under WASM");
    assert.equal(strategy.hasAttribute("aria-describedby"), false, "no stale description");
    assert.equal(heuristic.hasAttribute("aria-describedby"), false);
    assert.equal(hint.hidden, true, "hint hidden once the engine can honour the settings");

    // The existing strategy-based depth/probability gating is unchanged.
    assert.equal(depth.disabled, false);
    assert.equal(probability.disabled, true);
  } finally {
    hud.destroy();
  }
});

test("a failed detect announces the outcome", async () => {
  const hud = mountHUD();
  try {
    // Stub controller: detect finds nothing. (The controller-free fallback
    // path calls adapters/index.js detectGame(), whose module-scope
    // `globalAdapterRegistry` reference is broken outside src/hud/ — filed
    // under Next packets, not fixable here.)
    hud.setController({
      detectGame: async () => false,
      getCurrentAdapter: () => null,
    });
    await hud.handleDetectClick();
    await tick();
    assert.match(announcerText(), /No game detected\./i);
  } finally {
    hud.destroy();
  }
});
