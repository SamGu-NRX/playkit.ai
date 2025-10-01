/**
 * @fileoverview Visibility change handler for pause/resume functionality
 * Manages automation state based on page visibility
 */

/**
 * Visibility handler for managing automation based on page visibility
 * Automatically pauses/resumes automation when page becomes hidden/visible
 */
export class VisibilityHandler {
  constructor(options = {}) {
    this.isEnabled = options.enabled !== false;
    this.pauseDelay = options.pauseDelay || 0; // Immediate pause
    this.resumeDelay = options.resumeDelay || 100; // Small delay on resume

    // State tracking
    this.isVisible = document.visibilityState === "visible";
    this.managedComponents = new Set();
    this.pauseTimer = null;
    this.resumeTimer = null;

    // Callbacks
    this.onVisibilityChange = null;
    this.onPause = null;
    this.onResume = null;

    // Bind methods
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);

    // Start listening
    this.startListening();
  }

  /**
   * Start listening for visibility changes
   */
  startListening() {
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    console.log("VisibilityHandler started");
  }

  /**
   * Stop listening for visibility changes
   */
  stopListening() {
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange
    );
    this.clearTimers();
    console.log("VisibilityHandler stopped");
  }

  /**
   * Add a component to be managed by visibility changes
   * Component should have pause() and resume() methods
   * @param {Object} component Component with pause/resume methods
   * @param {string} [name] Optional name for debugging
   */
  addManagedComponent(component, name = "unknown") {
    if (
      !component ||
      typeof component.pause !== "function" ||
      typeof component.resume !== "function"
    ) {
      throw new Error("Component must have pause() and resume() methods");
    }

    this.managedComponents.add({ component, name });
    console.log(`VisibilityHandler: Added managed component: ${name}`);

    // If page is currently hidden, pause the component
    if (!this.isVisible && this.isEnabled) {
      this.pauseComponent(component, name);
    }
  }

  /**
   * Remove a component from visibility management
   * @param {Object} component Component to remove
   */
  removeManagedComponent(component) {
    for (const item of this.managedComponents) {
      if (item.component === component) {
        this.managedComponents.delete(item);
        console.log(
          `VisibilityHandler: Removed managed component: ${item.name}`
        );
        break;
      }
    }
  }

  /**
   * Handle visibility change events
   * @private
   */
  handleVisibilityChange() {
    const wasVisible = this.isVisible;
    this.isVisible = document.visibilityState === "visible";

    if (!this.isEnabled) return;

    console.log(
      `VisibilityHandler: Page ${this.isVisible ? "visible" : "hidden"}`
    );

    // Clear any pending timers
    this.clearTimers();

    if (this.onVisibilityChange) {
      this.onVisibilityChange(this.isVisible, wasVisible);
    }

    if (this.isVisible && !wasVisible) {
      // Page became visible - resume components
      this.resumeTimer = setTimeout(() => {
        this.resumeAllComponents();
      }, this.resumeDelay);
    } else if (!this.isVisible && wasVisible) {
      // Page became hidden - pause components
      this.pauseTimer = setTimeout(() => {
        this.pauseAllComponents();
      }, this.pauseDelay);
    }
  }

  /**
   * Pause all managed components
   * @private
   */
  pauseAllComponents() {
    for (const { component, name } of this.managedComponents) {
      this.pauseComponent(component, name);
    }

    if (this.onPause) {
      this.onPause();
    }
  }

  /**
   * Resume all managed components
   * @private
   */
  resumeAllComponents() {
    for (const { component, name } of this.managedComponents) {
      this.resumeComponent(component, name);
    }

    if (this.onResume) {
      this.onResume();
    }
  }

  /**
   * Pause a specific component
   * @private
   * @param {Object} component Component to pause
   * @param {string} name Component name
   */
  pauseComponent(component, name) {
    try {
      if (typeof component.pause === "function") {
        component.pause();
        console.log(`VisibilityHandler: Paused ${name}`);
      }
    } catch (error) {
      console.warn(`VisibilityHandler: Error pausing ${name}:`, error);
    }
  }

  /**
   * Resume a specific component
   * @private
   * @param {Object} component Component to resume
   * @param {string} name Component name
   */
  resumeComponent(component, name) {
    try {
      if (typeof component.resume === "function") {
        component.resume();
        console.log(`VisibilityHandler: Resumed ${name}`);
      }
    } catch (error) {
      console.warn(`VisibilityHandler: Error resuming ${name}:`, error);
    }
  }

  /**
   * Clear pending timers
   * @private
   */
  clearTimers() {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  /**
   * Enable visibility handling
   */
  enable() {
    this.isEnabled = true;
    console.log("VisibilityHandler enabled");

    // If page is currently hidden, pause components
    if (!this.isVisible) {
      this.pauseAllComponents();
    }
  }

  /**
   * Disable visibility handling
   */
  disable() {
    this.isEnabled = false;
    this.clearTimers();
    console.log("VisibilityHandler disabled");
  }

  /**
   * Get current visibility state
   * @returns {boolean} True if page is visible
   */
  getVisibilityState() {
    return this.isVisible;
  }

  /**
   * Get handler statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      isEnabled: this.isEnabled,
      isVisible: this.isVisible,
      managedComponentCount: this.managedComponents.size,
      visibilityState: document.visibilityState,
    };
  }

  /**
   * Destroy handler and clean up
   */
  destroy() {
    this.stopListening();
    this.managedComponents.clear();
    this.onVisibilityChange = null;
    this.onPause = null;
    this.onResume = null;
  }
}

/**
 * Global visibility handler instance
 */
let globalVisibilityHandler = null;

/**
 * Get or create global visibility handler
 * @param {Object} options Handler options
 * @returns {VisibilityHandler} Handler instance
 */
export function getVisibilityHandler(options = {}) {
  if (!globalVisibilityHandler) {
    globalVisibilityHandler = new VisibilityHandler(options);
  }
  return globalVisibilityHandler;
}

/**
 * Destroy global visibility handler
 */
export function destroyVisibilityHandler() {
  if (globalVisibilityHandler) {
    globalVisibilityHandler.destroy();
    globalVisibilityHandler = null;
  }
}
