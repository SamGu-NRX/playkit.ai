/**
 * @fileoverview Simple test script for adapter system
 * Can be run in browser console to test adapter detection
 */

import { detectGame, isGameDetected, getDetectionInfo } from "./index.js";

/**
 * Test the adapter system on the current page
 */
export function testAdapterSystem() {
  console.log("=== Adapter System Test ===");

  // Test detection
  console.log("Testing game detection...");
  const isDetected = isGameDetected();
  console.log(`Game detected: ${isDetected}`);

  if (isDetected) {
    const adapter = detectGame();
    console.log(`Active adapter: ${adapter.getName()}`);

    // Test board reading
    console.log("Testing board reading...");
    const board = adapter.readBoard();
    if (board) {
      console.log("Board state:");
      console.table(board);

      // Test score reading
      const score = adapter.getScore();
      console.log(`Current score: ${score}`);

      // Test game over detection
      const gameOver = adapter.isGameOver();
      console.log(`Game over: ${gameOver}`);
    } else {
      console.log("Failed to read board");
    }
  }

  // Show all adapter info
  console.log("\n=== All Adapters ===");
  const adapterInfo = getDetectionInfo();
  console.table(adapterInfo);

  return {
    detected: isDetected,
    adapter: isDetected ? detectGame().getName() : null,
    allAdapters: adapterInfo,
  };
}

/**
 * Test move execution (use with caution on live games)
 * @param {number} direction Direction to test (0=Up, 1=Right, 2=Down, 3=Left)
 */
export function testMove(direction = 0) {
  console.log(`Testing move in direction ${direction}...`);

  const adapter = detectGame();
  if (!adapter) {
    console.log("No adapter detected");
    return false;
  }

  const boardBefore = adapter.readBoard();
  console.log("Board before move:");
  console.table(boardBefore);

  adapter.sendMove(direction);

  // Wait a bit then check board again
  setTimeout(() => {
    const boardAfter = adapter.readBoard();
    console.log("Board after move:");
    console.table(boardAfter);

    const changed = JSON.stringify(boardBefore) !== JSON.stringify(boardAfter);
    console.log(`Board changed: ${changed}`);
  }, 200);

  return true;
}

// Auto-run test when loaded in browser
if (typeof window !== "undefined") {
  // Make functions available globally for console testing
  window.testAdapterSystem = testAdapterSystem;
  window.testMove = testMove;

  console.log(
    "Adapter test functions loaded. Run testAdapterSystem() or testMove(direction) in console."
  );
}
