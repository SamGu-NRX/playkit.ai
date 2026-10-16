// Contract test: Play2048Adapter.getScore() must read the score element's own
// text, ignoring the transient .score-addition child the game adds during a
// "+N" animation. Fails on the pre-fix tree: textContent includes the child,
// and strip-non-digits turns "2428+8" into 24288.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";

const REPO = "/home/user/work/burst11-playkit-overlay-helper-fix";
const VENDORED = `${REPO}/gauntlet/bridge/browser/vendor/2048/index.html`;

async function bootVendoredPage() {
  const html = await readFile(VENDORED, "utf8");
  const dom = new JSDOM(html, { url: "http://127.0.0.1/2048/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Node = dom.window.Node;
  return dom;
}

function addScoreAddition(dom, text) {
  const addition = dom.window.document.createElement("div");
  addition.className = "score-addition";
  addition.textContent = text;
  dom.window.document.querySelector(".score-container").appendChild(addition);
  return addition;
}

test("getScore ignores a live .score-addition during a +8 animation", async () => {
  const dom = await bootVendoredPage();
  try {
    const { Play2048Adapter } = await import(`${REPO}/src/adapters/play2048-adapter.js`);
    const adapter = new Play2048Adapter();
    const scoreEl = dom.window.document.querySelector(".score-container");

    scoreEl.textContent = "2428";
    const addition = addScoreAddition(dom, "+8");
    // Pre-fix this reads 24288.
    assert.equal(adapter.getScore(), 2428, "'2428' + '+8' child must read 2428, not 24288");

    addition.remove();
    assert.equal(adapter.getScore(), 2428, "the plain score still reads normally");

    scoreEl.textContent = "0";
    addScoreAddition(dom, "+8");
    assert.equal(adapter.getScore(), 0, "'0' + '+8' child must read 0, not 8");

    assert.equal(adapter.getScore(), adapter.getScore(), "reads are stable while the animation element is present");
  } finally {
    await dom.window.close();
  }
});

test("getScore still reads the page score with no addition element", async () => {
  const dom = await bootVendoredPage();
  try {
    const { Play2048Adapter } = await import(`${REPO}/src/adapters/play2048-adapter.js`);
    const adapter = new Play2048Adapter();
    dom.window.document.querySelector(".score-container").textContent = "31672";
    assert.equal(adapter.getScore(), 31672);
  } finally {
    await dom.window.close();
  }
});
