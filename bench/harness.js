/**
 * Benchmark harness — drives fixture pages in same-origin iframes and
 * collects structured evidence. No UI; runner.html imports this.
 */

const WAIT_READY_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 100;

export const SCENARIOS = [
  { id: "input-play2048", fixture: "play2048-style.html", params: {}, presses: 5 },
  { id: "input-play2048-which", fixture: "play2048-style.html", params: { keyProp: "which" }, presses: 5 },
  { id: "input-play2048-keycode", fixture: "play2048-style.html", params: { keyProp: "keyCode" }, presses: 5 },
  { id: "input-generic", fixture: "generic-grid.html", params: {}, presses: 5 },
  { id: "input-getmit", fixture: "getmit-style.html", params: { customListener: "1" }, presses: 5 },
  { id: "touch-generic", fixture: "generic-grid.html", params: { touchOnly: "1" }, touches: 5 },
  { id: "late-play2048", fixture: "play2048-style.html", params: { scenario: "late" }, presses: 5 },
  { id: "autostart-generic-late", fixture: "generic-grid.html", params: { scenario: "late" }, autostartMs: 8000 },
  { id: "gameover-generic", fixture: "generic-grid.html", params: { scenario: "gameover" }, autostartMs: 3000 },
  { id: "vanish-play2048", fixture: "play2048-style.html", params: {}, vanish: true, pressesBefore: 5, pressesAfter: 5 },
  { id: "swap-generic", fixture: "generic-grid.html", params: { scenario: "swap" }, swap: true, pressesBefore: 5, pressesAfter: 5 },
  { id: "wasm-missing-play2048", fixture: "play2048-style.html", params: { wasm: "missing" }, presses: 5 },
  { id: "wasm-mock-play2048", fixture: "play2048-style.html", params: { wasm: "mock" }, presses: 5 },
  { id: "bundle-play2048", fixture: "play2048-style.html", params: { layer: "bundle" }, presses: 5 },
  { id: "bundle-wasm-mock-play2048", fixture: "play2048-style.html", params: { layer: "bundle", wasm: "mock" }, presses: 5 },
  { id: "adapter-getmit-direct", fixture: "getmit-style.html", params: { adapter: "getmit", customListener: "1" }, presses: 5 },
];

const KEY_FOR_DIR = ["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"];

export async function runScenario(spec, { onStatus } = {}) {
  const started = performance.now();
  const result = {
    id: spec.id,
    fixture: spec.fixture,
    params: spec.params || {},
    ok: false,
    error: null,
    notes: [],
    metrics: {},
  };
  const report = (note) => {
    result.notes.push(note);
    if (onStatus) onStatus(`${spec.id}: ${note}`);
  };

  let iframe = null;
  try {
    iframe = await loadFixture(spec);
    const bench = iframe.contentWindow.__BENCH__;
    if (!bench || !bench.ready) throw new Error("fixture did not report ready");
    if (bench.bootstrapError) throw new Error(`bootstrap failed: ${bench.bootstrapError}`);

    result.metrics.detectName = bench.detectName();
    result.metrics.adapterName = bench.adapterName();
    report(`detect=${result.metrics.detectName} adapter=${result.metrics.adapterName}`);

    const sendKeyboard = (dir) => dispatchKeyboard(iframe, KEY_FOR_DIR[dir]);
    const sendTouch = async (dir) => {
      const sent = dispatchTouchSwipe(iframe, dir);
      if (!sent) result.notes.push("TouchEvent unsupported in this browser");
    };

    const snapshot = () => ({
      engineBoard: bench.engineBoard(),
      engineScore: bench.engineScore(),
      engineGameOver: bench.engineGameOver(),
      adapterBoard: bench.adapterBoard(),
      adapterScore: bench.adapterScore(),
      adapterIsGameOver: bench.adapterIsGameOver(),
      inputCount: bench.logs().input.length,
      moveCount: bench.logs().moves.length,
      ignoredKeydowns: bench.logs().ignoredKeydowns,
      solverStatus: bench.solverStatus(),
    });

    if (spec.presses) {
      for (let i = 0; i < spec.presses; i++) {
        sendKeyboard(2); // down
        await sleep(60);
      }
      await settle(400);
      const s = snapshot();
      result.metrics.afterPresses = s;
      result.metrics.parity = boardsMatch(s.engineBoard, s.adapterBoard);
      result.metrics.inputToMoveRatio = s.moveCount / Math.max(1, s.inputCount);
      report(
        `presses=${spec.presses} inputEntries=${s.inputCount} moves=${s.moveCount} parity=${result.metrics.parity}`
      );
    }

    if (spec.touches) {
      for (let i = 0; i < spec.touches; i++) {
        await sendTouch(i % 4);
        await sleep(80);
      }
      await settle(400);
      const s = snapshot();
      result.metrics.afterTouches = s;
      result.metrics.parity = boardsMatch(s.engineBoard, s.adapterBoard);
      report(`touches=${spec.touches} inputEntries=${s.inputCount} moves=${s.moveCount}`);
    }

    if (spec.vanish) {
      for (let i = 0; i < spec.pressesBefore; i++) {
        sendKeyboard(1); // right
        await sleep(60);
      }
      await settle(400);
      result.metrics.beforeVanish = snapshot();
      bench.vanish();
      await settle(200);
      for (let i = 0; i < spec.pressesAfter; i++) {
        sendKeyboard(1);
        await sleep(60);
      }
      await settle(400);
      const s = snapshot();
      result.metrics.afterVanish = s;
      result.metrics.parity = boardsMatch(s.engineBoard, s.adapterBoard);
      report(
        `vanish: before moves=${result.metrics.beforeVanish.moveCount} after moves=${s.moveCount} parity=${result.metrics.parity} adapterBoard=${JSON.stringify(s.adapterBoard)}`
      );
    }

    if (spec.swap) {
      for (let i = 0; i < spec.pressesBefore; i++) {
        sendKeyboard(0); // up
        await sleep(60);
      }
      await settle(400);
      result.metrics.beforeSwap = snapshot();
      bench.swap(4242);
      await settle(600);
      for (let i = 0; i < spec.pressesAfter; i++) {
        sendKeyboard(0);
        await sleep(60);
      }
      await settle(400);
      const s = snapshot();
      result.metrics.afterSwap = s;
      result.metrics.parity = boardsMatch(s.engineBoard, s.adapterBoard);
      result.metrics.detectAfterSwap = bench.detectName();
      report(
        `swap: detectAfter=${result.metrics.detectAfterSwap} movesAfter=${s.moveCount} parity=${result.metrics.parity}`
      );
    }

    if (spec.autostartMs) {
      const runtime = bench.runtime();
      if (!runtime) throw new Error("no runtime for autostart scenario");
      runtime.start();
      await settle(spec.autostartMs);
      runtime.stop();
      await settle(300);
      const s = snapshot();
      result.metrics.afterAutostart = s;
      result.metrics.parity = boardsMatch(s.engineBoard, s.adapterBoard);
      result.metrics.driverPressedWhileDead = s.engineGameOver === true ? s.inputCount : null;
      report(
        `autostart: moves=${s.moveCount} ignored=${s.ignoredKeydowns} gameOver=${s.engineGameOver} parity=${result.metrics.parity}`
      );
    }

    // Solver latency probe on the final board state.
    try {
      const moveOrderMs = await bench.timeMoveOrder();
      if (moveOrderMs !== null) {
        result.metrics.moveOrderMs = Number(moveOrderMs.toFixed(2));
        report(`getMoveOrder=${result.metrics.moveOrderMs}ms`);
      }
    } catch (error) {
      result.metrics.moveOrderError = String(error && error.message);
      report(`getMoveOrder failed: ${result.metrics.moveOrderError}`);
    }

    result.metrics.totalMs = Number((performance.now() - started).toFixed(0));
    result.ok = true;
  } catch (error) {
    result.error = String(error && error.stack ? error.stack : error);
  } finally {
    if (iframe) iframe.remove();
  }
  return result;
}

async function loadFixture(spec) {
  const url = new URL(`./fixtures/${spec.fixture}`, window.location.href);
  for (const [key, value] of Object.entries(spec.params || {})) {
    url.searchParams.set(key, value);
  }
  const iframe = document.createElement("iframe");
  iframe.src = url.href;
  iframe.style.cssText = "position:absolute;left:-10000px;width:900px;height:700px;";
  const readyPromise = new Promise((resolveReady, rejectReady) => {
    const started = Date.now();
    const poll = () => {
      const bench =
        iframe.contentWindow && iframe.contentWindow.__BENCH__
          ? iframe.contentWindow.__BENCH__
          : null;
      if (bench && bench.ready) {
        resolveReady();
        return;
      }
      const bootError = iframe.contentWindow && iframe.contentWindow.__BENCH_BOOTSTRAP_ERROR;
      if (bootError) {
        rejectReady(new Error(bootError));
        return;
      }
      if (Date.now() - started > WAIT_READY_TIMEOUT_MS) {
        rejectReady(new Error(`fixture not ready after ${WAIT_READY_TIMEOUT_MS}ms`));
        return;
      }
      setTimeout(poll, POLL_INTERVAL_MS);
    };
    iframe.addEventListener("load", () => setTimeout(poll, 150));
  });
  document.body.appendChild(iframe);
  await readyPromise;
  return iframe;
}

function dispatchKeyboard(iframe, key) {
  const doc = iframe.contentDocument;
  const target = doc.body;
  const event = new iframe.contentWindow.KeyboardEvent("keydown", {
    key,
    code: key === "ArrowDown" ? "ArrowDown" : key,
    bubbles: true,
    cancelable: true,
  });
  // Mirror what driver.js dispatches; event.which/keyCode are read-only on
  // constructed events, so keyProp=which/keyCode fixtures rely on the
  // Chrome-mapped defaults for arrow keys.
  target.dispatchEvent(event);
}

function dispatchTouchSwipe(iframe, dir) {
  const win = iframe.contentWindow;
  if (typeof win.TouchEvent === "undefined" || typeof win.Touch === "undefined") {
    return false;
  }
  const doc = iframe.contentDocument;
  const target = doc.querySelector("[data-game-input]") || doc.body;
  const origin = { x: 300, y: 300 };
  const delta = { 0: [0, -80], 1: [80, 0], 2: [0, 80], 3: [-80, 0] }[dir];
  try {
    const start = new win.Touch({ identifier: 1, target, clientX: origin.x, clientY: origin.y });
    const end = new win.Touch({
      identifier: 1,
      target,
      clientX: origin.x + delta[0],
      clientY: origin.y + delta[1],
    });
    target.dispatchEvent(
      new win.TouchEvent("touchstart", { touches: [start], bubbles: true, cancelable: true })
    );
    target.dispatchEvent(
      new win.TouchEvent("touchend", { changedTouches: [end], bubbles: true, cancelable: true })
    );
    return true;
  } catch (error) {
    return false;
  }
}

function boardsMatch(a, b) {
  if (!a || !b) return false;
  const flatA = Array.isArray(a[0]) ? a.flat() : a;
  const flatB = Array.isArray(b[0]) ? b.flat() : b;
  return JSON.stringify(flatA) === JSON.stringify(flatB);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function settle(ms) {
  await sleep(ms);
}
