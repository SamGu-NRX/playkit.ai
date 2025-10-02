/**
 * @fileoverview Main entry point for 2048 AI Solver
 * Exports all major components and provides unified interface
 */

// Core systems
export * from "./adapters/index.js";
export * from "./hud/index.js";
export * from "./driver/index.js";
export * from "./observer/index.js";
export * from "./runtime/index.js";
export * from "./solver/index.js";

// Convenience re-exports for common use cases
export { detectGame, isGameDetected } from "./adapters/index.js";
export { initHUD, getHUD } from "./hud/index.js";
export { createDriver } from "./driver/index.js";
export { quickStart, initRuntime } from "./runtime/index.js";
