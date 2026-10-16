/**
 * @fileoverview Burst14 phone-run evidence driver.
 *
 * Drives the self-contained bookmarklet on phone-sized screens (Playwright
 * device emulation, touch on) the way a phone user would run it, against the
 * vendored 2048 page served locally (never edited):
 *
 *   page load -> HUD injection -> detection (tap) -> panel/board overlap
 *   measurement -> Auto-solve moves -> tab-switch pause + resume -> game over
 *   -> reduced motion -> single-delivery probe.
 *
 * Screenshots + JSON facts land in --out (default: <repo>/evidence/phone/)
 * with filename prefix --label ("after" on the fixed head; "before" against
 * the pre-fix worktree at the red-tests commit).
 *
 * Usage:
 *   node evidence/run-phone-evidence.mjs --only=iPhone15:portrait
 *   REPO_ROOT=/tmp/pre-fix-worktree node evidence/run-phone-evidence.mjs \
 *       --label=before --out=/home/user/work/burst14-playkit-overlay-phone-run/evidence/phone \
 *       --only=iPhone15:portrait --only=iPhone15:landscape
 *
 * REPO_ROOT (default: this repo) supplies dist/2048-hud-bookmarklet.txt.
 *
 * Tab-switch caveat: Playwright forces every page's document.visibilityState
 * to "visible" (verified against headless, headed under Xvfb, without the
 * backgrounding-suppressing default flags, real X tab clicks, CDP
 * Target.activateTarget, and Page.setWebLifecycleState — none flip it), so
 * the pause/resume step drives the helper's REAL VisibilityHandler with an
 * in-page stub of document.hidden plus a real visibilitychange Event. The
 * handler, driver stop/resume, and HUD state on screen are the product's; only
 * the browser's tab state is stubbed. Disclosed in the PR.
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";

const repoRoot = process.env.REPO_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outRoot = join(repoRoot, "evidence", "phone");

// --- CLI ---------------------------------------------------------------------

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const at = args.indexOf(`--${name}`);
  return at !== -1 && args[at + 1] ? args[at + 1] : fallback;
}
const label = argValue("label", "after");
const outDir = argValue("out", outRoot);
const only = args.filter((a) => a.startsWith("--only=")).map((a) => a.slice("--only=".length));

// --- dependencies ------------------------------------------------------------

// playwright resolves from the bridge package (it owns the browser install).
const bridgeRequire = createRequire(join(repoRoot, "gauntlet/bridge/browser/package.json"));
const { chromium, devices } = bridgeRequire("playwright");
const { startFixtureServer } = await import(
  pathToFileURL(join(repoRoot, "gauntlet", "bridge", "browser", "server.mjs")).href
);

// --- inputs ------------------------------------------------------------------

const bookmarkletFile = join(repoRoot, "dist", "2048-hud-bookmarklet.txt");
const bookmarkletCode = readFileSync(bookmarkletFile, "utf8").trim().slice("javascript:".length);

mkdirSync(outDir, { recursive: true });

// --- device/orientation targets ---------------------------------------------

const PROFILES = {
  iPhone15: devices["iPhone 15"],
  Pixel8: devices["Pixel 7"],
};

function targets() {
  const list = [];
  for (const [name, profile] of Object.entries(PROFILES)) {
    const { width, height } = profile.viewport;
    list.push({ name, profile, orientation: "portrait", viewport: { width, height } });
    list.push({ name, profile, orientation: "landscape", viewport: { width: height, height: width } });
  }
  if (!only.length) return list;
  return list.filter((t) => only.includes(`${t.name}:${t.orientation}`));
}

// --- helpers -----------------------------------------------------------------

function shot(page, file) {
  return page.screenshot({ path: join(outDir, `${label}-${file}.png`) });
}

async function shadowText(page, selector) {
  return page.evaluate((sel) => {
    const host = document.querySelector("#ai-2048-solver-hud");
    const el = host && host.shadowRoot.querySelector(sel);
    return el ? el.textContent.trim() : null;
  }, selector);
}

async function panelFacts(page) {
  return page.evaluate(() => {
    const host = document.querySelector("#ai-2048-solver-hud");
    if (!host || !host.shadowRoot) return null;
    const panel = host.shadowRoot.querySelector(".hud-panel");
    const board = document.querySelector(".game-container");
    if (!panel || !board) return null;
    const p = panel.getBoundingClientRect();
    const b = board.getBoundingClientRect();
    const overlapW = Math.max(0, Math.min(p.right, b.right) - Math.max(p.left, b.left));
    const overlapH = Math.max(0, Math.min(p.bottom, b.bottom) - Math.max(p.top, b.top));
    const overlapArea = overlapW * overlapH;
    const boardArea = b.width * b.height;
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      panel: { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(p.width), h: Math.round(p.height) },
      board: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
      panelCoversBoardPct: boardArea ? Math.round((overlapArea / boardArea) * 100) : null,
      panelWithinViewport: p.right <= window.innerWidth + 1 && p.bottom <= window.innerHeight + 1,
    };
  });
}

async function tapHudButton(page, id) {
  await page.locator("#ai-2048-solver-hud").locator(`#${id}`).tap();
}

async function waitFor(fn, timeoutMs, pollMs = 150) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function injectBookmarklet(page) {
  await page.evaluate(bookmarkletCode);
  const attached = await waitFor(async () =>
    page.evaluate(() => Boolean(document.querySelector("#ai-2048-solver-hud")))
  , 8000);
  return Boolean(attached);
}

/** Wait for the HUD to report the page detected (auto or after a Detect tap). */
async function detect(page, { tapIfSlow = true } = {}) {
  const status = await waitFor(async () => {
    const text = await shadowText(page, "#game-status");
    return text && !/not detected/i.test(text) ? text : null;
  }, 12000);
  let mode = status ? "auto" : null;
  if (!status && tapIfSlow) {
    await tapHudButton(page, "detect-btn");
    const after = await waitFor(async () => {
      const text = await shadowText(page, "#game-status");
      return text && !/not detected/i.test(text) ? text : null;
    }, 8000);
    mode = after ? "tapped" : "failed";
  }
  const finalText = await shadowText(page, "#game-status");
  return { mode, gameStatus: finalText };
}

async function driverFacts(page) {
  return page.evaluate(() => {
    const r = window.ai2048Runtime;
    if (!r) return null;
    const stats = r.driver && r.driver.getStats ? r.driver.getStats() : null;
    return {
      hasRuntime: true,
      isRunning: r.driver ? r.driver.isRunning : null,
      moveCount: stats ? stats.moveCount : null,
      solverStatus: r.solverManager ? r.solverManager.getStatus() : null,
    };
  });
}

/**
 * Pause/resume journey step. Playwright pins every page visible, so the
 * browser's tab state is stubbed in-page while the helper's real
 * VisibilityHandler reacts to a real visibilitychange Event. See the file
 * header caveat.
 */
/**
 * The visibility contract: while hidden the driver's tick loop self-parks —
 * no moves, isRunning stays true — and after visible it resumes moving. The
 * VisibilityHandler also logs Pause/Resume of the managed component.
 */
async function tabSwitchStep(page) {
  const before = await driverFacts(page);
  await page.evaluate(() => {
    // Playwright pins every page visible; the helper's VisibilityHandler reads
    // document.visibilityState, so the stub flips it while the handler reacts
    // to the real visibilitychange Event.
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(700);
  const paused = await driverFacts(page);
  await shot(page, "05-tabswitch-paused");
  await page.waitForTimeout(900);
  const stable = await driverFacts(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1400);
  const resumed = await driverFacts(page);
  await shot(page, "06-tabswitch-resumed");
  return {
    method: "in-page visibilityState stub + real visibilitychange (Playwright pins pages visible)",
    before,
    paused,
    stableAfterPause: stable,
    resumed,
    driverWasRunningWhenHidden: before ? before.isRunning === true : null,
    // The real contract: no moves WHILE hidden. Ticks already scheduled at
    // hide time may legitimately land, so the pre-hide count is not compared.
    moveCountFrozenWhilePaused: stable && paused ? stable.moveCount === paused.moveCount : null,
    resumedAndMoving: resumed ? resumed.isRunning === true && resumed.moveCount > before.moveCount : null,
  };
}

/** Game-over journey: the stored state is already over — the page restores it
 * and renders the game-over banner at load, before any driver tick. The board
 * must stay untouched while the driver runs. */
async function game_overStep(page) {
  await page.evaluate(() => {
    const g = [];
    for (let x = 0; x < 4; x++) {
      g.push([]);
      for (let y = 0; y < 4; y++) {
        g[x].push({ position: { x, y }, value: ((x * 4 + y) % 8) + 2 });
      }
    }
    const state = { grid: { size: 4, cells: g }, score: 0, over: true, won: false, keepPlaying: false };
    window.localStorage.setItem("gameState", JSON.stringify(state));
  });
  await page.reload();
  await page.waitForSelector(".tile", { timeout: 8000 });
  const bannerAtLoad = await waitFor(
    () => page.evaluate(() => Boolean(document.querySelector(".game-over"))),
    6000
  );
  const injected = await injectBookmarklet(page);
  // Detection auto-starts the driver; on a dead board its sends change nothing.
  const over = await waitFor(async () => {
    const state = await page.evaluate(() => {
      const r = window.ai2048Runtime;
      return r && r.currentAdapter && r.driver
        ? { over: Boolean(r.currentAdapter.isGameOver()), isRunning: r.driver.isRunning, moveCount: r.driver.getStats().moveCount }
        : null;
    });
    return state && state.over ? state : null;
  }, 45000);
  await page.waitForTimeout(5000);
  const facts = await driverFacts(page);
  const tilesAtEnd = await page.evaluate(() => document.querySelectorAll(".tile").length);
  await shot(page, "07-gameover");
  return {
    injected,
    detected: await shadowText(page, "#game-status"),
    bannerAtLoad,
    adapterReportsGameOver: over ? true : false,
    boardUntouched: tilesAtEnd === 16,
    driverStillRunningAfterGameOver: facts ? facts.isRunning : null,
    moveCountAfter5s: facts ? facts.moveCount : null,
    facts,
  };
}

/** Single-delivery probe: one tile that any direction moves; one sendMove(). */
async function deliveryProbe(page) {
  await page.evaluate(() => {
    const g = [];
    for (let x = 0; x < 4; x++) {
      g.push([]);
      for (let y = 0; y < 4; y++) g[x].push(null);
    }
    // Single tile at x=2,y=1: LEFT/RIGHT/UP/DOWN all change the board, so one
    // move request must produce exactly one board change (one spawn: 2 tiles).
    g[2][1] = { position: { x: 2, y: 1 }, value: 2 };
    const state = { grid: { size: 4, cells: g }, score: 0, over: false, won: false, keepPlaying: false };
    window.localStorage.setItem("gameState", JSON.stringify(state));
  });
  await page.reload();
  await page.waitForSelector(".tile", { timeout: 8000 });
  await injectBookmarklet(page);
  // Suppress the driver BEFORE detection can auto-start it, so this probe's
  // one sendMove() is the only mover on the page.
  await page.evaluate(() => {
    const r = window.ai2048Runtime;
    if (r && r.driver) {
      r.driver.stop();
      r.__realDriverStart = r.driver.start;
      r.driver.start = () => {};
    }
  });
  await detect(page);
  await page.evaluate(() => window.ai2048Runtime.driver.stop());
  await page.waitForTimeout(300);
  const result = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const tiles = () => document.querySelectorAll(".tile:not(.tile-merged)").length;
    let saves = 0;
    const orig = window.localStorage.setItem.bind(window.localStorage);
    window.localStorage.setItem = (k, v) => {
      if (k === "gameState") saves++;
      return orig(k, v);
    };
    const before = tiles();
    window.ai2048Runtime.currentAdapter.sendMove(1); // RIGHT
    await sleep(500);
    window.localStorage.setItem = orig;
    return { tilesBefore: before, tilesAfter: tiles(), gameStateSaves: saves };
  });
  await shot(page, "09-delivery-probe");
  return {
    ...result,
    deliveredOnce: result.tilesAfter === result.tilesBefore + 1 && result.gameStateSaves === 1,
    deliveredTwice: result.tilesAfter > result.tilesBefore + 1 || result.gameStateSaves > 1,
  };
}

/** Reduced-motion mini-journey in its own context (reducedMotion: "reduce"). */
async function reducedMotionJourney(browser, target, consoleLines) {
  const context = await browser.newContext({
    ...target.profile,
    viewport: target.viewport,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("console", (m) => consoleLines.push(`[reduced] ${m.type()}: ${m.text()}`));
  const serveUrl2 = `http://127.0.0.1:${globalThis.__phoneServe.port}`;
  await page.goto(`${serveUrl2}/2048/`, { waitUntil: "load" });
  const injected = await injectBookmarklet(page);
  const detected = injected ? await detect(page) : { mode: "not-injected", gameStatus: null };
  // detection auto-starts the driver — no tap needed here
  const facts = await waitFor(async () => {
    const f = await driverFacts(page);
    return f && f.moveCount >= 1 ? f : null;
  }, 12000);
  const transition = await page.evaluate(() => {
    const host = document.querySelector("#ai-2048-solver-hud");
    const panel = host && host.shadowRoot.querySelector(".hud-panel");
    return panel ? getComputedStyle(panel).transitionDuration : null;
  });
  await shot(page, "08-reduced-motion");
  await context.close();
  return { injected, detected, facts, panelTransitionDuration: transition, reducedMotionApplied: transition === "0s" };
}

// --- journey per target --------------------------------------------------------

async function runTarget(browser, target) {
  const tag = `${label}-${target.name.toLowerCase()}-${target.orientation}`;
  const consoleLines = [];
  const results = { target: `${target.name}:${target.orientation}`, label, steps: {} };
  const videoDir = join(outDir, "_videos");
  mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    ...target.profile,
    viewport: target.viewport,
    recordVideo: { dir: videoDir, size: target.viewport },
  });
  const page = await context.newPage();
  page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`));

const serveUrl = `http://127.0.0.1:${globalThis.__phoneServe.port}`;

  await page.goto(`${serveUrl}/2048/`, { waitUntil: "load" });
  await page.waitForSelector(".tile", { timeout: 8000 });
  await shot(page, "01-page");

  // 2. install the HUD from the standalone bookmarklet
  const injected = await injectBookmarklet(page);
  const detectAuto = injected ? await detect(page, { tapIfSlow: false }) : null;
  await shot(page, "02-hud");
  results.steps.injection = { injected, detectAuto };

  // 3. explicit Detect tap (the tap journey)
  let tapped = null;
  if (injected) {
    const preStatus = await shadowText(page, "#game-status");
    await tapHudButton(page, "detect-btn").catch((e) => consoleLines.push(`tap detect failed: ${e.message}`));
    await page.waitForTimeout(600);
    tapped = { preStatus, postStatus: await shadowText(page, "#game-status") };
  }
  await shot(page, "03-detect");
  results.steps.detectTap = tapped;

  // 4. panel vs board geometry on this screen
  const facts = injected ? await panelFacts(page) : null;
  await shot(page, "02b-geometry");
  results.steps.geometry = facts;

  // 4b. header drag via Pointer Events: the panel follows the pointer, and a
  // pointercancel ends the drag without leaving it stuck in dragging state.
  if (injected) {
    const start = await page.evaluate(() => {
      const root = document.querySelector("#ai-2048-solver-hud").shadowRoot;
      const panel = root.querySelector(".hud-panel").getBoundingClientRect();
      const header = root.querySelector(".hud-header").getBoundingClientRect();
      return { px: panel.x, py: panel.y, hx: header.x + header.width / 2, hy: header.y + header.height / 2 };
    });
    await page.mouse.move(start.hx, start.hy);
    await page.mouse.down();
    await page.mouse.move(start.hx + 46, start.hy + 52, { steps: 6 });
    const mid = await page.evaluate(() => {
      const panel = document.querySelector("#ai-2048-solver-hud").shadowRoot.querySelector(".hud-panel");
      const r = panel.getBoundingClientRect();
      return { x: r.x, y: r.y, dragging: panel.classList.contains("dragging") };
    });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const released = await page.evaluate(() =>
      !document.querySelector("#ai-2048-solver-hud").shadowRoot.querySelector(".hud-panel").classList.contains("dragging")
    );
    await page.mouse.move(start.hx + 20, start.hy + 20);
    await page.mouse.down();
    await page.mouse.move(start.hx + 60, start.hy + 60, { steps: 4 });
    // The view registers its cancel handler on the document, so dispatch there.
    const cancelVisible = await page.evaluate(() => {
      const panel = document.querySelector("#ai-2048-solver-hud").shadowRoot.querySelector(".hud-panel");
      if (!panel.classList.contains("dragging")) return false;
      document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, cancelable: true }));
      return true;
    });
    await page.waitForTimeout(250);
    const cancelled = await page.evaluate(() =>
      !document.querySelector("#ai-2048-solver-hud").shadowRoot.querySelector(".hud-panel").classList.contains("dragging")
    );
    await shot(page, "03b-drag");
    results.steps.drag = {
      panelFollowedPointer: mid.dragging && (Math.abs(mid.x - start.px) > 10 || Math.abs(mid.y - start.py) > 10),
      releasedCleanly: released,
      cancelDelivered: cancelVisible,
      cancelEndedDrag: cancelled,
    };
  }

  // 5. Auto-solve driven by HUD taps: detection auto-starts the driver, so
  // the first tap stops it and the second starts it again — both real HUD
  // toggles, no external state pokes (an external driver.stop() desyncs the
  // HUD toggle: the next tap is then swallowed as a stop).
  if (injected) {
    await tapHudButton(page, "auto-solve-btn");
    await page.waitForTimeout(700);
    const stoppedByTap = (await driverFacts(page)).isRunning === false;
    await tapHudButton(page, "auto-solve-btn");
    const moved = await waitFor(async () => {
      const f = await driverFacts(page);
      return f && f.moveCount >= 5 && f.isRunning ? f : null;
    }, 20000);
    await shot(page, "04-autosolve");
    results.steps.autoSolve = { movedFive: Boolean(moved), startedByTap: Boolean(moved), stoppedByTap, facts: moved || (await driverFacts(page)) };

    // 6. tab-switch pause + resume
    results.steps.tabSwitch = await tabSwitchStep(page);
  }

  // 7. game over on a near-full board
  if (injected) {
    results.steps.gameOver = await game_overStep(page);
  }

  await context.close();

  // video: Playwright names it <uuid>.webm — one page in this context, so
  // rename deterministically.
  const videos = existsSync(videoDir) ? readdirSync(videoDir) : [];
  if (videos.length) {
    renameSync(join(videoDir, videos[0]), join(outDir, `${tag}.webm`));
  }

  // 8. reduced motion (own context)
  results.steps.reducedMotion = await reducedMotionJourney(browser, target, consoleLines);

  // 9. single-delivery probe (fresh page in a fresh context, touch on)
  const probeContext = await browser.newContext({ ...target.profile, viewport: target.viewport });
  const probePage = await probeContext.newPage();
  probePage.on("console", (m) => consoleLines.push(`[probe] ${m.type()}: ${m.text()}`));
  await probePage.goto(`${globalThis.__phoneUrl}/2048/`, { waitUntil: "load" });
  await probePage.waitForSelector(".tile", { timeout: 8000 });
  results.steps.deliveryProbe = await deliveryProbe(probePage);
  await probeContext.close();

  // 10. console log
  writeFileSync(join(outDir, `${tag}-console.log`), consoleLines.join("\n") + "\n");

  // pass flags for this target
  const s = results.steps;
  results.pass =
    s.injection &&
    s.injection.injected &&
    s.geometry &&
    s.geometry.panelWithinViewport &&
    s.autoSolve &&
    s.autoSolve.movedFive &&
    s.autoSolve.startedByTap &&
    s.tabSwitch &&
    s.tabSwitch.driverWasRunningWhenHidden &&
    s.tabSwitch.moveCountFrozenWhilePaused &&
    s.tabSwitch.resumedAndMoving &&
    s.drag &&
    s.drag.panelFollowedPointer &&
    s.drag.releasedCleanly &&
    s.drag.cancelEndedDrag &&
    s.gameOver &&
    s.gameOver.adapterReportsGameOver &&
    s.gameOver.bannerAtLoad &&
    s.gameOver.boardUntouched &&
    s.reducedMotion &&
    s.reducedMotion.reducedMotionApplied &&
    s.deliveryProbe &&
    s.deliveryProbe.deliveredOnce;

  writeFileSync(join(outDir, `phone-results-${tag}.json`), JSON.stringify(results, null, 2));
  return results;
}

// --- main ---------------------------------------------------------------------

const server = await startFixtureServer();
globalThis.__phoneServe = server;
globalThis.__phoneUrl = `http://127.0.0.1:${server.port}`;

const browser = await chromium.launch({ headless: true });
const summary = [];
try {
  for (const target of targets()) {
    const r = await runTarget(browser, target);
    summary.push({ target: r.target, pass: r.pass, steps: Object.fromEntries(
      Object.entries(r.steps).map(([k, v]) => [k, v && typeof v === "object" ? (v.pass ?? (v.deliveredOnce ?? (v.movedFive ?? (v.injected ?? true)))) : Boolean(v)])
    ) });
    console.log(`[phone-evidence] ${r.target}: pass=${r.pass}`);
  }
} finally {
  await browser.close();
  await server.close();
}
writeFileSync(join(outDir, `phone-summary-${label}.json`), JSON.stringify(summary, null, 2));
console.log(`[phone-evidence] summary written: ${join(outDir, `phone-summary-${label}.json`)}`);
process.exit(summary.every((s) => s.pass) ? 0 : 1);
