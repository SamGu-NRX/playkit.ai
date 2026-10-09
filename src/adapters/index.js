/**
 * @fileoverview Adapter system exports
 * Main entry point for the game detection and adapter system
 */

// Base adapter interface and utilities
export { Adapter, Direction, BoardUtils } from "./adapter.js";

// Specific adapter implementations
export { Play2048Adapter } from "./play2048-adapter.js";
export { GenericAdapter } from "./generic-adapter.js";
export { GetMITAdapter } from "./getmit-adapter.js";

// Registry system.
// FIX-8 (bench finding): index.js previously only re-exported
// globalAdapterRegistry; detectGame()/getDetectionInfo() below referenced the
// bare identifier, which is undefined in module scope outside the bundler
// (ReferenceError in every direct ESM consumer, e.g. Runtime.init).
import { AdapterRegistry, globalAdapterRegistry } from "./adapter-registry.js";
export { AdapterRegistry, globalAdapterRegistry };

/**
 * Convenience function to detect and get the best adapter for current page
 * @returns {Adapter|null} Best matching adapter or null
 */
export function detectGame() {
  return globalAdapterRegistry.detectAdapter();
}

/**
 * Convenience function to test if any game is detected on current page
 * @returns {boolean} True if a game is detected
 */
export function isGameDetected() {
  const adapter = detectGame();
  return adapter !== null;
}

/**
 * Get detailed information about adapter detection
 * @returns {Array} Array of adapter test results
 */
export function getDetectionInfo() {
  return globalAdapterRegistry.testAllAdapters();
}
