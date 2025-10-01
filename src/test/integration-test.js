/**
 * @fileoverview Integration test for the complete system
 * Can be run in browser console to test all components
 */

import { quickStart, getRuntime, destroyRuntime } from "../runtime/index.js";
import { detectGame, getDetectionInfo } from "../adapters/index.js";

/**
 * Run comprehensive integration test
 */
export async function runIntegrationTest() {
  console.log("=== 2048 AI Solver Integration Test ===");

  const results = {
    detection: null,
    runtime: null,
    hud: null,
    components: null,
    errors: [],
  };

  try {
    // Test 1: Game Detection
    console.log("\n1. Testing game detection...");
    const detectionInfo = getDetectionInfo();
    const gameDetected = detectGame();

    results.detection = {
      detected: !!gameDetected,
      adapter: gameDetected ? gameDetected.getName() : null,
      allAdapters: detectionInfo,
    };

    console.log(`Game detected: ${results.detection.detected}`);
    if (results.detection.detected) {
      console.log(`Active adapter: ${results.detection.adapter}`);
    }
    console.table(detectionInfo);

    // Test 2: Runtime Initialization
    console.log("\n2. Testing runtime initialization...");
    const runtime = await quickStart({
      autoInit: false, // Don't auto-start for testing
      enableHUD: true,
      enableVisibilityHandling: true,
      enableMutationObserver: true,
    });

    results.runtime = {
      initialized: runtime.isInitialized,
      stats: runtime.getStats(),
    };

    console.log("Runtime initialized:", results.runtime.initialized);
    console.log("Runtime stats:", results.runtime.stats);

    // Test 3: HUD Functionality
    console.log("\n3. Testing HUD...");
    results.hud = {
      present: !!runtime.hud,
      visible: runtime.hud ? !runtime.hud.isCollapsed : false,
    };

    console.log("HUD present:", results.hud.present);

    // Test 4: Component Integration
    console.log("\n4. Testing component integration...");
    if (gameDetected) {
      try {
        // Test single step
        const stepResult = await runtime.step();
        console.log("Step test result:", stepResult);

        // Test board reading
        const board = gameDetected.readBoard();
        console.log("Board reading test:");
        console.table(board);

        results.components = {
          stepWorked: stepResult,
          boardReadable: !!board,
          driverPresent: !!runtime.driver,
          observerPresent: !!runtime.observer,
        };
      } catch (error) {
        results.errors.push(`Component test error: ${error.message}`);
      }
    } else {
      results.components = {
        stepWorked: false,
        boardReadable: false,
        driverPresent: false,
        observerPresent: false,
        note: "No game detected for component testing",
      };
    }

    console.log("Component test results:", results.components);

    // Test 5: Cleanup
    console.log("\n5. Testing cleanup...");
    destroyRuntime();
    const cleanupRuntime = getRuntime();

    console.log("Cleanup successful:", !cleanupRuntime);
  } catch (error) {
    console.error("Integration test error:", error);
    results.errors.push(`Test error: ${error.message}`);
  }

  // Summary
  console.log("\n=== Test Summary ===");
  console.log("Detection:", results.detection?.detected ? "✅" : "❌");
  console.log("Runtime:", results.runtime?.initialized ? "✅" : "❌");
  console.log("HUD:", results.hud?.present ? "✅" : "❌");
  console.log("Components:", results.components?.driverPresent ? "✅" : "❌");
  console.log(
    "Errors:",
    results.errors.length === 0 ? "✅" : `❌ (${results.errors.length})`
  );

  if (results.errors.length > 0) {
    console.log("\nErrors encountered:");
    results.errors.forEach((error) => console.log(`- ${error}`));
  }

  return results;
}

/**
 * Quick test for basic functionality
 */
export function quickTest() {
  console.log("=== Quick Test ===");

  // Test detection
  const detected = detectGame();
  console.log(`Game detected: ${!!detected}`);

  if (detected) {
    console.log(`Adapter: ${detected.getName()}`);

    // Test board reading
    const board = detected.readBoard();
    if (board) {
      console.log("Board:");
      console.table(board);
    }

    // Test score reading
    const score = detected.getScore();
    console.log(`Score: ${score}`);
  }

  // Show all adapter info
  const info = getDetectionInfo();
  console.table(info);

  return { detected: !!detected, adapter: detected?.getName() };
}

// Auto-run quick test when loaded in browser
if (typeof window !== "undefined") {
  window.testAI2048 = runIntegrationTest;
  window.quickTestAI2048 = quickTest;

  console.log("Test functions loaded:");
  console.log("- runIntegrationTest() - Full system test");
  console.log("- quickTest() - Quick detection test");
}
