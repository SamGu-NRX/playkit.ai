/**
 * @fileoverview Content script entry point (MV3/WebExtension)
 * Entry point for browser extension content script
 */

import { initRuntime, getRuntime, destroyRuntime } from "./runtime.js";

/**
 * Content script main function
 * Initializes the 2048 AI Solver in extension context
 */
async function main() {
  try {
    // Check if we're in a valid context
    if (typeof chrome === "undefined" && typeof browser === "undefined") {
      console.warn("2048 AI Solver: Not running in extension context");
      return;
    }

    // Avoid double initialization
    if (getRuntime()) {
      console.log("2048 AI Solver: Already initialized");
      return;
    }

    console.log("2048 AI Solver: Initializing content script...");

    // Initialize runtime with extension-appropriate settings
    const runtime = await initRuntime({
      autoInit: false, // Don't auto-start in extension mode
      enableHUD: true,
      enableVisibilityHandling: true,
      enableMutationObserver: true,
    });

    console.log("2048 AI Solver: Content script initialized");

    // Set up extension messaging if available
    setupExtensionMessaging(runtime);

    // Make runtime available for debugging
    if (typeof window !== "undefined") {
      window.ai2048Runtime = runtime;
    }
  } catch (error) {
    console.error(
      "2048 AI Solver: Content script initialization failed:",
      error
    );
  }
}

/**
 * Set up messaging between content script and extension popup/background
 * @param {Runtime} runtime Runtime instance
 */
function setupExtensionMessaging(runtime) {
  const browserAPI = typeof chrome !== "undefined" ? chrome : browser;

  if (!browserAPI || !browserAPI.runtime) {
    console.warn("2048 AI Solver: Extension messaging not available");
    return;
  }

  // Listen for messages from popup or background script
  browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleExtensionMessage(runtime, message, sender, sendResponse);
    return true; // Keep message channel open for async responses
  });

  console.log("2048 AI Solver: Extension messaging set up");
}

/**
 * Handle messages from extension popup or background script
 * @param {Runtime} runtime Runtime instance
 * @param {Object} message Message object
 * @param {Object} sender Sender information
 * @param {Function} sendResponse Response callback
 */
async function handleExtensionMessage(runtime, message, sender, sendResponse) {
  try {
    switch (message.action) {
      case "detect":
        const detected = runtime.detectGame();
        sendResponse({
          success: true,
          detected,
          adapter: detected ? runtime.currentAdapter.getName() : null,
        });
        break;

      case "start":
        runtime.start();
        sendResponse({ success: true, message: "Started" });
        break;

      case "stop":
        runtime.stop();
        sendResponse({ success: true, message: "Stopped" });
        break;

      case "pause":
        runtime.pause();
        sendResponse({ success: true, message: "Paused" });
        break;

      case "resume":
        runtime.resume();
        sendResponse({ success: true, message: "Resumed" });
        break;

      case "step":
        const stepResult = await runtime.step();
        sendResponse({ success: true, stepResult });
        break;

      case "getStats":
        const stats = runtime.getStats();
        sendResponse({ success: true, stats });
        break;

      case "getAdapterInfo":
        const adapterInfo = runtime.currentAdapter
          ? {
              name: runtime.currentAdapter.getName(),
              board: runtime.currentAdapter.readBoard(),
              score: runtime.currentAdapter.getScore(),
              gameOver: runtime.currentAdapter.isGameOver(),
            }
          : null;
        sendResponse({ success: true, adapterInfo });
        break;

      default:
        sendResponse({
          success: false,
          error: "Unknown action: " + message.action,
        });
    }
  } catch (error) {
    console.error("2048 AI Solver: Message handling error:", error);
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Clean up when content script is unloaded
 */
function cleanup() {
  console.log("2048 AI Solver: Cleaning up content script...");
  destroyRuntime();
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", main);
} else {
  main();
}

// Clean up on page unload
window.addEventListener("beforeunload", cleanup);

// Export for potential external use
export { main as contentScriptMain };
