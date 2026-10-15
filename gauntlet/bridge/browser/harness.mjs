/**
 * The real-browser session harness.
 *
 * Attachment path: the overlay's own bookmarklet loader (`src/bookmarklet/loader.js`),
 * served with the repo's own bundler output. The loader's comment is the
 * bookmarklet a user pastes into a browser; it injects a `<script>` tag for
 * `CDN_URL/2048-hud.min.js` into the page's main world. We point CDN_URL at
 * the local fixture server, which serves the bundle built by the repo's own
 * `scripts/build-phase0.js` from `src/runtime/bookmarklet.js` — the overlay's
 * real runtime (adapter registry, driver, HUD, solver manager), unmodified.
 *
 * After the runtime attaches, the Gauntlet agent is wired in through
 * `gauntlet/bridge/solver-engine.js` (inside `playBridgeSession`): the
 * runtime's real driver gets the Gauntlet engine via the driver's own
 * `setSolverEngine` hook and is stepped move by move, and every transition is
 * refereed by `gauntlet/bridge/referee.js`. `page.exposeFunction` is the
 * result channel back to this process.
 *
 * @module
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { startFixtureServer } from './server.mjs';

const execFileAsync = promisify(execFile);
const thisDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * Build the bookmarklet bundle with the repo's own zero-dependency bundler
 * (`scripts/build-phase0.js`: bundles `src/runtime/bookmarklet.js` and copies
 * it to `dist/2048-hud.min.js`). `dist/` is gitignored, so every test run
 * rebuilds it — no generated artifact is committed.
 *
 * @returns {Promise<string>} Absolute path of `dist/2048-hud.min.js`.
 */
export async function ensureBookmarkletBundle() {
  const repoRoot = resolve(thisDir, '..', '..', '..');
  await execFileAsync(process.execPath, ['scripts/build-phase0.js'], { cwd: repoRoot });
  return resolve(repoRoot, 'dist', '2048-hud.min.js');
}

/**
 * Extract the bookmarklet from the overlay's loader and point its CDN_URL at
 * the local fixture server.
 *
 * @param {string} loaderSource The source of `src/bookmarklet/loader.js`.
 * @param {number} port The local fixture server port.
 * @returns {string} The bookmarklet body (without the `javascript:` prefix).
 */
export function parseBookmarklet(loaderSource, port) {
  const line = loaderSource
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('javascript:'));
  if (!line) throw new Error('harness: no javascript: bookmarklet found in src/bookmarklet/loader.js');
  const body = line.slice('javascript:'.length).replace(/;$/, '');
  if (!body.includes('CDN_URL')) throw new Error('harness: bookmarklet has no CDN_URL placeholder');
  // The loader builds src as 'CDN_URL/2048-hud.min.js', so CDN_URL is the directory.
  const url = `http://127.0.0.1:${port}/bookmarklet`;
  const substituted = body.replaceAll('CDN_URL', url);
  if (substituted.includes('CDN_URL')) {
    throw new Error('harness: failed to substitute the CDN_URL placeholder in the bookmarklet');
  }
  return substituted;
}

/**
 * Per-test browser context: no touch input (the overlay adapter's touch
 * fallback becomes a silent no-op, exactly as on a desktop browser without
 * touch — otherwise every sendMove would deliver one keyboard move *and* one
 * touch move), and optionally a pinned Math.random for the page so a
 * tampered-page run is reproducible.
 *
 * @param {import('playwright').Browser} browser
 * @param {{ seed?: number }} [options]
 * @returns {Promise<import('playwright').BrowserContext>}
 */
async function newSessionContext(browser, options = {}) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.Touch = undefined;
    window.TouchEvent = undefined;
  });
  // FINDING (overlay defect, documented not fixed — this harness must not
  // change src/): the HUD class (src/hud/hud.js) has no pause()/resume()
  // methods, but Runtime.init() registers it with the VisibilityHandler,
  // which throws "Component must have pause() and resume() methods" in any
  // real browser. The overlay's bookmarklet path therefore never finishes
  // initializing (no window.ai2048Runtime); jsdom-based tests never reach
  // this registration, which is why it went unnoticed. The Driver (src/
  // driver/driver.js) satisfies the contract with real pause()/resume().
  // Harness condition: install non-enumerable no-op pause/resume on
  // Object.prototype so the HUD passes the capability check. The Driver's
  // real methods shadow these, non-enumerability keeps for-in loops in the
  // vendored game and elsewhere unaffected, and a benchmark page is always
  // visible, so correct HUD pause/resume would never fire anyway. This
  // keeps the attachment path exactly the product path (bookmarklet →
  // bundle → runtime → HUD → driver). Fixing the HUD belongs in
  // src/hud/hud.js and is out of scope here.
  await context.addInitScript(() => {
    const noop = function () {};
    for (const method of ['pause', 'resume']) {
      Object.defineProperty(Object.prototype, method, {
        value: noop,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  });
  if (options.seed !== undefined) {
    const seed = options.seed >>> 0;
    await context.addInitScript(`
      (() => {
        let s = ${seed >>> 0} >>> 0;
        Math.random = () => {
          s = (Math.imul(48271, s) >>> 0) % 2147483646;
          return s / 2147483646;
        };
      })();
    `);
  }
  return context;
}

/**
 * @typedef {object} BrowserSessionReport
 * @property {string} adapterName The overlay adapter the runtime attached.
 * @property {number} preMoves Moves the overlay's own auto-play loop made
 *   between runtime start and the harness taking over (before the session).
 * @property {'game-over' | 'move-cap' | string} endedWhy
 * @property {number} moves
 * @property {number} diverged
 * @property {*} log The playkit-gauntlet-bridge-log/1 session log.
 * @property {number[]} perMoveMs Per-move wall time around driver.step().
 * @property {number | null} finalScore
 * @property {string} userAgent
 */

/**
 * Play one bridge session in real Chromium on the vendored page.
 *
 * @param {object} setup
 * @param {import('playwright').Browser} setup.browser Launched Chromium.
 * @param {number} setup.port Fixture server port.
 * @param {'greedy' | 'engine'} setup.agent Which baseline plays.
 * @param {number} [setup.maxMoves] Session move cap (default 200).
 * @param {string} [setup.urlPath] Page to open (default `/2048/`; use
 *   `/2048-faulty/` for the tampered copy).
 * @param {number} [setup.seed] Pin the page's Math.random (fault check).
 * @param {number} [setup.timeoutMs] Session timeout (default 300000).
 * @returns {Promise<BrowserSessionReport>}
 */
export async function runBrowserSession(setup) {
  const { browser, port, agent } = setup;
  const maxMoves = setup.maxMoves ?? 200;
  const urlPath = setup.urlPath ?? '/2048/';
  const timeoutMs = setup.timeoutMs ?? 300000;

  const context = await newSessionContext(browser, { seed: setup.seed });
  try {
    const page = await context.newPage();

    /** The result channel back to Node. */
    /** @type {(value: BrowserSessionReport) => void} */
    let resolveReport;
    const reportPromise = new Promise((resolvePromise, rejectPromise) => {
      resolveReport = resolvePromise;
      const timer = setTimeout(
        () => rejectPromise(new Error(`bridge session timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      if (typeof timer.unref === 'function') timer.unref();
    });

    await page.exposeFunction('__bridgeReport', (value) => resolveReport(value));

    await page.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'load' });
    // The page constructs the game inside requestAnimationFrame — wait for it.
    await page.waitForFunction(() => document.querySelectorAll('.tile').length >= 2, null, {
      timeout: 15000,
      polling: 100,
    });

    // FINDING (overlay build defect, documented not fixed — this harness must
    // not change src/ or scripts/): the repo's zero-dependency bundler
    // (scripts/build-phase0.js) converts `export { X } from "./y.js"` into
    // `exports.X = require(y).X` without creating a local binding for X, so
    // any module that also *uses* a re-exported name internally breaks. That
    // is exactly src/adapters/index.js: its own detectGame() references the
    // bare `globalAdapterRegistry`, which throws ReferenceError in the built
    // bundle in any real browser (Runtime.init never completes). The unmodified
    // sources under the browser's native ESM loader provide the real registry
    // instance, so expose it as the global the bundle's bare identifier
    // resolves to. The adapter registry is a stateless page scanner, and the
    // returned adapter instance is equivalent to the one the bundled copy
    // would produce. Fixing the bundler belongs in scripts/build-phase0.js
    // and is out of scope here.
    await page.evaluate(async () => {
      const adapters = await import('/src/adapters/index.js');
      window.globalAdapterRegistry = adapters.globalAdapterRegistry;
    });

    // Attach the way a user does: paste the bookmarklet. Its script tag loads
    // the overlay bundle in the page's main world.
    const loaderSource = await readFile(
      resolve(thisDir, '..', '..', '..', 'src', 'bookmarklet', 'loader.js'),
      'utf8',
    );
    await page.evaluate(parseBookmarklet(loaderSource, port));
    await page.waitForFunction(() => Boolean(window.ai2048Runtime), null, {
      timeout: 20000,
      polling: 100,
    });

    const attachInfo = await page.evaluate(() => {
      const rt = /** @type {*} */ (window).ai2048Runtime;
      if (!rt) throw new Error('overlay runtime did not start');
      // The bookmarklet's quickStart auto-plays with the overlay's own solver;
      // stop the loop and hand the same driver to the Gauntlet agent.
      const preMoves = rt.driver ? rt.driver.getStats().moveCount : 0;
      if (rt.isRunning) rt.stop();
      if (!rt.currentAdapter) rt.detectGame();
      if (!rt.currentAdapter || !rt.currentAdapter.canAttach()) {
        throw new Error('the overlay runtime did not detect the 2048 game');
      }
      if (!rt.driver) rt.setupComponents();
      return { adapterName: rt.currentAdapter.getName(), preMoves };
    });

    await page.evaluate(
      async ({ agentName, moves }) => {
        const rt = /** @type {*} */ (window).ai2048Runtime;
        const [{ playBridgeSession }, baselines] = await Promise.all([
          import('/gauntlet/bridge/session.js'),
          import('/gauntlet/games/2048/baselines.js'),
        ]);
        const gauntletAgent =
          agentName === 'engine' ? baselines.engine({ depth: 2 }) : baselines.greedy();

        // Instrument the real driver.step for per-move wall time only.
        const perMoveMs = [];
        const realStep = rt.driver.step.bind(rt.driver);
        rt.driver.step = async () => {
          const t0 = performance.now();
          try {
            return await realStep();
          } finally {
            perMoveMs.push(performance.now() - t0);
          }
        };

        const result = await playBridgeSession(
          { adapter: rt.currentAdapter, driver: rt.driver, agent: gauntletAgent },
          { maxMoves: moves },
        );
        const score = rt.currentAdapter.getScore();
        window.__bridgeReport({
          adapterName: rt.currentAdapter.getName(),
          preMoves: 0,
          endedWhy: result.endedWhy,
          moves: result.moves,
          diverged: result.diverged,
          log: result.log,
          perMoveMs,
          finalScore: typeof score === 'number' ? score : null,
          userAgent: navigator.userAgent,
        });
      },
      { agentName: agent, moves: maxMoves },
    );

    const report = await reportPromise;
    return { ...report, preMoves: attachInfo.preMoves, adapterName: attachInfo.adapterName };
  } finally {
    await context.close();
  }
}

/** Re-export so tests only need this module. */
export { startFixtureServer };

/**
 * Latency summary over per-move wall times, in ms.
 *
 * @param {number[]} xs
 * @returns {{ mean: number, p50: number, p95: number, max: number }}
 */
export function latencyStats(xs) {
  if (xs.length === 0) return { mean: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

export {};
