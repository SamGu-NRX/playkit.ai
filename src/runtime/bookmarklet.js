/**
 * @fileoverview Bookmarklet entry point (IIFE)
 * Self-contained bundle for bookmarklet usage
 */

import { quickStart, getRuntime, destroyRuntime } from "./runtime.js";

/**
 * Bookmarklet main function
 * Creates or toggles the 2048 AI Solver
 */
async function main() {
  try {
    // Check if runtime already exists
    const existingRuntime = getRuntime();

    if (existingRuntime) {
      // Toggle existing runtime
      if (existingRuntime.isRunning) {
        existingRuntime.stop();
        console.log("2048 AI Solver stopped");
      } else {
        existingRuntime.start();
        console.log("2048 AI Solver started");
      }
      return;
    }

    // Create new runtime
    console.log("Loading 2048 AI Solver...");

    const runtime = await quickStart({
      autoInit: true,
      enableHUD: true,
      enableVisibilityHandling: true,
      enableMutationObserver: true,
    });

    console.log("2048 AI Solver loaded successfully!");

    // Make runtime available globally for debugging
    if (typeof window !== "undefined") {
      window.ai2048Runtime = runtime;
      window.ai2048 = {
        start: () => runtime.start(),
        stop: () => runtime.stop(),
        pause: () => runtime.pause(),
        resume: () => runtime.resume(),
        step: () => runtime.step(),
        stats: () => runtime.getStats(),
        destroy: () => destroyRuntime(),
      };

      console.log("Global controls available: window.ai2048");
    }
  } catch (error) {
    console.error("Failed to load 2048 AI Solver:", error);

    // Show user-friendly error message
    const errorMsg = document.createElement("div");
    errorMsg.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(220, 38, 38, 0.95);
      color: white;
      padding: 20px;
      border-radius: 8px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      max-width: 400px;
      text-align: center;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    `;
    errorMsg.innerHTML = `
      <strong>2048 AI Solver Error</strong><br>
      ${error.message}<br><br>
      <small>Check console for details</small>
    `;

    document.body.appendChild(errorMsg);

    setTimeout(() => {
      if (errorMsg.parentNode) {
        errorMsg.parentNode.removeChild(errorMsg);
      }
    }, 5000);
  }
}

// Auto-run when loaded
main();

// Export for potential external use
export { main as bookmarkletMain };
