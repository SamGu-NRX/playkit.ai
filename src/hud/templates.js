/**
 * @fileoverview Markup and style templates for the HUD shadow DOM
 */

/**
 * Returns the CSS rules injected inside the HUD shadow root.
 * @returns {string}
 */
export function getHUDCSS() {
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

      .setting-hint {
        margin: 4px 0 0;
        font-size: 12px;
      }

      .hud-live-region {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        clip-path: inset(50%);
        white-space: nowrap;
        border: 0;
      }

      .setting-input {
        width: 100%;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 12px;
      }

      .setting-input:disabled,
      .setting-select:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      @media (prefers-reduced-motion: no-preference) {
        .hud-panel {
          transition: all 0.3s ease;
        }

        .hud-btn {
          transition: all 0.2s ease;
        }

        .hud-panel.auto-solving .hud-btn-success {
          animation: pulse 1s infinite;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
      }

      .hud-panel.dragging {
        transition: none;
        cursor: grabbing;
      }

      /* Phone-sized screens and coarse (touch) pointers: fix only what breaks
       * on a phone — the desktop layout above is untouched. The fixed 300 px
       * panel covered most of a 390 px-wide board and its settings ran past
       * the bottom of a landscape phone with no way to reach them. */
      @media (max-width: 480px), (pointer: coarse) {
        .hud-panel {
          width: min(300px, calc(100vw - 16px));
          max-height: calc(100vh - 16px);
          display: flex;
          flex-direction: column;
        }

        .hud-content {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
        }

        .hud-panel[data-collapsed="true"] {
          height: 60px;
        }

        .hud-btn {
          min-height: 44px;
          min-width: 44px;
        }

        .hud-btn-collapse {
          width: 44px;
          height: 44px;
        }

        /* iOS Safari zooms the page when a form control smaller than 16px
         * receives focus. */
        .setting-select,
        .setting-input {
          font-size: 16px;
        }

        .hud-header {
          /* Finger-dragging the header must not scroll the page instead. */
          touch-action: none;
        }
      }
    `;
}

/**
 * Returns the full HTML template for the HUD overlay.
 * @returns {string}
 */
export function getHUDHTML() {
  return `
      <style>
        ${getHUDCSS()}
      </style>
      <div class="hud-panel" role="region" aria-label="AI 2048 Solver" data-collapsed="false">
        <div class="hud-header">
          <div class="hud-title">
            <span class="hud-icon">🎯</span>
            <span class="hud-text">2048 AI Solver</span>
          </div>
          <div class="hud-controls">
            <button class="hud-btn hud-btn-collapse" type="button" aria-expanded="true" aria-label="Collapse panel" title="Collapse panel">
              <span class="collapse-icon" aria-hidden="true">−</span>
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
            <div class="status-item">
              <span class="status-label">Solver:</span>
              <span class="status-value" id="solver-status">Initializing…</span>
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
              <label class="setting-label" for="direction-priority">Direction Priority:</label>
              <select class="setting-select" id="direction-priority">
                <option value="0,2,1,3">Up → Down → Right → Left</option>
                <option value="3,2,1,0" selected>Left → Down → Right → Up</option>
                <option value="1,3,0,2">Right → Left → Up → Down</option>
                <option value="2,0,3,1">Down → Up → Left → Right</option>
              </select>
            </div>
            <div class="setting-group">
              <label class="setting-label" for="solver-strategy">Solver Strategy:</label>
              <select class="setting-select" id="solver-strategy" aria-describedby="strategy-engine-hint">
                <option value="expectimax-depth" selected>Expectimax (Depth)</option>
                <option value="expectimax-probability">Expectimax (Probability)</option>
              </select>
            </div>
            <div class="setting-group">
              <label class="setting-label" for="solver-heuristic">Heuristic:</label>
              <select class="setting-select" id="solver-heuristic" aria-describedby="strategy-engine-hint">
                <option value="corner" selected>Corner Bias</option>
                <option value="monotonicity">Monotonicity</option>
                <option value="wall">Wall Building</option>
                <option value="score">Score Focus</option>
              </select>
            </div>
            <p class="setting-hint" id="strategy-engine-hint">
              Strategy and heuristic options need the WASM solver.
            </p>
            <div class="setting-group">
              <label class="setting-label" for="solver-depth">Depth:</label>
              <input class="setting-input" id="solver-depth" type="number" min="1" max="8" step="1" value="4" />
            </div>
            <div class="setting-group">
              <label class="setting-label" for="solver-probability">Probability:</label>
              <input class="setting-input" id="solver-probability" type="number" min="0.0001" max="0.2" step="0.0001" value="0.0025" />
            </div>
          </div>
        </div>

        <div class="hud-live-region" id="hud-announcer" role="status"></div>
      </div>
    `;
}
