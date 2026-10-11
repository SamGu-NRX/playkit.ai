/**
 * Accessibility contract tests for the HUD view (src/hud/view.js +
 * src/hud/templates.js).
 *
 * The DOM shim cannot mount a shadow root, so these tests pin two layers:
 *   1. The markup/CSS contract of the templates (label associations, live
 *      region, collapse ARIA, header keyboard affordance, reduced-motion and
 *      narrow-viewport guards).
 *   2. The new keyboard/resize/focus handler behaviour on a stubbed panel
 *      (arrow-key moves with clamping, Home reset, Escape collapse with focus
 *      return, ARIA sync, host-focus tracking).
 *
 * The real-DOM wiring (listeners attached to actual elements, axe scan,
 * screenshots) is verified by the browser walk in docs/control-console-evidence/.
 *
 * Run: node --test test/hud-view-a11y.test.mjs
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { HUDView } from "../src/hud/view.js";
import { getHUDCSS, getHUDHTML } from "../src/hud/templates.js";

describe("HUD templates: a11y markup contract", () => {
  const html = getHUDHTML();

  test("every setting label is associated with an existing control id", () => {
    const forAttrs = [...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(forAttrs.length >= 5, `expected at least 5 labelled controls, got ${forAttrs.length}`);

    for (const id of forAttrs) {
      assert.match(
        html,
        new RegExp(`id="${id}"`),
        `label for="${id}" has no matching element id in the template`,
      );
    }
  });

  test("the status block is a polite live region", () => {
    assert.match(html, /class="hud-status" role="status" aria-live="polite"/);
  });

  test("collapse button exposes expanded state, controlled region, and name", () => {
    assert.match(
      html,
      /class="hud-btn hud-btn-collapse"[^>]*aria-expanded="true"/,
    );
    assert.match(
      html,
      /class="hud-btn hud-btn-collapse"[^>]*aria-controls="hud-content-region"/,
    );
    assert.match(html, /class="hud-btn hud-btn-collapse"[^>]*aria-label="Collapse panel"/);
  });

  test("content region carries the id the collapse button controls", () => {
    assert.match(html, /<div class="hud-content" id="hud-content-region">/);
  });

  test("header is focusable and documents the keyboard affordances", () => {
    assert.match(html, /class="hud-header" tabindex="0" role="group" aria-label="[^"]*arrow keys[^"]*"/);
    assert.match(html, /aria-label="[^"]*Home[^"]*"/);
    assert.match(html, /aria-label="[^"]*Escape[^"]*"/);
  });
});

describe("HUD templates: reduced-motion and narrow-viewport CSS", () => {
  const css = getHUDCSS();

  test("reduced-motion media query disables transitions, hover lift, and pulse", () => {
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n      \}/);
    assert.ok(reduced, "expected a prefers-reduced-motion block");
    assert.match(reduced[0], /transition: none !important/);
    assert.match(reduced[0], /animation: none !important/);
    assert.match(reduced[0], /transform: none/);
  });

  test("panel width is capped for 390px-class viewports", () => {
    assert.match(css, /max-width: calc\(100vw - 16px\)/);
  });

  test("focus-visible outlines exist for buttons, fields, and header", () => {
    assert.match(css, /\.hud-btn:focus-visible/);
    assert.match(css, /\.setting-select:focus-visible/);
    assert.match(css, /\.setting-input:focus-visible/);
    assert.match(css, /\.hud-header:focus-visible/);
  });
});

describe("HUD view keyboard and focus behaviour", () => {
  /** Minimal panel stub: geometry + recorded attributes/styles. */
  function makePanelStub({ width = 300, height = 160 } = {}) {
    const attributes = {};
    return {
      attributes,
      style: { left: "", top: "" },
      getBoundingClientRect() {
        return { left: 0, top: 0, width, height, right: width, bottom: height };
      },
      setAttribute(name, value) {
        attributes[name] = value;
      },
      classList: { toggle() {}, add() {}, remove() {} },
    };
  }

  function makeView({ width = 300, height = 160 } = {}) {
    const events = { collapse: [] };
    const view = new HUDView({
      onCollapse: (collapsed) => events.collapse.push(collapsed),
    });
    view.panel = makePanelStub({ width, height });
    view.elements.collapseBtn = makePanelStub();
    view.elements.collapseIcon = { textContent: "−" };
    view.elements.header = { addEventListener() {}, removeEventListener() {} };
    view.events = events;
    return view;
  }

  beforeEach(() => {
    if (typeof globalThis.window === "undefined") {
      globalThis.window = {
        innerWidth: 1280,
        innerHeight: 800,
        addEventListener() {},
        removeEventListener() {},
      };
    }
  });

  test("ArrowLeft moves the panel 16px and records the clamped position", () => {
    const view = makeView();
    view.currentPos = { x: 500, y: 200 };
    view.position(500, 200);

    view.handleHeaderKeyDown({ key: "ArrowLeft", shiftKey: false, preventDefault() {} });

    assert.equal(view.currentPos.x, 484);
    assert.equal(view.currentPos.y, 200);
    assert.equal(view.panel.style.left, "484px");
  });

  test("Shift+Arrow moves in a larger 64px step", () => {
    const view = makeView();
    view.position(500, 200);

    view.handleHeaderKeyDown({ key: "ArrowRight", shiftKey: true, preventDefault() {} });

    assert.equal(view.currentPos.x, 564);
  });

  test("keyboard moves clamp inside the viewport", () => {
    const view = makeView();
    view.position(50, 50);

    view.handleHeaderKeyDown({ key: "ArrowLeft", shiftKey: true, preventDefault() {} });
    view.handleHeaderKeyDown({ key: "ArrowLeft", shiftKey: true, preventDefault() {} });
    view.handleHeaderKeyDown({ key: "ArrowLeft", shiftKey: true, preventDefault() {} });

    assert.equal(view.currentPos.x, 0, "panel must never move past the left edge");
  });

  test("Home resets the panel to the mount position", () => {
    const view = makeView();
    view.position(10, 300);

    view.handleHeaderKeyDown({ key: "Home", shiftKey: false, preventDefault() {} });

    assert.equal(view.currentPos.x, window.innerWidth - 320);
    assert.equal(view.currentPos.y, 20);
  });

  test("unrelated keys on the header are ignored", () => {
    const view = makeView();
    view.position(100, 100);

    view.handleHeaderKeyDown({ key: "a", shiftKey: false, preventDefault() {} });
    view.handleHeaderKeyDown({ key: "Tab", shiftKey: false, preventDefault() {} });

    assert.equal(view.currentPos.x, 100);
    assert.equal(view.currentPos.y, 100);
  });

  test("Escape collapses the panel, notifies, syncs ARIA, and returns focus", () => {
    const view = makeView();
    view.position(100, 100);
    const host = { focused: false, focus() { this.focused = true; } };
    view.lastHostFocus = host;

    view.handleShadowKeyDown({ key: "Escape" });

    assert.equal(view.isCollapsed, true);
    assert.equal(view.panel.attributes["data-collapsed"], "true");
    assert.deepEqual(view.events.collapse, [true]);
    assert.equal(view.elements.collapseBtn.attributes["aria-expanded"], "false");
    assert.equal(view.elements.collapseBtn.attributes["aria-label"], "Expand panel");
    assert.equal(view.elements.collapseIcon.textContent, "+");
    assert.equal(host.focused, true, "focus must return to the last host-page element");
  });

  test("Escape is a no-op while already collapsed", () => {
    const view = makeView();
    view.setCollapsed(true);
    view.events.collapse.length = 0;

    view.handleShadowKeyDown({ key: "Escape" });

    assert.deepEqual(view.events.collapse, []);
  });

  test("non-Escape keys inside the HUD never collapse it", () => {
    const view = makeView();

    view.handleShadowKeyDown({ key: "Enter" });
    view.handleShadowKeyDown({ key: "Tab" });

    assert.equal(view.isCollapsed, false);
    assert.deepEqual(view.events.collapse, []);
  });

  test("focus tracking records host-page elements and ignores HUD elements", () => {
    const view = makeView();
    const hostEl = { id: "host-button" };
    const hudEl = { id: "detect-btn" };
    view.shadowRoot = { contains: (t) => t === hudEl };

    view.handleDocumentFocusIn({ target: hostEl });
    view.handleDocumentFocusIn({ target: hudEl });

    assert.equal(view.lastHostFocus, hostEl, "HUD-internal focus must not displace the host target");
  });

  test("re-expanding restores the collapse affordance's ARIA", () => {
    const view = makeView();
    view.setCollapsed(true);
    view.setCollapsed(false);

    assert.equal(view.elements.collapseBtn.attributes["aria-expanded"], "true");
    assert.equal(view.elements.collapseBtn.attributes["aria-label"], "Collapse panel");
    assert.equal(view.panel.attributes["data-collapsed"], "false");
  });

  test("resize re-clamps the stored position into the shrunken viewport", () => {
    const view = makeView({ width: 300, height: 160 });
    view.position(1200, 700);

    window.innerWidth = 390;
    window.innerHeight = 844;
    try {
      view.handleWindowResize();
      assert.equal(view.currentPos.x, 390 - 300, "x clamps to viewport width minus panel width");
      assert.equal(view.currentPos.y, 640, "y stays: re-clamp only pulls positions into view, never pushes them");

      window.innerHeight = 500;
      view.handleWindowResize();
      assert.equal(view.currentPos.y, 500 - 160, "a shrunken height pulls y back into view");
    } finally {
      window.innerWidth = 1280;
      window.innerHeight = 800;
    }
  });
});
