/**
 * @fileoverview Runtime system exports
 * Main entry point for the shared runtime system
 */

export {
  Runtime,
  initRuntime,
  getRuntime,
  destroyRuntime,
  quickStart,
} from "./runtime.js";
export { bookmarkletMain } from "./bookmarklet.js";
export { contentScriptMain } from "./content-script.js";
