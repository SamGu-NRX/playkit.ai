// Contract test: the HUD must satisfy the VisibilityHandler's
// pause()/resume() contract so Runtime.init() can register it, and
// pause() must stop the HUD's own update-loop timers with resume()
// restarting them. Fails on the pre-fix tree: HUD has no pause()/resume(),
// so addManagedComponent throws "Component must have pause() and resume()
// methods".
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";

const REPO = "/home/user/work/burst11-playkit-overlay-helper-fix";

function bootDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://127.0.0.1/2048/",
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Event = dom.window.Event;
  return dom;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setVisibilityState(dom, value) {
  Object.defineProperty(dom.window.document, "visibilityState", {
    get: () => value,
    configurable: true,
  });
}

test("Runtime can register the HUD with the VisibilityHandler", async () => {
  const dom = bootDom();
  try {
    const { HUD } = await import(`${REPO}/src/hud/hud.js`);
    const { VisibilityHandler } = await import(`${REPO}/src/observer/visibility-handler.js`);

    const hud = new HUD();
    hud.init(); // mounts the shadow-DOM panel, as Runtime.init() does

    const handler = new VisibilityHandler({ enabled: true });
    // Pre-fix this throws: "Component must have pause() and resume() methods"
    handler.addManagedComponent(hud, "HUD");
    assert.equal(handler.managedComponents.size, 1);
    handler.destroy();
  } finally {
    await dom.window.close();
  }
});

test("HUD.pause() stops its update-loop timer; resume() restarts it when the fallback loop was running", async () => {
  const dom = bootDom();
  try {
    const { HUD } = await import(`${REPO}/src/hud/hud.js`);
    const hud = new HUD();
    hud.init();

    let fired = false;
    hud.isAutoSolving = true; // HUD-local fallback loop running (no controller)
    hud.autoSolveTimeout = setTimeout(() => {
      fired = true;
    }, 60);

    hud.pause();
    assert.equal(hud.autoSolveTimeout, null, "pause() must clear the pending loop timer");
    await sleep(100);
    assert.equal(fired, false, "the loop callback must not fire after pause()");

    hud.resume();
    assert.notEqual(hud.autoSolveTimeout, null, "resume() must restart the loop when it was running");

    hud.destroy();
  } finally {
    await dom.window.close();
  }
});

test("HUD.resume() must not restart the loop when auto-solve was not running", async () => {
  const dom = bootDom();
  try {
    const { HUD } = await import(`${REPO}/src/hud/hud.js`);
    const hud = new HUD();
    hud.init();

    hud.pause();
    hud.resume();
    assert.equal(hud.autoSolveTimeout, null, "resume() with nothing running must not schedule the loop");

    hud.destroy();
  } finally {
    await dom.window.close();
  }
});

test("a page hidden at registration pauses the HUD; showing it again resumes", async () => {
  const dom = bootDom();
  setVisibilityState(dom, "hidden");
  try {
    const { HUD } = await import(`${REPO}/src/hud/hud.js`);
    const { VisibilityHandler } = await import(`${REPO}/src/observer/visibility-handler.js`);

    const hud = new HUD();
    hud.init();
    const handler = new VisibilityHandler({ enabled: true, pauseDelay: 0, resumeDelay: 0 });

    handler.addManagedComponent(hud, "HUD");
    assert.equal(hud.visibilityPaused, true, "a hidden page must pause the HUD on registration");

    setVisibilityState(dom, "visible");
    dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await sleep(120);
    assert.equal(hud.visibilityPaused, false, "showing the page must resume the HUD");

    handler.destroy();
    hud.destroy();
  } finally {
    await dom.window.close();
  }
});
