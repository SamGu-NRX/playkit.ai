// Burst14 browser evidence: self-contained bookmarklet + extension zip, real Chromium.
// Journeys:
//  A. Bookmarklet install path: evaluate dist/2048-hud-bookmarklet.txt (the exact
//     javascript: URL a user bookmarks) on the vendored 2048 page -> HUD appears,
//     game auto-detected, SolverManager reports mode "wasm" + status "ready"
//     (not the JS fallback), Auto-solve runs and moves the board. Screenshots.
//  B. Extension zip load: unzip dist/2048-ai-solver-extension.zip, load unpacked
//     via --load-extension (headed Chromium under Xvfb), open the vendored page ->
//     HUD injected by the MV3 content script, detected + WASM ready (shadow text).
// Results: JSON + PNGs under <repo>/evidence/.

import { chromium } from "playwright";
import { startFixtureServer } from "./server.mjs";
import { execSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const repoRoot = "/home/user/burst14-playkit-overlay-release-build";
const evidenceDir = path.join(repoRoot, "evidence");
mkdirSync(evidenceDir, { recursive: true });

const results = { startedAt: new Date().toISOString(), journeys: [] };
function record(name, data) {
  results.journeys.push({ name, ...data });
  console.log(`[evidence] ${name}: ${JSON.stringify(data)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(page, fn, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await page.evaluate(fn);
      if (last) return last;
    } catch {
      // page navigating; retry
    }
    await sleep(intervalMs);
  }
  return null;
}

const server = await startFixtureServer();
const base = `http://127.0.0.1:${server.port}`;
console.log("fixture server at", base);

// ---------- Journey A: bookmarklet ----------
try {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleLines = [];
  page.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`));

  await page.goto(base + "/2048/", { waitUntil: "networkidle" });
  await page.waitForSelector(".tile", { timeout: 10000 });
  await page.screenshot({ path: path.join(evidenceDir, "a1-game-before.png") });

  const bookmarklet = readFileSync(
    path.join(repoRoot, "dist/2048-hud-bookmarklet.txt"),
    "utf8"
  ).trim();
  if (!bookmarklet.startsWith("javascript:")) throw new Error("artifact is not a javascript: URL");
  const code = bookmarklet.slice("javascript:".length);

  // Exactly what a browser does with a bookmark: evaluate the URL body in the page.
  await page.evaluate(code);

  await page.waitForSelector("#ai-2048-solver-hud", { state: "attached", timeout: 15000 });
  await page
    .locator("#ai-2048-solver-hud")
    .locator(".hud-panel")
    .waitFor({ state: "visible", timeout: 15000 });

  const solverStatus = await poll(
    page,
    () => {
      const sm = window.ai2048Runtime && window.ai2048Runtime.solverManager;
      if (!sm) return null;
      const st = sm.getStatus();
      return st.status !== "loading" && st.status !== "idle"
        ? { mode: st.mode, status: st.status, lastError: st.lastError }
        : null;
    },
    30000
  );
  const hudSolverText = await page.evaluate(() => {
    const host = document.getElementById("ai-2048-solver-hud");
    const s = host && host.shadowRoot && host.shadowRoot.getElementById("solver-status");
    return s ? s.textContent : null;
  });
  const gameStatus = await page.evaluate(() => {
    const host = document.getElementById("ai-2048-solver-hud");
    const g = host.shadowRoot.getElementById("game-status");
    return g ? g.textContent : null;
  });

  const wasmReady = !!solverStatus && solverStatus.mode === "wasm" && solverStatus.status === "ready";
  record("A-bookmarklet-attach", {
    hudAttached: true,
    solverStatus,
    hudSolverText,
    gameStatus,
    wasmEngine: wasmReady,
    pass: wasmReady && gameStatus !== "Not detected",
  });
  await page.screenshot({ path: path.join(evidenceDir, "a2-bookmarklet-hud-wasm.png") });

  // Auto-solve for a few seconds and prove the board moves.
  const scoreBefore = await page.evaluate(() => {
    const host = document.getElementById("ai-2048-solver-hud");
    const s = host.shadowRoot.getElementById("score-status");
    return s ? s.textContent : null;
  });
  const tilesBefore = await page.locator(".tile").count();
  await page.evaluate(() => {
    const host = document.getElementById("ai-2048-solver-hud");
    host.shadowRoot.getElementById("auto-solve-btn").click();
  });
  const moveStats = await poll(
    page,
    () => {
      const r = window.ai2048Runtime;
      const st = r && r.driver && r.driver.getStats ? r.driver.getStats() : null;
      return st && st.moveCount >= 1
        ? { moveCount: st.moveCount, stuckCount: st.stuckCount, isRunning: st.isRunning }
        : null;
    },
    60000,
    500
  );
  await page.screenshot({ path: path.join(evidenceDir, "a3-bookmarklet-autosolve.png") });

  const scoreAfter = await page.evaluate(() => {
    const host = document.getElementById("ai-2048-solver-hud");
    const s = host.shadowRoot.getElementById("score-status");
    return s ? s.textContent : null;
  });
  const tilesNow = await page.locator(".tile").count();
  const driverMoves = moveStats ? moveStats.moveCount : 0;

  // Pause the loop, then close.
  await page.evaluate(() => {
    const host = document.getElementById("ai-2048-solver-hud");
    const btn = host.shadowRoot.getElementById("auto-solve-btn");
    if (btn && btn.textContent.includes("Pause")) btn.click();
  });
  await browser.close();

  record("A-bookmarklet-autosolve", {
    scoreBefore,
    scoreAfter,
    tilesBefore,
    tileCount: tilesNow,
    driverStats: moveStats,
    driverMoves,
    pass: driverMoves >= 1,
  });
  writeFileSync(path.join(evidenceDir, "a-console.log"), consoleLines.join("\n"));
} catch (err) {
  record("A-bookmarklet", { pass: false, error: String(err).slice(0, 500) });
}

// ---------- Journey B: extension zip ----------
try {
  const extDir = "/tmp/burst14-ext-check";
  rmSync(extDir, { recursive: true, force: true });
  execSync(`unzip -q ${repoRoot}/dist/2048-ai-solver-extension.zip -d ${extDir}`);

  const context = await chromium.launchPersistentContext("/tmp/burst14-ext-profile", {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(base + "/2048/", { waitUntil: "networkidle" });
  await page.waitForSelector(".tile", { timeout: 10000 });

  await page.waitForSelector("#ai-2048-solver-hud", { state: "attached", timeout: 15000 });
  // Content script world is isolated; its window.ai2048Runtime is not visible
  // from the main world. The shadow DOM is shared, so read the HUD status text.
  const solverText = await poll(
    page,
    () => {
      const host = document.getElementById("ai-2048-solver-hud");
      const s = host && host.shadowRoot && host.shadowRoot.getElementById("solver-status");
      return s && /ready|fallback|error/i.test(s.textContent) ? s.textContent : null;
    },
    30000
  );
  const gameStatus = await page.evaluate(() => {
    const g = document.getElementById("ai-2048-solver-hud").shadowRoot.getElementById("game-status");
    return g ? g.textContent : null;
  });
  await page.screenshot({ path: path.join(evidenceDir, "b1-extension-hud.png") });
  await context.close();

  const wasmOk = !!solverText && /wasm/i.test(solverText) && !/fallback/i.test(solverText);
  record("B-extension-zip", {
    extensionLoaded: true,
    solverStatus: solverText,
    gameStatus,
    pass: wasmOk && gameStatus !== "Not detected",
  });
} catch (err) {
  record("B-extension-zip", { pass: false, error: String(err).slice(0, 500) });
}

results.finishedAt = new Date().toISOString();
results.allPass = results.journeys.every((j) => j.pass !== false);
writeFileSync(path.join(evidenceDir, "journey-results.json"), JSON.stringify(results, null, 2));
console.log("ALL PASS:", results.allPass);
await server.close().catch(() => {});
process.exit(results.allPass ? 0 : 1);
