/**
 * Fixture bootstrap — wires the fixture game, input capture, and the runtime
 * under test together inside a fixture page, then exposes window.__BENCH__
 * for the benchmark runner (same-origin iframe access).
 *
 * Query parameters (all optional):
 *   seed=1            PRNG seed for the fixture game
 *   scenario=normal   normal | late | gameover | vanish | swap
 *   listener=document where the page's own game key listener lives:
 *                     document | window | element
 *   keyProp=key       which KeyboardEvent property the page reads:
 *                     key | which | keyCode
 *   touchOnly=0       1 = page ignores keyboard, moves only on touch swipes
 *   customListener=0  1 = page also listens for CustomEvent("move") on the
 *                     game container (GetMIT-style variants)
 *   layer=src         src = import src modules directly (Layer 2);
 *                     bundle = shim chrome and load the built content.js
 *                     (Layer 3 — the shipped artifact)
 *   wasm=missing      missing = default (solver.wasm absent -> fallback);
 *                     mock = point the WASM engine at a mock ES module;
 *                     off = disableWasm
 *   adapter=auto      auto = detectGame(); play2048|generic|getmit = direct
 *   hud=1             mount the real HUD
 *   autoStart=0       1 = runtime.start() as soon as initialized
 */

const params = Object.fromEntries(new URLSearchParams(location.search));

function num(name, fallback) {
  const v = Number(params[name]);
  return Number.isFinite(v) && params[name] !== undefined && params[name] !== ""
    ? v
    : fallback;
}

const seed = num("seed", 1);
const scenario = params.scenario || "normal";
const listenerLevel = params.listener || "document";
const keyProp = params.keyProp || "key";
const touchOnly = params.touchOnly === "1";
const customListener = params.customListener === "1";
const layer = params.layer || "src";
const wasmMode = params.wasm || "missing";
const adapterChoice = params.adapter || "auto";
const enableHUD = params.hud !== "0";
const autoStart = params.autoStart === "1";

// Awaiting: __createFixtureGame is async (dynamically imports the engine).
const game = await window.__createFixtureGame({
  seed,
  scenario,
});

window.__BENCH_BOOTSTRAP_ERROR = null;
try {
  await bootstrap();
} catch (error) {
  window.__BENCH_BOOTSTRAP_ERROR = String(error && error.stack ? error.stack : error);
  console.error("[bootstrap] failed:", error);
}

async function bootstrap() {
  const adaptersModule = await import("../../src/adapters/index.js");
  const { detectGame } = adaptersModule;

  let runtime = null;
  let directAdapter = null;

  if (adapterChoice !== "auto") {
    const ctor = {
      play2048: adaptersModule.Play2048Adapter,
      generic: adaptersModule.GenericAdapter,
      getmit: adaptersModule.GetMITAdapter,
    }[adapterChoice];
    if (!ctor) throw new Error(`unknown adapter choice: ${adapterChoice}`);
    directAdapter = new ctor();
  }

  if (layer === "bundle") {
    // Shim the extension APIs the content script expects, then load the
    // built bundle as a classic script. The shim controls where the WASM
    // loader is fetched from, so wasm=mock exercises the mock module through
    // the exact production code path (resolveAssetUrl + dynamic import()).
    const base = new URL("../../src/extension/", location.origin + location.pathname).href;
    window.chrome = {
      runtime: {
        getURL(path) {
          if (path.endsWith("solver.mjs") && wasmMode === "mock") {
            return new URL("../helpers/mock-solver.mjs", location.href).href;
          }
          return base + path;
        },
        onMessage: { addListener() {} },
      },
    };
    await loadClassicScript(new URL("../../src/extension/content.js", location.href).href);
    runtime = await waitFor(() => window.ai2048Runtime, 8000, "bundle runtime");
  } else {
    const { Runtime } = await import("../../src/runtime/runtime.js");
    const solverOptions = {};
    if (wasmMode === "mock") {
      solverOptions.moduleUrl = new URL("../helpers/mock-solver.mjs", location.href).href;
    } else if (wasmMode === "off") {
      solverOptions.disableWasm = true;
    }
    runtime = new Runtime({
      autoInit: false,
      enableHUD,
      // Headless determinism: the visibility handler is a shipped default but
      // irrelevant in the benchmark (pages are always visible).
      enableVisibilityHandling: false,
      enableMutationObserver: true,
      solver: solverOptions,
    });
    await runtime.init();
    if (directAdapter && !runtime.currentAdapter) {
      runtime.currentAdapter = directAdapter;
    }
  }

  // The runner needs an adapter even when no runtime exists yet.
  const activeAdapter = () =>
    (runtime && runtime.currentAdapter) || directAdapter || detectGame();

  if (autoStart && runtime) runtime.start();

  window.__BENCH__ = {
    ready: true,
    params: { seed, scenario, listenerLevel, keyProp, touchOnly, customListener, layer, wasmMode, adapterChoice },
    bootstrapError: window.__BENCH_BOOTSTRAP_ERROR,
    detectName() {
      const a = detectGame();
      return a ? a.getName() : null;
    },
    adapterName() {
      const a = activeAdapter();
      return a ? a.getName() : null;
    },
    adapterBoard() {
      const a = activeAdapter();
      return a ? a.readBoard() : null;
    },
    adapterScore() {
      const a = activeAdapter();
      return a ? a.getScore() : null;
    },
    adapterIsGameOver() {
      const a = activeAdapter();
      return a ? a.isGameOver() : null;
    },
    engineBoard: () => game.boardCopy(),
    engineScore: () => game.score,
    engineGameOver: () => game.gameOver,
    logs() {
      return {
        input: game.inputLog.map((e) => ({ ...e })),
        moves: game.moveLog.map((m) => ({ ...m, before: m.before, after: m.after })),
        ignoredKeydowns: game.ignoredKeydowns,
      };
    },
    runtime() {
      return runtime;
    },
    solverStatus() {
      return runtime && runtime.solverManager ? runtime.solverManager.getStatus() : null;
    },
    async timeMoveOrder() {
      const board = activeAdapter().readBoard();
      const mgr = runtime && runtime.solverManager;
      if (!mgr) return null;
      const t0 = performance.now();
      await mgr.getMoveOrder(board);
      return performance.now() - t0;
    },
    vanish() {
      game.detachBoardDom();
    },
    swap(newSeed) {
      game.replaceWithNewGame(newSeed || seed + 1000);
    },
  };

  // ---- input wiring ----------------------------------------------------

  const seenEvents = new WeakSet();

  function logAndMaybeApply(kind, event, dir) {
    if (!seenEvents.has(event)) {
      seenEvents.add(event);
      game.inputLog.push({
        kind,
        key: event.key,
        which: event.which,
        keyCode: event.keyCode,
        target: String(event.target && event.target.tagName).toLowerCase(),
        t: performance.now(),
      });
    }
    if (touchOnly && kind === "key") return null;
    if (dir === null || dir === undefined) return null;
    return kind === "key" ? game.handleKeydown(keyForEvent(event)) : game.handleSwipe(dir);
  }

  function keyForEvent(event) {
    // Mirrors real 2048 pages, which read different properties.
    if (keyProp === "which") return WHICH_TO_KEY[event.which] || null;
    if (keyProp === "keyCode") return WHICH_TO_KEY[event.keyCode] || null;
    return event.key; // "key"
  }

  const WHICH_TO_KEY = { 37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight", 40: "ArrowDown" };

  const keyHandler = (event) => logAndMaybeApply("key", event, KEY_DIR(event));

  function KEY_DIR(event) {
    const key = keyForEvent(event);
    if (key === "ArrowUp") return 0;
    if (key === "ArrowRight") return 1;
    if (key === "ArrowDown") return 2;
    if (key === "ArrowLeft") return 3;
    return null;
  }

  const elementTarget = document.querySelector("[data-game-input]") || document.body;

  if (listenerLevel === "window") window.addEventListener("keydown", keyHandler);
  else if (listenerLevel === "element") elementTarget.addEventListener("keydown", keyHandler);
  else document.addEventListener("keydown", keyHandler);

  // Instrumentation: count every physical keydown event once, regardless of
  // where it was dispatched or how many levels re-receive it via bubbling.
  const counter = (event) => {
    if (seenEvents.has(event)) return;
    seenEvents.add(event);
    game.inputLog.push({
      kind: "key",
      key: event.key,
      which: event.which,
      keyCode: event.keyCode,
      target: String(event.target && event.target.tagName).toLowerCase(),
      t: performance.now(),
      instrumentedOnly: true,
    });
  };
  document.addEventListener("keydown", counter, true);
  window.addEventListener("keydown", counter, true);

  if (!touchOnly) {
    // Pages that also accept touch swipes.
    let touchStart = null;
    const touchTarget = elementTarget;
    touchTarget.addEventListener(
      "touchstart",
      (e) => {
        touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      },
      { passive: true }
    );
    touchTarget.addEventListener("touchend", (e) => {
      if (!touchStart) return;
      const dx = e.changedTouches[0].clientX - touchStart.x;
      const dy = e.changedTouches[0].clientY - touchStart.y;
      touchStart = null;
      if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
      const dir =
        Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
      game.inputLog.push({ kind: "touch", dir, target: "fixture", t: performance.now() });
      game.handleSwipe(dir);
    });
  }

  if (customListener) {
    const container =
      document.querySelector("#game-container") ||
      document.querySelector(".game-container") ||
      document.body;
    container.addEventListener("move", (e) => {
      const names = ["up", "right", "down", "left"];
      const dir = names.indexOf(e.detail && e.detail.direction);
      if (dir < 0) return;
      game.inputLog.push({ kind: "custom", dir, target: "fixture", t: performance.now() });
      game.handleSwipe(dir);
    });
  }
}

function loadClassicScript(src) {
  return new Promise((resolveLoad, rejectLoad) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolveLoad;
    script.onerror = () => rejectLoad(new Error(`failed to load ${src}`));
    document.head.appendChild(script);
  });
}

function waitFor(getter, timeoutMs, label) {
  return new Promise((resolveWait, rejectWait) => {
    const started = Date.now();
    const poll = () => {
      const value = getter();
      if (value) {
        resolveWait(value);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        rejectWait(new Error(`timeout waiting for ${label}`));
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}
