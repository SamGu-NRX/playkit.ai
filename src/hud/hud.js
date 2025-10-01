/**
 * @fileoverview Shadow DOM HUD overlay for 2048 solver
 * Implements draggable, collapsible HUD panel with game controls
 */

import { detectGame, Direction } from "../adapters/index.js";

/**
 * HUD overlay clareates a Shadow DOM panel
 * Provides controls for game detection and automation
 */
export class HUD {
  constructor() {
    this.shadowHost = null;
    this.shadowRoot = null;
    this.hudElement = null;
    this.isCollapsed = false;
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.currentAdapter = null;
    this.isAutoSolving = false;
    this.autoSolveTimeout = null;
    this.controller = null;
    this.directionPriority = [
      Direction.LEFT,
      Direction.DOWN,
      Direction.RIGHT,
      Direction.UP,
    ];

    // Bind methods for event handlers
    this.handleMouseDown = this.handleMouseDown.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleMouseUp = this.handleMouseUp.bind(this);
    this.handleDetectClick = this.handleDetectClick.bind(this);
    this.handleAutoSolveClick = this.handleAutoSolveClick.bind(this);
    this.handleStepClick = this.handleStepClick.bind(this);
    this.handleCollapseClick = this.handleCollapseClick.bind(this);
  }

  /**
   * Initialize and inject the HUD into the page
   */
  init() {
    if (this.shadowHost) {
      console.warn("HUD already initialized");
      return;
    }

    this.createShadowDOM();
    this.attachEventListeners();
    this.updateStatus();

    console.log("HUD initialized");
  }

  /**
   * Create Shadow DOM structure and inject into page
   * @private
   */
  createShadowDOM() {
    // Create shadow host element
    this.shadowHost = document.createElement("div");
    this.shadowHost.id = "ai-2048-solver-hud";

    // Attach shadow root
    this.shadowRoot = this.shadowHost.attachShadow({ mode: "open" });

    // Create HUD structure
    this.shadowRoot.innerHTML = this.getHUDHTML();

    // Get reference to HUD element
    this.hudElement = this.shadowRoot.querySelector(".hud-panel");

    // Inject into page
    document.body.appendChild(this.shadowHost);

    // Position HUD in top-right corner initially
    this.positionHUD(window.innerWidth - 320, 20);
  }

  /**
   * Get the complete HUD HTML structure with embedded CSS
   * @private
   * @returns {string} HTML string
   */
  getHUDHTML() {
    return `
      <style>
        ${this.getHUDCSS()}
      </style>
      <div class="hud-panel" data-collapsed="false">
        <div class="hud-header">
          <div class="hud-title">
            <span class="hud-icon">🎯</span>
            <span class="hud-text">2048 AI Solver</span>
          </div>
          <div class="hud-controls">
            <button class="hud-btn hud-btn-collapse" title="Collapse/Expand">
              <span class="collapse-icon">−</span>
            </button>
          </div>
        </div>
        <div class="hud-content">
          <div class="hud-status">
            <div class="status-item">
              <span class="status-label">Game:</span>
              <span class="status-value" id="game-status">Not detected</span>
            </div>
            <div class="status-item">
              <span class="status-label">Score:</span>
              <span class="status-value" id="score-status">-</span>
            </div>
          </div>

          <div class="hud-actions">
            <button class="hud-btn hud-btn-primary" id="detect-btn">
              🔍 Detect Game
            </button>
            <button class="hud-btn hud-btn-success" id="auto-solve-btn" disabled>
              ▶️ Auto-solve
            </button>
            <button class="hud-btn hud-btn-secondary" id="step-btn" disabled>
              ⏭️ Step
            </button>
          </div>

          <div class="hud-settings">
            <div class="setting-group">
              <label class="setting-label">Direction Priority:</label>
              <select class="setting-select" id="direction-priority">
                <option value="0,2,1,3">Up → Down → Right → Left</option>
                <option value="3,2,1,0" selected>Left → Down → Right → Up</option>
                <option value="1,3,0,2">Right → Left → Up → Down</option>
                <option value="2,0,3,1">Down → Up → Left → Right</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Get the HUD CSS styles
   * @private
   * @returns {string} CSS string
   */
  getHUDCSS() {
    return `
      :host {
        all: initial;
        position: fixed;
        top: 0;
        left: 0;
        z-index: 2147483647;
        pointer-events: none;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        line-height: 1.4;
      }

      .hud-panel {
        position: absolute;
        width: 300px;
        background: rgba(0, 0, 0, 0.9);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 8px;
        color: white;
        pointer-events: auto;
        backdrop-filter: blur(10px);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
        transition: all 0.3s ease;
        user-select: none;
      }

      .hud-panel[data-collapsed="true"] {
        height: 40px;
        overflow: hidden;
      }

      .hud-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 12px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 7px 7px 0 0;
        cursor: move;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      }

      .hud-title {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 600;
        font-size: 13px;
      }

      .hud-icon {
        font-size: 16px;
      }

      .hud-controls {
        display: flex;
        gap: 4px;
      }

      .hud-btn {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .hud-btn:hover {
        background: rgba(255, 255, 255, 0.2);
        transform: translateY(-1px);
      }

      .hud-btn:active {
        transform: translateY(0);
      }

      .hud-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none !important;
      }

      .hud-btn-collapse {
        width: 24px;
        height: 24px;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
        font-weight: bold;
      }

      .hud-btn-primary {
        background: rgba(59, 130, 246, 0.8);
        border-color: rgba(59, 130, 246, 1);
      }

      .hud-btn-success {
        background: rgba(34, 197, 94, 0.8);
        border-color: rgba(34, 197, 94, 1);
      }

      .hud-btn-secondary {
        background: rgba(107, 114, 128, 0.8);
        border-color: rgba(107, 114, 128, 1);
      }

      .hud-content {
        padding: 12px;
      }

      .hud-status {
        margin-bottom: 12px;
        padding: 8px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 4px;
      }

      .status-item {
        display: flex;
        justify-content: space-between;
        margin-bottom: 4px;
      }

      .status-item:last-child {
        margin-bottom: 0;
      }

      .status-label {
        font-size: 12px;
        opacity: 0.8;
      }

      .status-value {
        font-size: 12px;
        font-weight: 600;
      }

      .hud-actions {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-bottom: 12px;
      }

      .hud-settings {
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        padding-top: 12px;
      }

      .setting-group {
        margin-bottom: 8px;
      }

      .setting-label {
        display: block;
        font-size: 12px;
        margin-bottom: 4px;
        opacity: 0.8;
      }

      .setting-select {
        width: 100%;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
      }

      .setting-select option {
        background: #1a1a1a;
        color: white;
      }

      /* Animation for auto-solving */
      .hud-panel.auto-solving .hud-btn-success {
        animation: pulse 1s infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.7; }
      }

      /* Dragging state */
      .hud-panel.dragging {
        transition: none;
        cursor: grabbing;
      }
    `;
  }

  /**
   * Attach event listeners to HUD elements
   * @private
   */
  attachEventListeners() {
    // Header drag functionality
    const header = this.shadowRoot.querySelector(".hud-header");
    header.addEventListener("mousedown", this.handleMouseDown);

    // Button event listeners
    const detectBtn = this.shadowRoot.getElementById("detect-btn");
    const autoSolveBtn = this.shadowRoot.getElementById("auto-solve-btn");
    const stepBtn = this.shadowRoot.getElementById("step-btn");
    const collapseBtn = this.shadowRoot.querySelector(".hud-btn-collapse");

    detectBtn.addEventListener("click", this.handleDetectClick);
    autoSolveBtn.addEventListener("click", this.handleAutoSolveClick);
    stepBtn.addEventListener("click", this.handleStepClick);
    collapseBtn.addEventListener("click", this.handleCollapseClick);

    // Direction priority change
    const directionSelect =
      this.shadowRoot.getElementById("direction-priority");
    directionSelect.addEventListener("change", (e) => {
      const priorities = e.target.value.split(",").map(Number);
      this.directionPriority = priorities;
      if (this.controller && this.controller.setDirectionPriority) {
        try {
          this.controller.setDirectionPriority([...priorities]);
        } catch (error) {
          console.warn("HUD: Failed to update direction priority via controller", error);
        }
      }
    });

    // Global mouse events for dragging
    document.addEventListener("mousemove", this.handleMouseMove);
    document.addEventListener("mouseup", this.handleMouseUp);
  }

  /**
   * Position the HUD at specific coordinates
   * @private
   * @param {number} x X coordinate
   * @param {number} y Y coordinate
   */
  positionHUD(x, y) {
    if (!this.hudElement) return;

    // Constrain to viewport
    const rect = this.hudElement.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width;
    const maxY = window.innerHeight - rect.height;

    x = Math.max(0, Math.min(x, maxX));
    y = Math.max(0, Math.min(y, maxY));

    this.hudElement.style.left = x + "px";
    this.hudElement.style.top = y + "px";
  }

  /**
   * Handle mouse down on header (start dragging)
   * @private
   * @param {MouseEvent} e Mouse event
   */
  handleMouseDown(e) {
    if (e.target.closest(".hud-btn")) return; // Don't drag when clicking buttons

    this.isDragging = true;
    this.hudElement.classList.add("dragging");

    const rect = this.hudElement.getBoundingClientRect();
    this.dragOffset.x = e.clientX - rect.left;
    this.dragOffset.y = e.clientY - rect.top;

    e.preventDefault();
  }

  /**
   * Handle mouse move (dragging)
   * @private
   * @param {MouseEvent} e Mouse event
   */
  handleMouseMove(e) {
    if (!this.isDragging) return;

    const x = e.clientX - this.dragOffset.x;
    const y = e.clientY - this.dragOffset.y;

    this.positionHUD(x, y);
  }

  /**
   * Handle mouse up (stop dragging)
   * @private
   * @param {MouseEvent} e Mouse event
   */
  handleMouseUp(e) {
    if (!this.isDragging) return;

    this.isDragging = false;
    this.hudElement.classList.remove("dragging");
  }

  /**
   * Handle detect game button click
   * @private
   */
  async handleDetectClick() {
    if (this.controller) {
      try {
        const detectFn = this.controller.detectGame?.bind(this.controller);
        const detected = detectFn ? await Promise.resolve(detectFn()) : false;
        if (this.controller.getCurrentAdapter) {
          const adapterFromController = this.controller.getCurrentAdapter();
          if (adapterFromController) {
            this.currentAdapter = adapterFromController;
          }
        }
        this.updateStatus();
        if (!detected && !this.currentAdapter) {
          this.showMessage("No game detected.");
        }
      } catch (error) {
        console.warn("HUD: Controller-driven detect failed", error);
        this.showMessage("Detect failed. Check console.");
      }
      return;
    }

    this.currentAdapter = detectGame();
    this.updateStatus();
  }

  /**
   * Handle auto-solve button click
   * @private
   */
  async handleAutoSolveClick() {
    if (!this.currentAdapter) {
      await this.handleDetectClick();
      if (!this.currentAdapter) {
        this.showMessage('No game detected. Click "Detect Game" first.');
        return;
      }
    }

    if (this.controller) {
      try {
        const isRunning = this.controller.isRunning?.bind(this.controller);
        const currentlyRunning = isRunning ? !!isRunning() : this.isAutoSolving;

        if (currentlyRunning) {
          const stopFn = this.controller.stop?.bind(this.controller);
          if (stopFn) {
            await Promise.resolve(stopFn());
          }
          this.updateRunState(false);
        } else {
          const startFn = this.controller.start?.bind(this.controller);
          if (startFn) {
            await Promise.resolve(startFn());
          }
          this.updateRunState(true);
        }
      } catch (error) {
        console.warn("HUD: Failed to toggle auto-solve via controller", error);
        this.showMessage("Auto-solve toggle failed. Check console.");
      }
      return;
    }

    if (this.isAutoSolving) {
      this.stopAutoSolve();
    } else {
      this.startAutoSolve();
    }
  }

  /**
   * Handle step button click
   * @private
   */
  async handleStepClick() {
    if (!this.currentAdapter) {
      await this.handleDetectClick();
      if (!this.currentAdapter) {
        this.showMessage('No game detected. Click "Detect Game" first.');
        return;
      }
    }

    if (this.controller) {
      try {
        const stepFn = this.controller.step?.bind(this.controller);
        if (stepFn) {
          await Promise.resolve(stepFn());
        }
      } catch (error) {
        console.warn("HUD: Step failed via controller", error);
        this.showMessage("Step failed. Check console.");
      }
      return;
    }

    this.executeStep();
  }

  /**
   * Handle collapse button click
   * @private
   */
  handleCollapseClick() {
    this.isCollapsed = !this.isCollapsed;
    this.hudElement.setAttribute("data-collapsed", this.isCollapsed.toString());

    const collapseIcon = this.shadowRoot.querySelector(".collapse-icon");
    collapseIcon.textContent = this.isCollapsed ? "+" : "−";
  }

  /**
   * Update HUD status display
   * @private
   */
  updateStatus() {
    if (this.controller && this.controller.getCurrentAdapter) {
      const controllerAdapter = this.controller.getCurrentAdapter();
      if (controllerAdapter) {
        this.currentAdapter = controllerAdapter;
      }
    }

    const gameStatus = this.shadowRoot.getElementById("game-status");
    const scoreStatus = this.shadowRoot.getElementById("score-status");
    const autoSolveBtn = this.shadowRoot.getElementById("auto-solve-btn");
    const stepBtn = this.shadowRoot.getElementById("step-btn");

    if (this.currentAdapter) {
      gameStatus.textContent = `${this.currentAdapter.getName()}`;
      gameStatus.style.color = "#34d399";

      const score = this.currentAdapter.getScore();
      scoreStatus.textContent = score !== null ? score.toLocaleString() : "-";

      autoSolveBtn.disabled = false;
      stepBtn.disabled = false;
    } else {
      gameStatus.textContent = "Not detected";
      gameStatus.style.color = "#f87171";
      scoreStatus.textContent = "-";

      autoSolveBtn.disabled = true;
      stepBtn.disabled = true;
    }
  }

  /**
   * Update run state UI to reflect automation status
   * @param {boolean} isRunning Whether automation is active
   */
  updateRunState(isRunning) {
    this.isAutoSolving = !!isRunning;

    if (this.hudElement) {
      this.hudElement.classList.toggle("auto-solving", this.isAutoSolving);
    }

    const autoSolveBtn = this.shadowRoot?.getElementById("auto-solve-btn");
    if (autoSolveBtn) {
      autoSolveBtn.textContent = this.isAutoSolving
        ? "⏸️ Pause"
        : "▶️ Auto-solve";
    }
  }

  /**
   * Start auto-solving
   * @private
   */
  async startAutoSolve() {
    if (this.controller) {
      try {
        const startFn = this.controller.start?.bind(this.controller);
        if (startFn) {
          await Promise.resolve(startFn());
        }
        const running = this.controller.isRunning?.bind(this.controller);
        this.updateRunState(running ? !!running() : true);
      } catch (error) {
        console.warn("HUD: startAutoSolve controller invocation failed", error);
        this.showMessage("Auto-solve failed. Check console.");
      }
      return;
    }

    this.updateRunState(true);
    this.autoSolveLoop();
  }

  /**
   * Stop auto-solving
   * @private
   */
  async stopAutoSolve() {
    if (this.controller) {
      try {
        const stopFn = this.controller.stop?.bind(this.controller);
        if (stopFn) {
          await Promise.resolve(stopFn());
        }
      } catch (error) {
        console.warn("HUD: stopAutoSolve controller invocation failed", error);
      }
      this.updateRunState(false);
      return;
    }

    if (this.autoSolveTimeout) {
      clearTimeout(this.autoSolveTimeout);
      this.autoSolveTimeout = null;
    }

    this.updateRunState(false);
  }

  /**
   * Auto-solve loop
   * @private
   */
  async autoSolveLoop() {
    if (!this.isAutoSolving || !this.currentAdapter) return;

    // Check if game is over
    if (this.currentAdapter.isGameOver()) {
      this.stopAutoSolve();
      this.showMessage("Game over!");
      return;
    }

    // Execute a step
    await this.executeStep();

    // Update status
    this.updateStatus();

    // Continue loop with delay
    this.autoSolveTimeout = setTimeout(() => {
      this.autoSolveLoop();
    }, 150); // 150ms delay between moves
  }

  /**
   * Execute a single step
   * @private
   */
  async executeStep() {
    if (!this.currentAdapter) return;

    const boardBefore = this.currentAdapter.readBoard();
    if (!boardBefore) return;

    // Try each direction in priority order
    for (const direction of this.directionPriority) {
      this.currentAdapter.sendMove(direction);

      // Wait for move to complete
      await new Promise((resolve) => setTimeout(resolve, 120));

      const boardAfter = this.currentAdapter.readBoard();
      if (
        boardAfter &&
        JSON.stringify(boardBefore) !== JSON.stringify(boardAfter)
      ) {
        // Move was successful
        return;
      }
    }

    // If no move worked, try random direction
    const randomDir = Math.floor(Math.random() * 4);
    this.currentAdapter.sendMove(randomDir);
  }

  /**
   * Show temporary message
   * @private
   * @param {string} message Message to show
   */
  showMessage(message) {
    // Create temporary message element
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
      document.body.removeChild(messageEl);
    }, 2000);
  }

  /**
   * Connect HUD to external controller (e.g., runtime)
   * @param {Object|null} controller Controller interface
   */
  setController(controller) {
    this.controller = controller || null;

    if (this.controller && this.controller.getCurrentAdapter) {
      const adapter = this.controller.getCurrentAdapter();
      if (adapter) {
        this.currentAdapter = adapter;
      }
    }

    if (this.controller && this.controller.isRunning) {
      try {
        this.updateRunState(!!this.controller.isRunning());
      } catch (error) {
        console.warn("HUD: Failed to read controller run state", error);
      }
    } else {
      this.updateRunState(false);
    }

    this.updateStatus();
  }

  /**
   * Get current direction priority selection
   * @returns {number[]} Direction priority array
   */
  getDirectionPriority() {
    return [...this.directionPriority];
  }

  /**
   * Destroy the HUD and clean up
   */
  destroy() {
    if (this.isAutoSolving) {
      this.stopAutoSolve();
    }

    if (this.autoSolveTimeout) {
      clearTimeout(this.autoSolveTimeout);
      this.autoSolveTimeout = null;
    }

    // Remove event listeners
    document.removeEventListener("mousemove", this.handleMouseMove);
    document.removeEventListener("mouseup", this.handleMouseUp);

    // Remove from DOM
    if (this.shadowHost && this.shadowHost.parentNode) {
      this.shadowHost.parentNode.removeChild(this.shadowHost);
    }

    this.shadowHost = null;
    this.shadowRoot = null;
    this.hudElement = null;
    this.currentAdapter = null;
  }
}

/**
 * Global HUD instance
 */
let globalHUD = null;

/**
 * Initialize HUD if not already present
 * @returns {HUD} HUD instance
 */
export function initHUD() {
  if (!globalHUD) {
    globalHUD = new HUD();
    globalHUD.init();
  }
  return globalHUD;
}

/**
 * Get current HUD instance
 * @returns {HUD|null} HUD instance or null
 */
export function getHUD() {
  return globalHUD;
}

/**
 * Destroy current HUD instance
 */
export function destroyHUD() {
  if (globalHUD) {
    globalHUD.destroy();
    globalHUD = null;
  }
}
