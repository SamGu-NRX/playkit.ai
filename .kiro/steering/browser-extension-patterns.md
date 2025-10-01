---
inclusion: fileMatch
fileMatchPattern: "*extension*|*manifest*|*content*|*popup*|*background*"
---

# Browser Extension Development Patterns

## Manifest V3 Standards

### Manifest Structure

```json
{
  "manifest_version": 3,
  "name": "2048 AI Solver",
  "version": "1.0.0",
  "description": "Automatically detects and plays 2048-like games using AI strategies",

  "permissions": ["storage", "activeTab"],
  "host_permissions": ["<all_urls>"],

  "background": {
    "service_worker": "background.js"
  },

  "content_scripts": [
    {
      "matches": ["*://*/*"],
      "js": ["content.js"],
      "run_at": "document_idle"
    }
  ],

  "action": {
    "default_popup": "popup.html",
    "default_title": "2048 AI Solver"
  },

  "web_accessible_resources": [
    {
      "resources": ["solver.wasm", "solver.js"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

### Permission Guidelines

- **Minimal Permissions**: Only request what's absolutely necessary
- **activeTab**: Preferred over broad host permissions when possible
- **storage**: For persisting user settings and strategy configurations
- **No Network Permissions**: Avoid external requests for security

## Content Script Patterns

### Shadow DOM Isolation

```javascript
// Good: Isolated UI that won't conflict with page styles
function createHUD() {
  const host = document.createElement("div");
  host.id = "t48-host";
  host.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    pointer-events: auto;
  `;

  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    .card {
      font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      box-shadow: 0 6px 20px rgba(0,0,0,.12);
    }
  `;

  root.appendChild(style);
  // ... rest of UI

  document.documentElement.appendChild(host);
  return { host, root };
}

// Bad: Global styles that pollute the page
function createHUD() {
  document.head.innerHTML += `
    <style>
      .hud { /* Will conflict with page styles */ }
    </style>
  `;

  const hud = document.createElement("div");
  hud.className = "hud"; // Not isolated
  document.body.appendChild(hud);
}
```

### Singleton Pattern

```javascript
// Good: Prevent multiple instances
(function () {
  if (window.__T48_SOLVER__) return; // Already loaded

  window.__T48_SOLVER__ = {
    version: "1.0.0",
    instance: null,

    init() {
      if (this.instance) return this.instance;
      this.instance = new SolverHUD();
      return this.instance;
    },

    toggle() {
      if (this.instance) {
        this.instance.toggle();
      }
    },

    destroy() {
      if (this.instance) {
        this.instance.destroy();
        this.instance = null;
      }
    },
  };

  // Initialize
  window.__T48_SOLVER__.init();
})();

// Bad: Multiple instances possible
function initSolver() {
  new SolverHUD(); // Can create multiple instances
}
initSolver(); // Called multiple times
```

### Event Handling

```javascript
// Good: Proper event delegation and cleanup
class SolverHUD {
  constructor() {
    this.boundHandlers = {
      detect: this.handleDetect.bind(this),
      solve: this.handleSolve.bind(this),
      step: this.handleStep.bind(this),
    };

    this.setupEventListeners();
  }

  setupEventListeners() {
    this.root.addEventListener("click", this.handleClick.bind(this));
    this.root.addEventListener("change", this.handleChange.bind(this));

    // Listen for page navigation
    window.addEventListener("beforeunload", this.cleanup.bind(this));
  }

  handleClick(event) {
    const { target } = event;
    const action = target.dataset.action;

    if (this.boundHandlers[action]) {
      event.preventDefault();
      this.boundHandlers[action](event);
    }
  }

  cleanup() {
    // Remove event listeners
    window.removeEventListener("beforeunload", this.cleanup);

    // Clean up resources
    if (this.solver) {
      this.solver.destroy();
    }

    // Remove DOM elements
    if (this.host && this.host.parentNode) {
      this.host.parentNode.removeChild(this.host);
    }
  }
}

// Bad: Memory leaks and poor event handling
class BadSolverHUD {
  constructor() {
    // Anonymous functions can't be removed
    document.addEventListener("click", (e) => {
      this.handleClick(e); // Memory leak
    });

    // No cleanup on navigation
    setInterval(() => {
      this.tick(); // Continues running after page change
    }, 100);
  }
}
```

## Message Passing Patterns

### Content Script ↔ Background Communication

```javascript
// Content Script
class ExtensionMessenger {
  static async sendMessage(action, data = {}) {
    try {
      const response = await chrome.runtime.sendMessage({
        action,
        data,
        timestamp: Date.now(),
      });

      if (response.error) {
        throw new Error(response.error);
      }

      return response.data;
    } catch (error) {
      console.error("Message failed:", error);
      throw error;
    }
  }

  static async getSettings() {
    return this.sendMessage("GET_SETTINGS");
  }

  static async saveSettings(settings) {
    return this.sendMessage("SAVE_SETTINGS", settings);
  }

  static async logGameResult(result) {
    return this.sendMessage("LOG_GAME_RESULT", result);
  }
}

// Background Script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, data } = message;

  (async () => {
    try {
      let result;

      switch (action) {
        case "GET_SETTINGS":
          result = await getStoredSettings();
          break;

        case "SAVE_SETTINGS":
          result = await saveSettings(data);
          break;

        case "LOG_GAME_RESULT":
          result = await logGameResult(data);
          break;

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      sendResponse({ success: true, data: result });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
  })();

  return true; // Keep message channel open for async response
});
```

### Popup ↔ Content Script Communication

```javascript
// Popup Script
class PopupController {
  constructor() {
    this.currentTab = null;
    this.init();
  }

  async init() {
    this.currentTab = await this.getCurrentTab();
    this.setupUI();
    this.loadSettings();
  }

  async getCurrentTab() {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return tab;
  }

  async sendToContentScript(action, data = {}) {
    if (!this.currentTab) return null;

    try {
      const response = await chrome.tabs.sendMessage(this.currentTab.id, {
        action,
        data,
      });
      return response;
    } catch (error) {
      console.error("Content script communication failed:", error);
      return null;
    }
  }

  async startSolver() {
    const settings = this.getUISettings();
    await this.sendToContentScript("START_SOLVER", settings);
  }

  async stopSolver() {
    await this.sendToContentScript("STOP_SOLVER");
  }
}

// Content Script - Message Listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, data } = message;

  switch (action) {
    case "START_SOLVER":
      startSolverWithSettings(data);
      sendResponse({ success: true });
      break;

    case "STOP_SOLVER":
      stopSolver();
      sendResponse({ success: true });
      break;

    case "GET_STATUS":
      sendResponse({
        success: true,
        data: getCurrentStatus(),
      });
      break;

    default:
      sendResponse({
        success: false,
        error: `Unknown action: ${action}`,
      });
  }

  return true;
});
```

## Storage Patterns

### Settings Management

```javascript
class SettingsManager {
  static defaultSettings = {
    strategy: "expectimax",
    heuristic: "corner",
    depth: 4,
    autoStart: false,
    throttleMs: 130,
    directionBias: 2,
  };

  static async get(key = null) {
    try {
      const result = await chrome.storage.sync.get(
        key ? [key] : Object.keys(this.defaultSettings)
      );

      if (key) {
        return result[key] ?? this.defaultSettings[key];
      }

      return { ...this.defaultSettings, ...result };
    } catch (error) {
      console.error("Settings get failed:", error);
      return key ? this.defaultSettings[key] : this.defaultSettings;
    }
  }

  static async set(key, value) {
    try {
      const settings = typeof key === "object" ? key : { [key]: value };
      await chrome.storage.sync.set(settings);
      return true;
    } catch (error) {
      console.error("Settings set failed:", error);
      return false;
    }
  }

  static async reset() {
    try {
      await chrome.storage.sync.clear();
      await this.set(this.defaultSettings);
      return true;
    } catch (error) {
      console.error("Settings reset failed:", error);
      return false;
    }
  }

  // Per-origin settings
  static async getForOrigin(origin) {
    const key = `origin_${origin}`;
    return this.get(key) || this.defaultSettings;
  }

  static async setForOrigin(origin, settings) {
    const key = `origin_${origin}`;
    return this.set(key, settings);
  }
}
```

### Game Statistics

```javascript
class StatsManager {
  static async recordGame(result) {
    const stats = await this.getStats();

    stats.gamesPlayed++;
    stats.totalScore += result.score;
    stats.maxTileReached = Math.max(stats.maxTileReached, result.maxTile);

    if (result.won) {
      stats.gamesWon++;
    }

    stats.averageScore = Math.round(stats.totalScore / stats.gamesPlayed);
    stats.winRate = ((stats.gamesWon / stats.gamesPlayed) * 100).toFixed(1);

    // Keep recent games (last 100)
    stats.recentGames = stats.recentGames || [];
    stats.recentGames.push({
      timestamp: Date.now(),
      score: result.score,
      maxTile: result.maxTile,
      moves: result.moves,
      won: result.won,
    });

    if (stats.recentGames.length > 100) {
      stats.recentGames = stats.recentGames.slice(-100);
    }

    await chrome.storage.local.set({ gameStats: stats });
    return stats;
  }

  static async getStats() {
    const result = await chrome.storage.local.get("gameStats");
    return (
      result.gameStats || {
        gamesPlayed: 0,
        gamesWon: 0,
        totalScore: 0,
        averageScore: 0,
        maxTileReached: 0,
        winRate: 0,
        recentGames: [],
      }
    );
  }

  static async resetStats() {
    await chrome.storage.local.remove("gameStats");
  }
}
```

## Cross-Browser Compatibility

### WebExtension Polyfill

```javascript
// Use webextension-polyfill for Firefox compatibility
if (typeof browser !== "undefined") {
  // Firefox - use browser API
  window.chrome = browser;
} else if (typeof chrome !== "undefined") {
  // Chrome - promisify APIs
  const promisify =
    (fn) =>
    (...args) => {
      return new Promise((resolve, reject) => {
        fn(...args, (result) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(result);
          }
        });
      });
    };

  // Promisify commonly used APIs
  chrome.storage.sync.get = promisify(chrome.storage.sync.get);
  chrome.storage.sync.set = promisify(chrome.storage.sync.set);
  chrome.tabs.sendMessage = promisify(chrome.tabs.sendMessage);
}
```

### Safari Extension Compatibility

```javascript
// Safari Web Extension adaptations
class SafariCompat {
  static isSupported() {
    return typeof safari !== "undefined" && safari.extension;
  }

  static async sendMessage(message) {
    if (this.isSupported()) {
      return new Promise((resolve) => {
        safari.extension.dispatchMessage("message", message);
        // Safari doesn't support response callbacks
        resolve({ success: true });
      });
    }

    return chrome.runtime.sendMessage(message);
  }

  static async getStorage(key) {
    if (this.isSupported()) {
      // Safari uses different storage API
      return safari.extension.settings.getItem(key);
    }

    return chrome.storage.sync.get(key);
  }
}
```

## Error Handling and Debugging

### Extension Context Detection

```javascript
function getExtensionContext() {
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) {
    return "extension";
  }

  if (typeof safari !== "undefined" && safari.extension) {
    return "safari";
  }

  if (typeof browser !== "undefined" && browser.runtime) {
    return "webextension";
  }

  return "bookmarklet";
}

function isExtensionContext() {
  return getExtensionContext() !== "bookmarklet";
}
```

### Resource Loading

```javascript
async function loadResource(path) {
  const context = getExtensionContext();

  try {
    switch (context) {
      case "extension":
        return chrome.runtime.getURL(path);

      case "safari":
        return safari.extension.baseURI + path;

      case "webextension":
        return browser.runtime.getURL(path);

      case "bookmarklet":
        // Fallback to CDN or inline
        return `https://cdn.example.com/2048-solver/${path}`;

      default:
        throw new Error(`Unknown context: ${context}`);
    }
  } catch (error) {
    console.error(`Failed to load resource ${path}:`, error);
    throw error;
  }
}
```

### Development vs Production

```javascript
const isDevelopment = () => {
  return !("update_url" in chrome.runtime.getManifest());
};

const log = (...args) => {
  if (isDevelopment()) {
    console.log("[2048 Solver]", ...args);
  }
};

const debugLog = (...args) => {
  if (isDevelopment()) {
    console.debug("[2048 Solver Debug]", ...args);
  }
};
```

## Performance Optimization

### Lazy Loading

```javascript
class LazyLoader {
  static modules = new Map();

  static async loadModule(name) {
    if (this.modules.has(name)) {
      return this.modules.get(name);
    }

    let module;

    switch (name) {
      case "solver":
        module = await import("./solver.js");
        break;

      case "stats":
        module = await import("./stats.js");
        break;

      default:
        throw new Error(`Unknown module: ${name}`);
    }

    this.modules.set(name, module);
    return module;
  }
}
```

### Memory Management

```javascript
class ResourceManager {
  constructor() {
    this.resources = new Set();
    this.observers = new Set();
    this.intervals = new Set();
    this.timeouts = new Set();
  }

  addObserver(observer) {
    this.observers.add(observer);
    return observer;
  }

  addInterval(id) {
    this.intervals.add(id);
    return id;
  }

  addTimeout(id) {
    this.timeouts.add(id);
    return id;
  }

  cleanup() {
    // Disconnect observers
    this.observers.forEach((observer) => {
      if (observer.disconnect) observer.disconnect();
    });

    // Clear intervals
    this.intervals.forEach((id) => clearInterval(id));

    // Clear timeouts
    this.timeouts.forEach((id) => clearTimeout(id));

    // Clear sets
    this.observers.clear();
    this.intervals.clear();
    this.timeouts.clear();
  }
}
```
