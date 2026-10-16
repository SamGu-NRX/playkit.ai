/**
 * @fileoverview Observer system exports
 * Main entry point for change detection and visibility handling
 */

export {
  GameMutationObserver,
  createGameObserver,
} from "./mutation-observer.js";
export { DetectionWatcher } from "./detection-watcher.js";
export {
  VisibilityHandler,
  getVisibilityHandler,
  destroyVisibilityHandler,
} from "./visibility-handler.js";
