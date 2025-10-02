/**
 * @fileoverview Presentation layer for the HUD overlay
 */

import { getHUDHTML } from "./templates.js";

const COLLAPSE_ICON = {
  COLLAPSED: "+",
  EXPANDED: "−",
};

/**
 * Encapsulates the DOM management for the HUD overlay so controller logic can
 * remain focused on behaviour instead of markup manipulation.
 */
export class HUDView {
  constructor(callbacks = {}) {
    this.callbacks = {
      onDetect: callbacks.onDetect || null,
      onAutoSolve: callbacks.onAutoSolve || null,
      onStep: callbacks.onStep || null,
      onCollapse: callbacks.onCollapse || null,
      onDirectionPriorityChange: callbacks.onDirectionPriorityChange || null,
      onSolverControlChange: callbacks.onSolverControlChange || null,
    };

    this.shadowHost = null;
    this.shadowRoot = null;
    this.panel = null;

    this.elements = {
      status: null,
      gameStatus: null,
      scoreStatus: null,
      detectBtn: null,
      autoSolveBtn: null,
      stepBtn: null,
      collapseBtn: null,
      collapseIcon: null,
      directionSelect: null,
      solverStrategy: null,
      solverHeuristic: null,
      solverDepth: null,
      solverProbability: null,
    };

    this.isCollapsed = false;
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this._suppressSolverEvents = false;

    this.boundHandlers = {
      headerMouseDown: this.handleHeaderMouseDown.bind(this),
      documentMouseMove: this.handleDocumentMouseMove.bind(this),
      documentMouseUp: this.handleDocumentMouseUp.bind(this),
      detectClick: this.forwardCallback("onDetect"),
      autoSolveClick: this.forwardCallback("onAutoSolve"),
      stepClick: this.forwardCallback("onStep"),
      collapseClick: this.handleCollapseClick.bind(this),
      directionChange: this.handleDirectionChange.bind(this),
      solverControlChange: this.handleSolverControlChange.bind(this),
    };
  }

  /**
   * Inject HUD markup inside a new shadow root and wire listeners.
   */
  mount() {
    if (this.shadowHost) {
      console.warn("HUDView: mount called twice");
      return;
    }

    this.shadowHost = document.createElement("div");
    this.shadowHost.id = "ai-2048-solver-hud";
    this.shadowRoot = this.shadowHost.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = getHUDHTML();

    this.panel = this.shadowRoot.querySelector(".hud-panel");

    document.body.appendChild(this.shadowHost);

    this.cacheElements();
    this.attachEventListeners();
    this.position(window.innerWidth - 320, 20);
  }

  /**
   * Remove event listeners and DOM nodes.
   */
  destroy() {
    if (!this.shadowHost) {
      return;
    }

    this.detachEventListeners();

    if (this.shadowHost.parentNode) {
      this.shadowHost.parentNode.removeChild(this.shadowHost);
    }

    this.shadowHost = null;
    this.shadowRoot = null;
    this.panel = null;
  }

  /**
   * Cache frequently accessed elements for quick updates.
   */
  cacheElements() {
    if (!this.shadowRoot) {
      return;
    }

    this.elements = {
      status: this.shadowRoot.getElementById("solver-status"),
      gameStatus: this.shadowRoot.getElementById("game-status"),
      scoreStatus: this.shadowRoot.getElementById("score-status"),
      detectBtn: this.shadowRoot.getElementById("detect-btn"),
      autoSolveBtn: this.shadowRoot.getElementById("auto-solve-btn"),
      stepBtn: this.shadowRoot.getElementById("step-btn"),
      collapseBtn: this.shadowRoot.querySelector(".hud-btn-collapse"),
      collapseIcon: this.shadowRoot.querySelector(".collapse-icon"),
      directionSelect: this.shadowRoot.getElementById("direction-priority"),
      solverStrategy: this.shadowRoot.getElementById("solver-strategy"),
      solverHeuristic: this.shadowRoot.getElementById("solver-heuristic"),
      solverDepth: this.shadowRoot.getElementById("solver-depth"),
      solverProbability: this.shadowRoot.getElementById("solver-probability"),
    };
  }

  /**
   * Attach DOM event listeners for interactivity.
   */
  attachEventListeners() {
    if (!this.shadowRoot || !this.panel) {
      return;
    }

    const header = this.shadowRoot.querySelector(".hud-header");
    header?.addEventListener("mousedown", this.boundHandlers.headerMouseDown);

    document.addEventListener("mousemove", this.boundHandlers.documentMouseMove);
    document.addEventListener("mouseup", this.boundHandlers.documentMouseUp);

    this.elements.detectBtn?.addEventListener("click", this.boundHandlers.detectClick);
    this.elements.autoSolveBtn?.addEventListener(
      "click",
      this.boundHandlers.autoSolveClick,
    );
    this.elements.stepBtn?.addEventListener("click", this.boundHandlers.stepClick);
    this.elements.collapseBtn?.addEventListener("click", this.boundHandlers.collapseClick);
    this.elements.directionSelect?.addEventListener(
      "change",
      this.boundHandlers.directionChange,
    );

    const solverControls = [
      this.elements.solverStrategy,
      this.elements.solverHeuristic,
      this.elements.solverDepth,
      this.elements.solverProbability,
    ].filter(Boolean);

    solverControls.forEach((control) => {
      control.addEventListener("change", this.boundHandlers.solverControlChange);
    });
  }

  /**
   * Remove listeners. Used during destroy() and when remounting.
   */
  detachEventListeners() {
    if (!this.shadowRoot) {
      return;
    }

    const header = this.shadowRoot.querySelector(".hud-header");
    header?.removeEventListener("mousedown", this.boundHandlers.headerMouseDown);

    document.removeEventListener("mousemove", this.boundHandlers.documentMouseMove);
    document.removeEventListener("mouseup", this.boundHandlers.documentMouseUp);

    this.elements.detectBtn?.removeEventListener("click", this.boundHandlers.detectClick);
    this.elements.autoSolveBtn?.removeEventListener(
      "click",
      this.boundHandlers.autoSolveClick,
    );
    this.elements.stepBtn?.removeEventListener("click", this.boundHandlers.stepClick);
    this.elements.collapseBtn?.removeEventListener(
      "click",
      this.boundHandlers.collapseClick,
    );
    this.elements.directionSelect?.removeEventListener(
      "change",
      this.boundHandlers.directionChange,
    );

    const solverControls = [
      this.elements.solverStrategy,
      this.elements.solverHeuristic,
      this.elements.solverDepth,
      this.elements.solverProbability,
    ].filter(Boolean);

    solverControls.forEach((control) => {
      control.removeEventListener("change", this.boundHandlers.solverControlChange);
    });
  }

  /**
   * Proxy helper that calls a stored callback when available.
   * @private
   */
  forwardCallback(key) {
    return (event) => {
      const cb = this.callbacks[key];
      if (typeof cb === "function") {
        cb(event);
      }
    };
  }

  /**
   * Handle drag start from the HUD header.
   * @param {MouseEvent} event
   * @private
   */
  handleHeaderMouseDown(event) {
    if (event.target.closest(".hud-btn")) {
      return;
    }

    if (!this.panel) {
      return;
    }

    this.isDragging = true;
    this.panel.classList.add("dragging");

    const rect = this.panel.getBoundingClientRect();
    this.dragOffset.x = event.clientX - rect.left;
    this.dragOffset.y = event.clientY - rect.top;

    event.preventDefault();
  }

  /**
   * Handle mouse move while dragging.
   * @param {MouseEvent} event
   * @private
   */
  handleDocumentMouseMove(event) {
    if (!this.isDragging) {
      return;
    }

    const x = event.clientX - this.dragOffset.x;
    const y = event.clientY - this.dragOffset.y;
    this.position(x, y);
  }

  /**
   * Handle mouse up to finish dragging.
   * @private
   */
  handleDocumentMouseUp() {
    if (!this.isDragging || !this.panel) {
      return;
    }

    this.isDragging = false;
    this.panel.classList.remove("dragging");
  }

  /**
   * Toggle collapse/expand state while updating the icon.
   * @private
   */
  handleCollapseClick() {
    this.isCollapsed = !this.isCollapsed;
    this.panel?.setAttribute("data-collapsed", String(this.isCollapsed));

    if (this.elements.collapseIcon) {
      this.elements.collapseIcon.textContent = this.isCollapsed
        ? COLLAPSE_ICON.COLLAPSED
        : COLLAPSE_ICON.EXPANDED;
    }

    if (typeof this.callbacks.onCollapse === "function") {
      this.callbacks.onCollapse(this.isCollapsed);
    }
  }

  /**
   * Handle direction priority selector updates.
   * @param {Event} event
   * @private
   */
  handleDirectionChange(event) {
    const value = event?.target?.value;
    if (!value) {
      return;
    }

    const priorities = value.split(",").map(Number).filter((n) => !Number.isNaN(n));

    if (typeof this.callbacks.onDirectionPriorityChange === "function") {
      this.callbacks.onDirectionPriorityChange(priorities);
    }
  }

  /**
   * Bridge solver control events back to the controller layer.
   * @private
   */
  handleSolverControlChange() {
    if (this._suppressSolverEvents) {
      return;
    }

    if (typeof this.callbacks.onSolverControlChange !== "function") {
      return;
    }

    this.callbacks.onSolverControlChange(this.getSolverControlValues());
  }

  /**
   * Return the currently selected solver configuration from the UI.
   * @returns {{type:string, heuristic:string, depth:number, probability:number}}
   */
  getSolverControlValues() {
    return {
      type: this.elements.solverStrategy?.value || "expectimax-depth",
      heuristic: this.elements.solverHeuristic?.value || "corner",
      depth: parseInt(this.elements.solverDepth?.value, 10) || 4,
      probability: parseFloat(this.elements.solverProbability?.value) || 0.0025,
    };
  }

  /**
   * Synchronise solver control inputs without triggering change events.
   * @param {{type:string, heuristic:string, depth:number, probability:number}} config
   */
  setSolverControlValues(config) {
    this._suppressSolverEvents = true;

    if (this.elements.solverStrategy) {
      this.elements.solverStrategy.value = config.type;
    }

    if (this.elements.solverHeuristic) {
      this.elements.solverHeuristic.value = config.heuristic;
    }

    if (this.elements.solverDepth) {
      this.elements.solverDepth.value = String(config.depth);
    }

    if (this.elements.solverProbability) {
      this.elements.solverProbability.value = String(config.probability);
    }

    this._suppressSolverEvents = false;
  }

  /**
   * Enable or disable solver input fields as needed for the current mode.
   * @param {boolean} depthEnabled
   * @param {boolean} probabilityEnabled
   */
  setSolverControlAvailability(depthEnabled, probabilityEnabled) {
    if (this.elements.solverDepth) {
      this.elements.solverDepth.disabled = !depthEnabled;
    }

    if (this.elements.solverProbability) {
      this.elements.solverProbability.disabled = !probabilityEnabled;
    }
  }

  /**
   * Update the solver status indicator text and colour.
   * @param {{text:string, color:string, title:string}} status
   */
  setSolverStatus(status) {
    if (!this.elements.status) {
      return;
    }

    this.elements.status.textContent = status.text;
    this.elements.status.style.color = status.color;
    this.elements.status.title = status.title;
  }

  /**
   * Update game detection message and colour indicator.
   * @param {{text:string, color:string}}
   */
  setGameStatus({ text, color }) {
    if (!this.elements.gameStatus) {
      return;
    }

    this.elements.gameStatus.textContent = text;
    this.elements.gameStatus.style.color = color;
  }

  /**
   * Show latest score value.
   * @param {string} scoreText
   */
  setScore(scoreText) {
    if (this.elements.scoreStatus) {
      this.elements.scoreStatus.textContent = scoreText;
    }
  }

  /**
   * Enable or disable the key control buttons.
   * @param {{autoSolve:boolean, step:boolean}}
   */
  setControlsEnabled({ autoSolve, step }) {
    if (this.elements.autoSolveBtn) {
      this.elements.autoSolveBtn.disabled = !autoSolve;
    }

    if (this.elements.stepBtn) {
      this.elements.stepBtn.disabled = !step;
    }
  }

  /**
   * Reflect whether auto solving is running on the button and panel.
   * @param {boolean} isRunning
   */
  setAutoSolveRunning(isRunning) {
    if (this.panel) {
      this.panel.classList.toggle("auto-solving", Boolean(isRunning));
    }

    if (this.elements.autoSolveBtn) {
      this.elements.autoSolveBtn.textContent = isRunning ? "⏸️ Pause" : "▶️ Auto-solve";
    }
  }

  /**
   * Update the selected direction priority option.
   * @param {number[]} priorities
   */
  setDirectionPriority(priorities) {
    if (!this.elements.directionSelect) {
      return;
    }

    const value = priorities.join(",");
    this.elements.directionSelect.value = value;
  }

  /**
   * Position the HUD within the viewport, clamped to visible area.
   * @param {number} x
   * @param {number} y
   */
  position(x, y) {
    if (!this.panel) {
      return;
    }

    const rect = this.panel.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width;
    const maxY = window.innerHeight - rect.height;

    const clampedX = Math.max(0, Math.min(x, maxX));
    const clampedY = Math.max(0, Math.min(y, maxY));

    this.panel.style.left = `${clampedX}px`;
    this.panel.style.top = `${clampedY}px`;
  }

  /**
   * Show a temporary toast-like message centred on the screen.
   * @param {string} message
   */
  showMessage(message) {
    const messageEl = document.createElement("div");
    messageEl.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(0, 0, 0, 0.9);
      color: white;
      padding: 12px 20px;
      border-radius: 6px;
      z-index: 2147483648;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      pointer-events: none;
    `;
    messageEl.textContent = message;

    document.body.appendChild(messageEl);

    setTimeout(() => {
      if (messageEl.parentNode) {
        messageEl.parentNode.removeChild(messageEl);
      }
    }, 2000);
  }
}
