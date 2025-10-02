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

      .hud-panel.auto-solving .hud-btn-success {
        animation: pulse 1s infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.7; }
      }

      .hud-panel.dragging {
        transition: none;
        cursor: grabbing;
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
              <label class="setting-label">Direction Priority:</label>
              <select class="setting-select" id="direction-priority">
                <option value="0,2,1,3">Up → Down → Right → Left</option>
                <option value="3,2,1,0" selected>Left → Down → Right → Up</option>
                <option value="1,3,0,2">Right → Left → Up → Down</option>
                <option value="2,0,3,1">Down → Up → Left → Right</option>
              </select>
            </div>
            <div class="setting-group">
              <label class="setting-label">Solver Strategy:</label>
              <select class="setting-select" id="solver-strategy">
                <option value="expectimax-depth" selected>Expectimax (Depth)</option>
                <option value="expectimax-probability">Expectimax (Probability)</option>
              </select>
            </div>
            <div class="setting-group">
              <label class="setting-label">Heuristic:</label>
              <select class="setting-select" id="solver-heuristic">
                <option value="corner" selected>Corner Bias</option>
                <option value="monotonicity">Monotonicity</option>
                <option value="wall">Wall Building</option>
                <option value="score">Score Focus</option>
              </select>
            </div>
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
      </div>
    `;
}
