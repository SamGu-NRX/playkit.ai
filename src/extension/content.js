(() => {
  const modules = {
  "./src/adapters/adapter-registry.js": function (exports, module, require) {
    /**
     * @fileoverview Adapter registry for automatic game detection
     * Implements the Adapter Registry pattern for site detection
     */
    
    const { Play2048Adapter } = require("./src/adapters/play2048-adapter.js");
    const { GenericAdapter } = require("./src/adapters/generic-adapter.js");
    const { GetMITAdapter } = require("./src/adapters/getmit-adapter.js");
    
    /**
     * Registry for managing and selecting appropriate adapters
     * Follows the Adapter Registry pattern from steering guidelines
     */
    class AdapterRegistry {
      constructor() {
        this._adapters = [];
        this._currentAdapter = null;
        this._lastDetectionTime = 0;
        this._detectionCacheMs = 2000; // Cache detection for 2 seconds
    
        this._registerDefaultAdapters();
      }
    
      /**
       * Register default adapters in priority order
       * @private
       */
      _registerDefaultAdapters() {
        // Register adapters in priority order (most specific first)
        this.registerAdapter(GetMITAdapter, 100); // Highest priority for target site
        this.registerAdapter(Play2048Adapter, 80); // High priority for common pattern
        this.registerAdapter(GenericAdapter, 10); // Lowest priority fallback
      }
    
      /**
       * Register a new adapter with priority
       * @param {typeof Adapter} AdapterClass Adapter class constructor
       * @param {number} priority Priority level (higher = checked first)
       */
      registerAdapter(AdapterClass, priority = 50) {
        const entry = {
          AdapterClass,
          priority,
          instance: null,
        };
    
        this._adapters.push(entry);
    
        // Sort by priority (highest first)
        this._adapters.sort((a, b) => b.priority - a.priority);
      }
    
      /**
       * Detect and return the best adapter for the current page
       * @returns {Adapter|null} Best matching adapter or null if none found
       */
      detectAdapter() {
        const now = Date.now();
    
        // Return cached adapter if recent and still valid
        if (
          this._currentAdapter &&
          now - this._lastDetectionTime < this._detectionCacheMs &&
          this._currentAdapter.canAttach()
        ) {
          return this._currentAdapter;
        }
    
        // Try each adapter in priority order
        for (const entry of this._adapters) {
          try {
            // Create instance if not cached
            if (!entry.instance) {
              entry.instance = new entry.AdapterClass();
            }
    
            // Test if adapter can attach to current page
            if (entry.instance.canAttach()) {
              this._currentAdapter = entry.instance;
              this._lastDetectionTime = now;
    
              console.log(`AdapterRegistry: Selected ${entry.instance.getName()}`);
              return this._currentAdapter;
            }
          } catch (error) {
            console.warn(
              `AdapterRegistry: Error testing ${entry.AdapterClass.name}:`,
              error
            );
          }
        }
    
        // No adapter found
        this._currentAdapter = null;
        this._lastDetectionTime = now;
        return null;
      }
    
      /**
       * Get the currently active adapter
       * @returns {Adapter|null} Current adapter or null
       */
      getCurrentAdapter() {
        return this._currentAdapter;
      }
    
      /**
       * Force re-detection on next call
       * Useful when page structure changes
       */
      invalidateCache() {
        this._lastDetectionTime = 0;
        this._currentAdapter = null;
      }
    
      /**
       * Get list of all registered adapters
       * @returns {Array<{name: string, priority: number, canAttach: boolean}>}
       */
      getAdapterInfo() {
        return this._adapters.map((entry) => {
          let canAttach = false;
          try {
            if (!entry.instance) {
              entry.instance = new entry.AdapterClass();
            }
            canAttach = entry.instance.canAttach();
          } catch (error) {
            canAttach = false;
          }
    
          return {
            name: entry.AdapterClass.name,
            priority: entry.priority,
            canAttach,
          };
        });
      }
    
      /**
       * Test all adapters and return compatibility report
       * @returns {Array<{name: string, canAttach: boolean, error?: string}>}
       */
      testAllAdapters() {
        const results = [];
    
        for (const entry of this._adapters) {
          const result = {
            name: entry.AdapterClass.name,
            canAttach: false,
            error: null,
          };
    
          try {
            if (!entry.instance) {
              entry.instance = new entry.AdapterClass();
            }
            result.canAttach = entry.instance.canAttach();
          } catch (error) {
            result.error = error.message;
          }
    
          results.push(result);
        }
    
        return results;
      }
    
      /**
       * Create a new registry instance with default adapters
       * @returns {AdapterRegistry} New registry instance
       */
      static create() {
        return new AdapterRegistry();
      }
    }
    
    /**
     * Global registry instance for convenience
     * Can be imported and used directly
     */
    const globalAdapterRegistry = AdapterRegistry.create();
    
    exports.AdapterRegistry = AdapterRegistry;
    exports.globalAdapterRegistry = globalAdapterRegistry;
  },
  "./src/adapters/adapter.js": function (exports, module, require) {
    /**
     * @fileoverview Base adapter interface for 2048-like game detection and interaction
     * Follows the steering contract for game detection patterns
     */
    
    /**
     * Direction constants for move execution
     * @readonly
     * @enum {number}
     */
    const Direction = {
      UP: 0,
      RIGHT: 1,
      DOWN: 2,
      LEFT: 3,
    };
    
    /**
     * Base adapter interface for different 2048 game implementations.
     * Each adapter handles site-specific DOM patterns and input methods.
     *
     * @interface
     */
    class Adapter {
      /**
       * Quick check if this adapter can handle the current page
       * @returns {boolean} True if adapter can attach to current page
       */
      canAttach() {
        throw new Error("canAttach() must be implemented by subclass");
      }
    
      /**
       * Extract current game state as 4x4 number matrix (0 = empty)
       * @returns {number[][]|null} 4x4 matrix or null if extraction fails
       */
      readBoard() {
        throw new Error("readBoard() must be implemented by subclass");
      }
    
      /**
       * Send move command to the game
       * @param {0|1|2|3} dir Direction (0=Up, 1=Right, 2=Down, 3=Left)
       */
      sendMove(dir) {
        throw new Error("sendMove() must be implemented by subclass");
      }
    
      /**
       * Get current game score (optional)
       * @returns {number|null} Current score or null if not available
       */
      getScore() {
        return null;
      }
    
      /**
       * Check if game is over (optional)
       * @returns {boolean} True if game is over
       */
      isGameOver() {
        return false;
      }
    
      /**
       * Get adapter name for debugging
       * @returns {string} Adapter name
       */
      getName() {
        return this.constructor.name;
      }
    }
    
    /**
     * Utility functions for board manipulation
     */
    const BoardUtils = {
      /**
       * Create empty 4x4 board
       * @returns {number[][]} Empty 4x4 matrix
       */
      createEmptyBoard() {
        return Array.from({ length: 4 }, () => Array(4).fill(0));
      },
    
      /**
       * Calculate simple hash of board state for change detection
       * @param {number[][]} board 4x4 board matrix
       * @returns {string} Hash string
       */
      hashBoard(board) {
        if (!board || !Array.isArray(board)) return "";
        return board.flat().join(",");
      },
    
      /**
       * Check if board is valid 4x4 matrix
       * @param {any} board Board to validate
       * @returns {boolean} True if valid
       */
      isValidBoard(board) {
        return (
          Array.isArray(board) &&
          board.length === 4 &&
          board.every((row) => Array.isArray(row) && row.length === 4)
        );
      },
    
      /**
       * Parse tile value from text content
       * @param {string} text Text content from tile element
       * @returns {number} Parsed tile value or 0 if invalid
       */
      parseTileValue(text) {
        if (!text || typeof text !== "string") return 0;
        const trimmed = text.trim();
        if (!trimmed || !/^\d+$/.test(trimmed)) return 0;
        const value = parseInt(trimmed, 10);
        return Math.min(value, 65536); // Cap at reasonable max (2^16)
      },
    };
    
    exports.Adapter = Adapter;
    exports.Direction = Direction;
    exports.BoardUtils = BoardUtils;
  },
  "./src/adapters/generic-adapter.js": function (exports, module, require) {
    /**
     * @fileoverview Generic adapter for 4x4 numeric grid games
     * Uses heuristic detection to find game boards in various implementations
     */
    
    const { Adapter, Direction, BoardUtils } = require("./src/adapters/adapter.js");
    
    /**
     * Generic adapter that attempts to detect 4x4 grids using heuristics
     * Fallback for sites that don't match specific adapter patterns
     */
    class GenericAdapter extends Adapter {
      constructor() {
        super();
        this.keyMap = {
          [Direction.UP]: "ArrowUp",
          [Direction.RIGHT]: "ArrowRight",
          [Direction.DOWN]: "ArrowDown",
          [Direction.LEFT]: "ArrowLeft",
        };
        this.keyCodeMap = {
          [Direction.UP]: 38,
          [Direction.RIGHT]: 39,
          [Direction.DOWN]: 40,
          [Direction.LEFT]: 37,
        };
    
        // Cache detected elements to avoid re-scanning
        this._cachedGameContainer = null;
        this._cachedBoardElements = null;
        this._lastScanTime = 0;
        this._scanCacheMs = 1000; // Cache for 1 second
      }
    
      /**
       * Check if this adapter can detect a 4x4 grid on the page
       * Uses heuristic detection for various game implementations
       */
      canAttach() {
        const detection = this._detectGameBoard();
        return detection.found;
      }
    
      /**
       * Extract game state using heuristic grid detection
       * @returns {number[][]|null} 4x4 board matrix or null if extraction fails
       */
      readBoard() {
        try {
          const detection = this._detectGameBoard();
          if (!detection.found || !detection.elements) {
            return null;
          }
    
          const board = BoardUtils.createEmptyBoard();
          const elements = detection.elements;
    
          // Try to extract values from detected grid elements
          for (let i = 0; i < Math.min(elements.length, 16); i++) {
            const row = Math.floor(i / 4);
            const col = i % 4;
            const element = elements[i];
    
            if (element) {
              const value = this._extractValueFromElement(element);
              board[row][col] = value;
            }
          }
    
          return board;
        } catch (error) {
          console.warn("GenericAdapter: Failed to read board:", error);
          return null;
        }
      }
    
      /**
       * Send move command via keyboard events
       * @param {0|1|2|3} dir Direction to move
       */
      sendMove(dir) {
        try {
          // Try keyboard events on various targets
          this._dispatchKeyboardEvent(dir);
    
          // Also try touch simulation as fallback
          setTimeout(() => {
            this._simulateTouch(dir);
          }, 10);
        } catch (error) {
          console.warn("GenericAdapter: Failed to send move:", error);
        }
      }
    
      /**
       * Attempt to get score from common score element patterns
       * @returns {number|null} Current score or null if not found
       */
      getScore() {
        try {
          // Common score selectors
          const scoreSelectors = [
            ".score",
            "#score",
            '[class*="score"]',
            '[id*="score"]',
            ".current-score",
            ".game-score",
          ];
    
          for (const selector of scoreSelectors) {
            const element = document.querySelector(selector);
            if (element) {
              const text = element.textContent || element.innerText;
              const score = parseInt(text.replace(/[^\d]/g, ""), 10);
              if (!isNaN(score)) {
                return score;
              }
            }
          }
    
          return null;
        } catch (error) {
          return null;
        }
      }
    
      /**
       * Detect game board using heuristic analysis
       * @private
       * @returns {{found: boolean, elements: Element[]|null, container: Element|null}}
       */
      _detectGameBoard() {
        const now = Date.now();
    
        // Return cached result if recent
        if (
          this._cachedBoardElements &&
          now - this._lastScanTime < this._scanCacheMs
        ) {
          return {
            found: true,
            elements: this._cachedBoardElements,
            container: this._cachedGameContainer,
          };
        }
    
        // Look for 4x4 grid patterns
        const candidates = this._findGridCandidates();
    
        for (const candidate of candidates) {
          const elements = this._extractGridElements(candidate);
          if (elements && elements.length === 16) {
            // Validate that elements contain numeric content
            const numericElements = elements.filter((el) =>
              this._hasNumericContent(el)
            );
    
            // Accept if at least 2 elements have numeric content (game in progress)
            if (numericElements.length >= 2) {
              this._cachedGameContainer = candidate;
              this._cachedBoardElements = elements;
              this._lastScanTime = now;
    
              return {
                found: true,
                elements: elements,
                container: candidate,
              };
            }
          }
        }
    
        return { found: false, elements: null, container: null };
      }
    
      /**
       * Find potential game container elements
       * @private
       * @returns {Element[]} Array of candidate elements
       */
      _findGridCandidates() {
        const candidates = [];
    
        // Look for common game container patterns
        const containerSelectors = [
          '[class*="game"]',
          '[class*="board"]',
          '[class*="grid"]',
          '[id*="game"]',
          '[id*="board"]',
          '[id*="grid"]',
          "canvas", // Some games use canvas
          ".container",
        ];
    
        for (const selector of containerSelectors) {
          const elements = document.querySelectorAll(selector);
          candidates.push(...Array.from(elements));
        }
    
        // Also check for elements with 16 child elements (potential 4x4 grid)
        const allElements = document.querySelectorAll("*");
        for (const element of allElements) {
          if (element.children.length === 16) {
            candidates.push(element);
          }
        }
    
        // Remove duplicates and sort by likelihood
        const uniqueCandidates = [...new Set(candidates)];
        return uniqueCandidates.sort(
          (a, b) => this._scoreCandidate(b) - this._scoreCandidate(a)
        );
      }
    
      /**
       * Score candidate element based on likelihood of being a game board
       * @private
       * @param {Element} element Element to score
       * @returns {number} Score (higher is better)
       */
      _scoreCandidate(element) {
        let score = 0;
    
        const className = element.className.toLowerCase();
        const id = element.id.toLowerCase();
    
        // Boost score for game-related terms
        if (className.includes("game") || id.includes("game")) score += 10;
        if (className.includes("board") || id.includes("board")) score += 8;
        if (className.includes("grid") || id.includes("grid")) score += 6;
        if (className.includes("2048")) score += 15;
    
        // Boost for having 16 children (4x4 grid)
        if (element.children.length === 16) score += 20;
    
        // Boost for square-ish dimensions
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const aspectRatio = rect.width / rect.height;
          if (aspectRatio >= 0.8 && aspectRatio <= 1.2) score += 5;
        }
    
        return score;
      }
    
      /**
       * Extract grid elements from container
       * @private
       * @param {Element} container Container element
       * @returns {Element[]|null} Array of 16 elements or null
       */
      _extractGridElements(container) {
        // If container has exactly 16 children, use them
        if (container.children.length === 16) {
          return Array.from(container.children);
        }
    
        // Look for nested grid structures
        const gridElements = [];
    
        // Try to find 4 rows with 4 elements each
        const rows = Array.from(container.children);
        if (rows.length === 4) {
          for (const row of rows) {
            if (row.children.length === 4) {
              gridElements.push(...Array.from(row.children));
            } else {
              return null; // Not a valid 4x4 structure
            }
          }
    
          if (gridElements.length === 16) {
            return gridElements;
          }
        }
    
        return null;
      }
    
      /**
       * Check if element has numeric content
       * @private
       * @param {Element} element Element to check
       * @returns {boolean} True if element contains numbers
       */
      _hasNumericContent(element) {
        const text = (element.textContent || element.innerText || "").trim();
        return /\d+/.test(text);
      }
    
      /**
       * Extract numeric value from element
       * @private
       * @param {Element} element Element to extract from
       * @returns {number} Extracted value or 0
       */
      _extractValueFromElement(element) {
        const text = (element.textContent || element.innerText || "").trim();
        return BoardUtils.parseTileValue(text);
      }
    
      /**
       * Dispatch keyboard event for move
       * @private
       * @param {number} dir Direction
       */
      _dispatchKeyboardEvent(dir) {
        const key = this.keyMap[dir];
        const keyCode = this.keyCodeMap[dir];
    
        if (!key) return;
    
        // Try multiple targets
        const targets = [
          document.activeElement,
          this._cachedGameContainer,
          document.body,
          document.documentElement,
        ].filter(Boolean);
    
        for (const target of targets) {
          const keydownEvent = new KeyboardEvent("keydown", {
            key,
            keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true,
          });
    
          target.dispatchEvent(keydownEvent);
        }
      }
    
      /**
       * Simulate touch swipe gesture
       * @private
       * @param {number} dir Direction
       */
      _simulateTouch(dir) {
        try {
          const container = this._cachedGameContainer || document.body;
          const rect = container.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
    
          let startX = centerX,
            startY = centerY;
          let endX = centerX,
            endY = centerY;
    
          const swipeDistance = Math.min(rect.width, rect.height) * 0.3;
    
          switch (dir) {
            case Direction.UP:
              startY += swipeDistance / 2;
              endY -= swipeDistance / 2;
              break;
            case Direction.DOWN:
              startY -= swipeDistance / 2;
              endY += swipeDistance / 2;
              break;
            case Direction.LEFT:
              startX += swipeDistance / 2;
              endX -= swipeDistance / 2;
              break;
            case Direction.RIGHT:
              startX -= swipeDistance / 2;
              endX += swipeDistance / 2;
              break;
          }
    
          // Create and dispatch touch events
          const touchStart = new TouchEvent("touchstart", {
            touches: [
              new Touch({
                identifier: 0,
                target: container,
                clientX: startX,
                clientY: startY,
              }),
            ],
            bubbles: true,
            cancelable: true,
          });
    
          const touchEnd = new TouchEvent("touchend", {
            changedTouches: [
              new Touch({
                identifier: 0,
                target: container,
                clientX: endX,
                clientY: endY,
              }),
            ],
            bubbles: true,
            cancelable: true,
          });
    
          container.dispatchEvent(touchStart);
          setTimeout(() => container.dispatchEvent(touchEnd), 50);
        } catch (error) {
          // Touch events might not be supported, ignore silently
        }
      }
    }
    
    exports.GenericAdapter = GenericAdapter;
  },
  "./src/adapters/getmit-adapter.js": function (exports, module, require) {
    /**
     * @fileoverview Specific adapter for https://mitchgu.github.io/GetMIT/
     * Handles the unique DOM structure and interaction patterns of this site
     */
    
    const { Adapter, Direction, BoardUtils } = require("./src/adapters/adapter.js");
    
    /**
     * Adapter specifically for the GetMIT 2048 game
     * Handles site-specific DOM patterns and input methods
     */
    class GetMITAdapter extends Adapter {
      constructor() {
        super();
        this.keyMap = {
          [Direction.UP]: "ArrowUp",
          [Direction.RIGHT]: "ArrowRight",
          [Direction.DOWN]: "ArrowDown",
          [Direction.LEFT]: "ArrowLeft",
        };
        this.keyCodeMap = {
          [Direction.UP]: 38,
          [Direction.RIGHT]: 39,
          [Direction.DOWN]: 40,
          [Direction.LEFT]: 37,
        };
      }
    
      /**
       * Check if this adapter can attach to the GetMIT page
       */
      canAttach() {
        // Check for GetMIT specific indicators
        const isGetMITSite =
          window.location.hostname.includes("mitchgu.github.io") &&
          window.location.pathname.includes("GetMIT");
    
        if (!isGetMITSite) return false;
    
        // Look for game-specific elements
        const gameContainer =
          document.querySelector("#game-container") ||
          document.querySelector(".game-container") ||
          document.querySelector('[class*="game"]');
    
        const tiles =
          document.querySelectorAll('[class*="tile"]') ||
          document.querySelectorAll('[class*="cell"]') ||
          document.querySelectorAll(".grid-cell");
    
        return !!(gameContainer && tiles.length > 0);
      }
    
      /**
       * Extract current game state from GetMIT DOM structure
       * @returns {number[][]|null} 4x4 board matrix or null if extraction fails
       */
      readBoard() {
        try {
          const board = BoardUtils.createEmptyBoard();
    
          // Try multiple selector patterns that might be used
          const tileSelectors = [
            ".tile",
            '[class*="tile"]',
            ".grid-cell",
            '[class*="cell"]',
            ".game-cell",
          ];
    
          let tiles = null;
          for (const selector of tileSelectors) {
            tiles = document.querySelectorAll(selector);
            if (tiles.length > 0) break;
          }
    
          if (!tiles || tiles.length === 0) {
            // Fallback: look for any elements with numeric content in a grid-like structure
            return this._extractFromGenericGrid();
          }
    
          // If we have exactly 16 tiles, assume they're in row-major order
          if (tiles.length === 16) {
            for (let i = 0; i < 16; i++) {
              const row = Math.floor(i / 4);
              const col = i % 4;
              const value = this._extractTileValue(tiles[i]);
              board[row][col] = value;
            }
            return board;
          }
    
          // Otherwise, try to extract position information
          for (const tile of tiles) {
            const position = this._extractTilePosition(tile);
            const value = this._extractTileValue(tile);
    
            if (position && value > 0) {
              const { row, col } = position;
              if (row >= 0 && row < 4 && col >= 0 && col < 4) {
                board[row][col] = Math.max(board[row][col], value);
              }
            }
          }
    
          return board;
        } catch (error) {
          console.warn("GetMITAdapter: Failed to read board:", error);
          return null;
        }
      }
    
      /**
       * Send move command to GetMIT game
       * @param {0|1|2|3} dir Direction to move
       */
      sendMove(dir) {
        try {
          // Try keyboard events first
          this._dispatchKeyboardEvent(dir);
    
          // Also try touch simulation
          setTimeout(() => {
            this._simulateTouch(dir);
          }, 10);
    
          // Some games might use custom event handlers
          setTimeout(() => {
            this._tryCustomEvents(dir);
          }, 20);
        } catch (error) {
          console.warn("GetMITAdapter: Failed to send move:", error);
        }
      }
    
      /**
       * Get current score from GetMIT game
       * @returns {number|null} Current score or null if not found
       */
      getScore() {
        try {
          // Try common score element patterns
          const scoreSelectors = [
            ".score",
            "#score",
            ".current-score",
            '[class*="score"]',
            ".score-container .score",
          ];
    
          for (const selector of scoreSelectors) {
            const element = document.querySelector(selector);
            if (element) {
              const text = element.textContent || element.innerText;
              const score = parseInt(text.replace(/[^\d]/g, ""), 10);
              if (!isNaN(score)) {
                return score;
              }
            }
          }
    
          return null;
        } catch (error) {
          return null;
        }
      }
    
      /**
       * Check if GetMIT game is over
       * @returns {boolean} True if game over
       */
      isGameOver() {
        // Look for game over indicators
        const gameOverSelectors = [
          ".game-over",
          ".game-won",
          '[class*="game-over"]',
          '[class*="game-won"]',
          ".overlay",
        ];
    
        for (const selector of gameOverSelectors) {
          const element = document.querySelector(selector);
          if (element && element.style.display !== "none") {
            return true;
          }
        }
    
        return false;
      }
    
      /**
       * Extract tile position from element
       * @private
       * @param {Element} tile Tile element
       * @returns {{row: number, col: number}|null} Position or null
       */
      _extractTilePosition(tile) {
        try {
          // Look for position classes or data attributes
          const classes = Array.from(tile.classList);
    
          // Try various position class patterns
          const patterns = [
            /tile-position-(\d+)-(\d+)/,
            /pos-(\d+)-(\d+)/,
            /cell-(\d+)-(\d+)/,
            /r(\d+)c(\d+)/,
          ];
    
          for (const pattern of patterns) {
            for (const className of classes) {
              const match = className.match(pattern);
              if (match) {
                const col = parseInt(match[1], 10) - 1; // Convert to 0-based
                const row = parseInt(match[2], 10) - 1;
                return { row, col };
              }
            }
          }
    
          // Try data attributes
          const dataRow = tile.dataset.row || tile.dataset.y;
          const dataCol = tile.dataset.col || tile.dataset.column || tile.dataset.x;
    
          if (dataRow !== undefined && dataCol !== undefined) {
            return {
              row: parseInt(dataRow, 10),
              col: parseInt(dataCol, 10),
            };
          }
    
          return null;
        } catch (error) {
          return null;
        }
      }
    
      /**
       * Extract tile value from element
       * @private
       * @param {Element} tile Tile element
       * @returns {number} Tile value or 0
       */
      _extractTileValue(tile) {
        try {
          // Look for value in class names first
          const classes = Array.from(tile.classList);
          const valueClass = classes.find(
            (cls) => /tile-(\d+)/.test(cls) || /value-(\d+)/.test(cls)
          );
    
          if (valueClass) {
            const match = valueClass.match(/(\d+)/);
            if (match) {
              return parseInt(match[1], 10);
            }
          }
    
          // Try data attributes
          if (tile.dataset.value) {
            return parseInt(tile.dataset.value, 10) || 0;
          }
    
          // Fallback to text content
          const text = tile.textContent || tile.innerText;
          return BoardUtils.parseTileValue(text);
        } catch (error) {
          return 0;
        }
      }
    
      /**
       * Extract board from generic grid structure
       * @private
       * @returns {number[][]|null} Board matrix or null
       */
      _extractFromGenericGrid() {
        try {
          const board = BoardUtils.createEmptyBoard();
    
          // Look for container with 16 children
          const containers = document.querySelectorAll("*");
          for (const container of containers) {
            if (container.children.length === 16) {
              for (let i = 0; i < 16; i++) {
                const row = Math.floor(i / 4);
                const col = i % 4;
                const value = this._extractTileValue(container.children[i]);
                board[row][col] = value;
              }
              return board;
            }
          }
    
          return null;
        } catch (error) {
          return null;
        }
      }
    
      /**
       * Dispatch keyboard event
       * @private
       * @param {number} dir Direction
       */
      _dispatchKeyboardEvent(dir) {
        const key = this.keyMap[dir];
        const keyCode = this.keyCodeMap[dir];
    
        if (!key) return;
    
        // Try multiple targets
        const targets = [
          document.activeElement,
          document.querySelector("#game-container"),
          document.querySelector(".game-container"),
          document.body,
          document.documentElement,
        ].filter(Boolean);
    
        for (const target of targets) {
          const keydownEvent = new KeyboardEvent("keydown", {
            key,
            keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true,
          });
    
          const keyupEvent = new KeyboardEvent("keyup", {
            key,
            keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true,
          });
    
          target.dispatchEvent(keydownEvent);
          target.dispatchEvent(keyupEvent);
        }
      }
    
      /**
       * Simulate touch swipe
       * @private
       * @param {number} dir Direction
       */
      _simulateTouch(dir) {
        try {
          const gameContainer =
            document.querySelector("#game-container") ||
            document.querySelector(".game-container") ||
            document.body;
    
          const rect = gameContainer.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
    
          let startX = centerX,
            startY = centerY;
          let endX = centerX,
            endY = centerY;
    
          const swipeDistance = 100;
    
          switch (dir) {
            case Direction.UP:
              startY += swipeDistance / 2;
              endY -= swipeDistance / 2;
              break;
            case Direction.DOWN:
              startY -= swipeDistance / 2;
              endY += swipeDistance / 2;
              break;
            case Direction.LEFT:
              startX += swipeDistance / 2;
              endX -= swipeDistance / 2;
              break;
            case Direction.RIGHT:
              startX -= swipeDistance / 2;
              endX += swipeDistance / 2;
              break;
          }
    
          const touchStart = new TouchEvent("touchstart", {
            touches: [
              new Touch({
                identifier: 0,
                target: gameContainer,
                clientX: startX,
                clientY: startY,
              }),
            ],
            bubbles: true,
            cancelable: true,
          });
    
          const touchEnd = new TouchEvent("touchend", {
            changedTouches: [
              new Touch({
                identifier: 0,
                target: gameContainer,
                clientX: endX,
                clientY: endY,
              }),
            ],
            bubbles: true,
            cancelable: true,
          });
    
          gameContainer.dispatchEvent(touchStart);
          setTimeout(() => gameContainer.dispatchEvent(touchEnd), 50);
        } catch (error) {
          // Touch events might not be supported
        }
      }
    
      /**
       * Try custom event patterns that might be used by the game
       * @private
       * @param {number} dir Direction
       */
      _tryCustomEvents(dir) {
        try {
          const directionNames = ["up", "right", "down", "left"];
          const directionName = directionNames[dir];
    
          // Try custom events
          const customEvent = new CustomEvent("move", {
            detail: { direction: directionName },
            bubbles: true,
          });
    
          const gameContainer =
            document.querySelector("#game-container") ||
            document.querySelector(".game-container") ||
            document.body;
    
          gameContainer.dispatchEvent(customEvent);
        } catch (error) {
          // Custom events might not be supported
        }
      }
    }
    
    exports.GetMITAdapter = GetMITAdapter;
  },
  "./src/adapters/index.js": function (exports, module, require) {
    /**
     * @fileoverview Adapter system exports
     * Main entry point for the game detection and adapter system
     */
    
    // Base adapter interface and utilities
    const __reExport0 = require("./src/adapters/adapter.js");
    exports.Adapter = __reExport0.Adapter;
    exports.Direction = __reExport0.Direction;
    exports.BoardUtils = __reExport0.BoardUtils;
    
    // Specific adapter implementations
    const __reExport1 = require("./src/adapters/play2048-adapter.js");
    exports.Play2048Adapter = __reExport1.Play2048Adapter;
    const __reExport2 = require("./src/adapters/generic-adapter.js");
    exports.GenericAdapter = __reExport2.GenericAdapter;
    const __reExport3 = require("./src/adapters/getmit-adapter.js");
    exports.GetMITAdapter = __reExport3.GetMITAdapter;
    
    // Registry system
    const __reExport4 = require("./src/adapters/adapter-registry.js");
    exports.AdapterRegistry = __reExport4.AdapterRegistry;
    exports.globalAdapterRegistry = __reExport4.globalAdapterRegistry;
    
    /**
     * Convenience function to detect and get the best adapter for current page
     * @returns {Adapter|null} Best matching adapter or null
     */
    function detectGame() {
      return globalAdapterRegistry.detectAdapter();
    }
    
    /**
     * Convenience function to test if any game is detected on current page
     * @returns {boolean} True if a game is detected
     */
    function isGameDetected() {
      const adapter = detectGame();
      return adapter !== null;
    }
    
    /**
     * Get detailed information about adapter detection
     * @returns {Array} Array of adapter test results
     */
    function getDetectionInfo() {
      return globalAdapterRegistry.testAllAdapters();
    }
    
    exports.detectGame = detectGame;
    exports.isGameDetected = isGameDetected;
    exports.getDetectionInfo = getDetectionInfo;
  },
  "./src/adapters/play2048-adapter.js": function (exports, module, require) {
    /**
     * @fileoverview Adapter for play2048.co and similar implementations
     * Handles DOM selectors for tiles, score, and move execution
     */
    
    const { Adapter, Direction, BoardUtils } = require("./src/adapters/adapter.js");
    
    /**
     * Adapter for play2048.co style games
     * Detects games with .tile-container and .tile elements
     */
    class Play2048Adapter extends Adapter {
      constructor() {
        super();
        this.keyMap = {
          [Direction.UP]: "ArrowUp",
          [Direction.RIGHT]: "ArrowRight",
          [Direction.DOWN]: "ArrowDown",
          [Direction.LEFT]: "ArrowLeft",
        };
        this.keyCodeMap = {
          [Direction.UP]: 38,
          [Direction.RIGHT]: 39,
          [Direction.DOWN]: 40,
          [Direction.LEFT]: 37,
        };
      }
    
      /**
       * Check if this adapter can attach to the current page
       * Looks for play2048.co style DOM structure
       */
      canAttach() {
        // Look for tile container and at least one tile
        const tileContainer = document.querySelector(".tile-container");
        const tiles = document.querySelectorAll(".tile");
    
        // Also check for game container as additional validation
        const gameContainer = document.querySelector(".game-container");
    
        return !!(tileContainer && tiles.length > 0 && gameContainer);
      }
    
      /**
       * Extract current game state from DOM
       * @returns {number[][]|null} 4x4 board matrix or null if extraction fails
       */
      readBoard() {
        try {
          const board = BoardUtils.createEmptyBoard();
    
          // Get all tiles with position classes
          const tiles = document.querySelectorAll(".tile");
    
          for (const tile of tiles) {
            const position = this._extractTilePosition(tile);
            const value = this._extractTileValue(tile);
    
            if (position && value > 0) {
              const { row, col } = position;
              if (row >= 0 && row < 4 && col >= 0 && col < 4) {
                // Use the highest value if multiple tiles occupy same position
                board[row][col] = Math.max(board[row][col], value);
              }
            }
          }
    
          return board;
        } catch (error) {
          console.warn("Play2048Adapter: Failed to read board:", error);
          return null;
        }
      }
    
      /**
       * Send move command via keyboard events
       * @param {0|1|2|3} dir Direction to move
       */
      sendMove(dir) {
        try {
          // First try keyboard event
          this._dispatchKeyboardEvent(dir);
    
          // Small delay then try touch simulation as fallback
          setTimeout(() => {
            this._simulateTouch(dir);
          }, 10);
        } catch (error) {
          console.warn("Play2048Adapter: Failed to send move:", error);
        }
      }
    
      /**
       * Get current score from DOM
       * @returns {number|null} Current score or null if not found
       */
      getScore() {
        try {
          const selectors = [
            ".score-container .score",
            ".score-container",
            ".current-score",
            "#score",
          ];
    
          for (const selector of selectors) {
            const scoreElement = document.querySelector(selector);
            if (scoreElement) {
              // Ignore best score containers
              if (scoreElement.classList?.contains("best-container")) {
                continue;
              }
    
              const scoreText = (scoreElement.textContent || "").trim();
              if (!scoreText) continue;
    
              const sanitized = scoreText.replace(/[^\d]/g, "");
              if (!sanitized) continue;
    
              const score = parseInt(sanitized, 10);
              if (!Number.isNaN(score)) {
                return score;
              }
            }
          }
          return null;
        } catch (error) {
          return null;
        }
      }
    
      /**
       * Check if game is over by looking for game-over overlay
       * @returns {boolean} True if game over
       */
      isGameOver() {
        const gameOverElement = document.querySelector(".game-over");
        const gameWonElement = document.querySelector(".game-won");
        return !!(gameOverElement || gameWonElement);
      }
    
      /**
       * Extract tile position from CSS classes
       * @private
       * @param {Element} tile Tile element
       * @returns {{row: number, col: number}|null} Position or null
       */
      _extractTilePosition(tile) {
        try {
          // Look for position classes like "tile-position-1-2"
          const classes = Array.from(tile.classList);
          const positionClass = classes.find((cls) =>
            cls.startsWith("tile-position-")
          );
    
          if (positionClass) {
            const match = positionClass.match(/tile-position-(\d+)-(\d+)/);
            if (match) {
              // Convert from 1-based to 0-based indexing
              const col = parseInt(match[1], 10) - 1;
              const row = parseInt(match[2], 10) - 1;
              return { row, col };
            }
          }
    
          return null;
        } catch (error) {
          return null;
        }
      }
    
      /**
       * Extract tile value from element
       * @private
       * @param {Element} tile Tile element
       * @returns {number} Tile value or 0
       */
      _extractTileValue(tile) {
        try {
          // Look for tile-X class or text content
          const classes = Array.from(tile.classList);
          const valueClass = classes.find(
            (cls) =>
              cls.startsWith("tile-") &&
              cls !== "tile-container" &&
              !cls.startsWith("tile-position-")
          );
    
          if (valueClass) {
            const match = valueClass.match(/tile-(\d+)/);
            if (match) {
              return parseInt(match[1], 10);
            }
          }
    
          // Fallback to text content
          const text = tile.textContent || tile.innerText;
          return BoardUtils.parseTileValue(text);
        } catch (error) {
          return 0;
        }
      }
    
      /**
       * Dispatch keyboard event for move
       * @private
       * @param {number} dir Direction
       */
      _dispatchKeyboardEvent(dir) {
        const key = this.keyMap[dir];
        const keyCode = this.keyCodeMap[dir];
    
        if (!key) return;
    
        const target = document.activeElement || document.body;
    
        // Dispatch keydown event
        const keydownEvent = new KeyboardEvent("keydown", {
          key,
          keyCode,
          which: keyCode,
          bubbles: true,
          cancelable: true,
        });
    
        target.dispatchEvent(keydownEvent);
    
        // Also dispatch keyup for completeness
        const keyupEvent = new KeyboardEvent("keyup", {
          key,
          keyCode,
          which: keyCode,
          bubbles: true,
          cancelable: true,
        });
    
        target.dispatchEvent(keyupEvent);
      }
    
      /**
       * Simulate touch swipe gesture
       * @private
       * @param {number} dir Direction
       */
      _simulateTouch(dir) {
        try {
          const gameContainer =
            document.querySelector(".game-container") || document.body;
          const rect = gameContainer.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
    
          let startX = centerX,
            startY = centerY;
          let endX = centerX,
            endY = centerY;
    
          const swipeDistance = 100;
    
          switch (dir) {
            case Direction.UP:
              startY += swipeDistance / 2;
              endY -= swipeDistance / 2;
              break;
            case Direction.DOWN:
              startY -= swipeDistance / 2;
              endY += swipeDistance / 2;
              break;
            case Direction.LEFT:
              startX += swipeDistance / 2;
              endX -= swipeDistance / 2;
              break;
            case Direction.RIGHT:
              startX -= swipeDistance / 2;
              endX += swipeDistance / 2;
              break;
          }
    
          // Create touch events
          const touchStart = new TouchEvent("touchstart", {
            touches: [
              new Touch({
                identifier: 0,
                target: gameContainer,
                clientX: startX,
                clientY: startY,
              }),
            ],
            bubbles: true,
            cancelable: true,
          });
    
          const touchEnd = new TouchEvent("touchend", {
            changedTouches: [
              new Touch({
                identifier: 0,
                target: gameContainer,
                clientX: endX,
                clientY: endY,
              }),
            ],
            bubbles: true,
            cancelable: true,
          });
    
          gameContainer.dispatchEvent(touchStart);
          setTimeout(() => gameContainer.dispatchEvent(touchEnd), 50);
        } catch (error) {
          // Touch events might not be supported, ignore silently
        }
      }
    }
    
    exports.Play2048Adapter = Play2048Adapter;
  },
  "./src/driver/driver.js": function (exports, module, require) {
    /**
     * @fileoverview Basic move execution system (Driver)
     * Implements naive DOM-change loop with throttling and verification
     */
    
    const { detectGame, BoardUtils, Direction } = require("./src/adapters/index.js");
    
    /**
     * Driver class for automated game execution
     * Handles move execution, throttling, and change detection
     */
    class Driver {
      constructor(options = {}) {
        this.adapter = null;
        this.isRunning = false;
        this.isPaused = false;
        this.solverEngine = null;
    
        // Configuration
        this.config = {
          throttleMs: options.throttleMs || 130,
          domChangeTimeoutMs: options.domChangeTimeoutMs || 120,
          directionBias: options.directionBias || Direction.LEFT,
          pauseWhenHidden: options.pauseWhenHidden !== false,
          maxRetries: options.maxRetries || 3,
          stuckThreshold: options.stuckThreshold || 5,
        };
    
        // State tracking
        this.lastBoard = null;
        this.lastBoardHash = "";
        this.moveCount = 0;
        this.stuckCount = 0;
        this.directionPriority = [
          Direction.LEFT,
          Direction.DOWN,
          Direction.RIGHT,
          Direction.UP,
        ];
    
        // Callbacks
        this.onMove = null;
        this.onBoardChange = null;
        this.onGameOver = null;
        this.onError = null;
    
        // Bind methods
        this.tick = this.tick.bind(this);
        this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
    
        // Listen for visibility changes
        document.addEventListener("visibilitychange", this.handleVisibilityChange);
      }
    
      /**
       * Set the adapter to use for game interaction
       * @param {Adapter} adapter Game adapter instance
       */
      setAdapter(adapter) {
        this.adapter = adapter;
        this.reset();
      }
    
      /**
       * Set direction priority for move attempts
       * @param {number[]} priorities Array of direction constants in priority order
       */
      setDirectionPriority(priorities) {
        if (Array.isArray(priorities) && priorities.length === 4) {
          this.directionPriority = [...priorities];
        }
      }
    
      /**
       * Attach a solver engine to generate move priorities.
       * @param {Object|null} engine Solver engine with getMoveOrder(board) method
       */
      setSolverEngine(engine) {
        this.solverEngine = engine || null;
      }
    
      /**
       * Start the automated driving loop
       */
      start() {
        if (this.isRunning) {
          console.warn("Driver already running");
          return;
        }
    
        if (!this.adapter) {
          throw new Error("No adapter set. Call setAdapter() first.");
        }
    
        this.isRunning = true;
        this.isPaused = false;
        this.reset();
    
        console.log("Driver started");
        this.tick();
      }
    
      /**
       * Stop the automated driving loop
       */
      stop() {
        this.isRunning = false;
        this.isPaused = false;
        console.log("Driver stopped");
      }
    
      /**
       * Pause the driving loop
       */
      pause() {
        this.isPaused = true;
        console.log("Driver paused");
      }
    
      /**
       * Resume the driving loop
       */
      resume() {
        if (this.isRunning && this.isPaused) {
          this.isPaused = false;
          console.log("Driver resumed");
          this.tick();
        }
      }
    
      /**
       * Execute a single step manually
       * @returns {Promise<boolean>} True if move was successful
       */
      async step() {
        if (!this.adapter) {
          throw new Error("No adapter set");
        }
    
        return await this.executeMove();
      }
    
      /**
       * Reset driver state
       * @private
       */
      reset() {
        this.lastBoard = null;
        this.lastBoardHash = "";
        this.moveCount = 0;
        this.stuckCount = 0;
      }
    
      /**
       * Main driving loop tick
       * @private
       */
      async tick() {
        if (!this.isRunning) return;
    
        // Pause if document is hidden and configured to do so
        if (this.config.pauseWhenHidden && document.visibilityState !== "visible") {
          setTimeout(this.tick, 250);
          return;
        }
    
        // Pause if explicitly paused
        if (this.isPaused) {
          setTimeout(this.tick, 250);
          return;
        }
    
        try {
          // Check if game is over
          if (this.adapter.isGameOver && this.adapter.isGameOver()) {
            this.stop();
            if (this.onGameOver) {
              this.onGameOver();
            }
            return;
          }
    
          // Execute move
          const moveSuccessful = await this.executeMove();
    
          if (!moveSuccessful) {
            this.stuckCount++;
    
            // If stuck too many times, try random moves
            if (this.stuckCount >= this.config.stuckThreshold) {
              await this.executeRandomMove();
              this.stuckCount = 0;
            }
          } else {
            this.stuckCount = 0;
          }
    
          // Continue loop with throttling
          setTimeout(this.tick, this.config.throttleMs);
        } catch (error) {
          console.error("Driver tick error:", error);
          if (this.onError) {
            this.onError(error);
          }
    
          // Continue loop even after error
          setTimeout(this.tick, this.config.throttleMs * 2);
        }
      }
    
      /**
       * Execute a move using direction priority
       * @private
       * @returns {Promise<boolean>} True if any move was successful
       */
      async executeMove() {
        const boardBefore = this.adapter.readBoard();
        if (!boardBefore) {
          return false;
        }
    
        const hashBefore = BoardUtils.hashBoard(boardBefore);
        const movePriority = await this.getMovePriority(boardBefore);
    
        for (const direction of movePriority) {
          const success = await this.tryMove(direction, hashBefore);
          if (success) {
            this.moveCount++;
            if (this.onMove) {
              this.onMove(direction, this.moveCount);
            }
            return true;
          }
        }
    
        return false;
      }
    
      /**
       * Try a specific move direction
       * @private
       * @param {number} direction Direction to try
       * @param {string} hashBefore Board hash before move
       * @returns {Promise<boolean>} True if move was successful
       */
      async tryMove(direction, hashBefore) {
        try {
          // Send the move
          this.adapter.sendMove(direction);
    
          // Wait for DOM changes
          await this.waitForDOMChange();
    
          // Check if board changed
          const boardAfter = this.adapter.readBoard();
          if (!boardAfter) {
            return false;
          }
    
          const hashAfter = BoardUtils.hashBoard(boardAfter);
          const changed = hashAfter !== hashBefore;
    
          if (changed) {
            this.lastBoard = boardAfter;
            this.lastBoardHash = hashAfter;
    
            if (this.onBoardChange) {
              this.onBoardChange(boardAfter);
            }
          }
    
          return changed;
        } catch (error) {
          console.warn(`Failed to execute move ${direction}:`, error);
          return false;
        }
      }
    
      /**
       * Compute ordered directions using solver engine if available.
       * @private
       * @param {number[][]} board
       * @returns {Promise<number[]>}
       */
      async getMovePriority(board) {
        const fallback = [...this.directionPriority];
    
        if (!this.solverEngine || typeof this.solverEngine.getMoveOrder !== "function") {
          return fallback;
        }
    
        try {
          const nextDirections = await this.solverEngine.getMoveOrder(board);
          return normalizeMovePriority(nextDirections, fallback);
        } catch (error) {
          console.warn("Driver: solver getMoveOrder failed", error);
          if (this.onError) {
            this.onError(error);
          }
          return fallback;
        }
      }
    
      /**
       * Execute a random move when stuck
       * @private
       * @returns {Promise<boolean>} True if move was successful
       */
      async executeRandomMove() {
        const priority = await this.getMovePriority(
          this.adapter.readBoard() || BoardUtils.createEmptyBoard(),
        );
        const randomDirection = priority[Math.floor(Math.random() * priority.length)] ?? 0;
        console.log(`Driver stuck, trying random direction: ${randomDirection}`);
    
        const boardBefore = this.adapter.readBoard();
        if (!boardBefore) return false;
    
        const hashBefore = BoardUtils.hashBoard(boardBefore);
        return await this.tryMove(randomDirection, hashBefore);
      }
    
      /**
       * Wait for DOM changes with timeout
       * @private
       * @returns {Promise<void>}
       */
      waitForDOMChange() {
        return new Promise((resolve) => {
          setTimeout(resolve, this.config.domChangeTimeoutMs);
        });
      }
    
      /**
       * Handle visibility change events
       * @private
       */
      handleVisibilityChange() {
        if (this.config.pauseWhenHidden && this.isRunning) {
          if (document.visibilityState === "visible") {
            console.log("Driver: Page visible, resuming");
            if (this.isPaused) {
              this.resume();
            }
          } else {
            console.log("Driver: Page hidden, pausing");
            this.pause();
          }
        }
      }
    
      /**
       * Get current driver statistics
       * @returns {Object} Statistics object
       */
      getStats() {
        return {
          isRunning: this.isRunning,
          isPaused: this.isPaused,
          moveCount: this.moveCount,
          stuckCount: this.stuckCount,
          lastBoardHash: this.lastBoardHash,
          adapterName: this.adapter ? this.adapter.getName() : null,
        };
      }
    
      /**
       * Update configuration
       * @param {Object} newConfig Configuration updates
       */
      updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
      }
    
      /**
       * Destroy driver and clean up
       */
      destroy() {
        this.stop();
        document.removeEventListener(
          "visibilitychange",
          this.handleVisibilityChange
        );
    
        this.adapter = null;
        this.solverEngine = null;
        this.onMove = null;
        this.onBoardChange = null;
        this.onGameOver = null;
        this.onError = null;
      }
    }
    
    /**
     * Create a new driver instance with auto-detection
     * @param {Object} options Driver configuration options
     * @returns {Driver} Driver instance
     */
    function createDriver(options = {}) {
      const driver = new Driver(options);
    
      // Auto-detect adapter if not provided
      const adapter = detectGame();
      if (adapter) {
        driver.setAdapter(adapter);
      }
    
      return driver;
    }
    
    /**
     * Sanitize solver-provided direction order.
     * @param {number[]} directions
     * @param {number[]} fallback
     * @returns {number[]}
     */
    function normalizeMovePriority(directions, fallback) {
      const result = [];
      const seen = new Set();
    
      const append = (dir) => {
        if (!Number.isInteger(dir)) return;
        if (dir < 0 || dir > 3) return;
        if (seen.has(dir)) return;
        seen.add(dir);
        result.push(dir);
      };
    
      if (Array.isArray(directions)) {
        directions.forEach(append);
      }
    
      (fallback || []).forEach(append);
    
      for (let dir = 0; dir < 4 && result.length < 4; dir++) {
        append(dir);
      }
    
      return result.slice(0, 4);
    }
    
    exports.Driver = Driver;
    exports.createDriver = createDriver;
  },
  "./src/driver/index.js": function (exports, module, require) {
    /**
     * @fileoverview Driver system exports
     * Main entry point for the move execution system
     */
    
    const __reExport0 = require("./src/driver/driver.js");
    exports.Driver = __reExport0.Driver;
    exports.createDriver = __reExport0.createDriver;
    
  },
  "./src/hud/config.js": function (exports, module, require) {
    /**
     * @fileoverview Shared configuration values for the HUD layer
     */
    
    const { Direction } = require("./src/adapters/index.js");
    
    /**
     * Default move priority order when no user preference is set.
     * @type {number[]}
     */
    const DEFAULT_DIRECTION_PRIORITY = [
      Direction.LEFT,
      Direction.DOWN,
      Direction.RIGHT,
      Direction.UP,
    ];
    
    /**
     * Default solver configuration that mirrors the runtime defaults.
     * @type {{type: string, heuristic: string, depth: number, probability: number}}
     */
    const DEFAULT_SOLVER_CONFIG = {
      type: "expectimax-depth",
      heuristic: "corner",
      depth: 4,
      probability: 0.0025,
    };
    
    /**
     * Limits enforced for solver tuning inputs.
     */
    const SOLVER_LIMITS = {
      MIN_DEPTH: 1,
      MAX_DEPTH: 8,
      MIN_PROBABILITY: 0.0001,
      MAX_PROBABILITY: 0.2,
    };
    
    /**
     * Clamp solver settings to safe bounds while preserving precision.
     * @param {{depth:number, probability:number}} config Partial solver config
     * @returns {{depth:number, probability:number}} Normalised values
     */
    function clampSolverConfig({ depth, probability }) {
      const safeDepth = Math.max(
        SOLVER_LIMITS.MIN_DEPTH,
        Math.min(SOLVER_LIMITS.MAX_DEPTH, depth || SOLVER_LIMITS.MIN_DEPTH),
      );
    
      const safeProbability = Math.max(
        SOLVER_LIMITS.MIN_PROBABILITY,
        Math.min(SOLVER_LIMITS.MAX_PROBABILITY, probability || SOLVER_LIMITS.MIN_PROBABILITY),
      );
    
      return {
        depth: safeDepth,
        probability: safeProbability,
      };
    }
    
    exports.clampSolverConfig = clampSolverConfig;
    exports.DEFAULT_DIRECTION_PRIORITY = DEFAULT_DIRECTION_PRIORITY;
    exports.DEFAULT_SOLVER_CONFIG = DEFAULT_SOLVER_CONFIG;
    exports.SOLVER_LIMITS = SOLVER_LIMITS;
  },
  "./src/hud/hud.js": function (exports, module, require) {
    /**
     * @fileoverview Shadow DOM HUD overlay for 2048 solver
     * Breaks the HUD into controller and view layers for maintainability.
     */
    
    const { detectGame } = require("./src/adapters/index.js");
    const { DEFAULT_DIRECTION_PRIORITY, DEFAULT_SOLVER_CONFIG, clampSolverConfig } = require("./src/hud/config.js");
    const { HUDView } = require("./src/hud/view.js");
    
    /**
     * HUD overlay controller coordinates the runtime interactions while delegating
     * DOM management to {@link HUDView}.
     */
    class HUD {
      constructor() {
        this.view = new HUDView({
          onDetect: this.handleDetectClick.bind(this),
          onAutoSolve: this.handleAutoSolveClick.bind(this),
          onStep: this.handleStepClick.bind(this),
          onCollapse: this.handleCollapseToggle.bind(this),
          onDirectionPriorityChange: this.handleDirectionPriorityChange.bind(this),
          onSolverControlChange: this.handleSolverControlChange.bind(this),
        });
    
        this.isCollapsed = false;
        this.currentAdapter = null;
        this.controller = null;
        this.isAutoSolving = false;
        this.autoSolveTimeout = null;
    
        this.directionPriority = [...DEFAULT_DIRECTION_PRIORITY];
        this.solverConfig = { ...DEFAULT_SOLVER_CONFIG };
    
        this.isInitialized = false;
      }
    
      /**
       * Initialize and inject the HUD into the page
       */
      init() {
        if (this.isInitialized) {
          console.warn("HUD already initialized");
          return;
        }
    
        this.view.mount();
        this.view.setDirectionPriority(this.directionPriority);
        this.view.setSolverControlValues(this.solverConfig);
        this.applySolverControlState();
    
        this.updateStatus();
        this.updateSolverStatus(null);
    
        this.isInitialized = true;
    
        console.log("HUD initialized");
      }
    
      /**
       * Enable/disable solver inputs based on selected strategy
       * @private
       */
      applySolverControlState() {
        const isProbability = this.solverConfig.type === "expectimax-probability";
        this.view.setSolverControlAvailability(!isProbability, isProbability);
      }
    
      /**
       * Handle updates to solver configuration controls
       * @private
       * @param {{type:string, heuristic:string, depth:number, probability:number}} nextConfig
       */
      handleSolverControlChange(nextConfig) {
        const clamped = clampSolverConfig(nextConfig);
    
        this.solverConfig = {
          ...this.solverConfig,
          ...nextConfig,
          depth: clamped.depth,
          probability: clamped.probability,
        };
    
        this.view.setSolverControlValues(this.solverConfig);
        this.applySolverControlState();
    
        if (this.controller && this.controller.setSolverStrategy) {
          try {
            this.controller.setSolverStrategy({ ...this.solverConfig });
          } catch (error) {
            console.warn("HUD: Failed to update solver strategy", error);
          }
        }
      }
    
      /**
       * Apply solver status indicator and synchronize controls
       * @param {Object|null} status Solver status from runtime
       */
      updateSolverStatus(status) {
        const state = {
          text: "Initializing…",
          color: "#fbbf24",
          title: "Solver is starting",
        };
    
        if (status) {
          if (status.status === "ready" && status.mode === "wasm") {
            state.text = "WASM ready";
            state.color = "#34d399";
            state.title = "Native solver active";
          } else if (status.status === "ready" || status.mode === "fallback") {
            state.text = "Fallback";
            state.color = "#facc15";
            state.title = "Using JS fallback solver";
          } else if (status.status === "fallback") {
            state.text = "Fallback";
            state.color = "#facc15";
            state.title = "Using JS fallback solver";
          } else if (status.status === "error") {
            state.text = "Error";
            state.color = "#f87171";
            state.title = status.lastError ? String(status.lastError) : "Solver error";
          } else if (status.status === "idle" || status.status === "loading") {
            state.text = "Loading…";
            state.color = "#fbbf24";
            state.title = "Loading solver";
          }
    
          if (status.lastError) {
            state.title = `Fallback: ${status.lastError}`;
          }
        }
    
        this.view.setSolverStatus(state);
    
        if (status && status.strategy) {
          const clamped = clampSolverConfig(status.strategy);
          this.solverConfig = {
            ...this.solverConfig,
            ...status.strategy,
            depth: clamped.depth,
            probability: clamped.probability,
          };
    
          this.view.setSolverControlValues(this.solverConfig);
          this.applySolverControlState();
        }
      }
    
      /**
       * Update HUD labels based on adapter availability
       */
      updateStatus() {
        if (this.controller && this.controller.getCurrentAdapter) {
          const controllerAdapter = this.controller.getCurrentAdapter();
          if (controllerAdapter) {
            this.currentAdapter = controllerAdapter;
          }
        }
    
        if (this.currentAdapter) {
          this.view.setGameStatus({
            text: `${this.currentAdapter.getName()}`,
            color: "#34d399",
          });
    
          const score = this.currentAdapter.getScore();
          this.view.setScore(score !== null ? score.toLocaleString() : "-");
          this.view.setControlsEnabled({ autoSolve: true, step: true });
        } else {
          this.view.setGameStatus({ text: "Not detected", color: "#f87171" });
          this.view.setScore("-");
          this.view.setControlsEnabled({ autoSolve: false, step: false });
        }
    
        if (this.controller && this.controller.getSolverStatus) {
          try {
            const solverStatus = this.controller.getSolverStatus();
            this.updateSolverStatus(solverStatus || null);
          } catch (error) {
            console.warn("HUD: Failed to refresh solver status", error);
          }
        }
      }
    
      /**
       * Handle direction priority changes from the UI.
       * @private
       * @param {number[]} priorities
       */
      handleDirectionPriorityChange(priorities) {
        if (!Array.isArray(priorities) || priorities.length === 0) {
          return;
        }
    
        this.directionPriority = priorities;
    
        if (this.controller && this.controller.setDirectionPriority) {
          try {
            this.controller.setDirectionPriority([...priorities]);
          } catch (error) {
            console.warn("HUD: Failed to update direction priority via controller", error);
          }
        }
      }
    
      /**
       * Handle collapse button toggle to update local state.
       * @param {boolean} isCollapsed
       * @private
       */
      handleCollapseToggle(isCollapsed) {
        this.isCollapsed = Boolean(isCollapsed);
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
    
        if (!this.currentAdapter) {
          this.showMessage("No game detected.");
        }
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
    
        await this.executeStep();
        this.updateStatus();
      }
    
      /**
       * Update run state UI to reflect automation status
       * @param {boolean} isRunning Whether automation is active
       */
      updateRunState(isRunning) {
        this.isAutoSolving = !!isRunning;
        this.view.setAutoSolveRunning(this.isAutoSolving);
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
    
        if (this.currentAdapter.isGameOver()) {
          this.stopAutoSolve();
          this.showMessage("Game over!");
          return;
        }
    
        await this.executeStep();
        this.updateStatus();
    
        this.autoSolveTimeout = setTimeout(() => {
          this.autoSolveLoop();
        }, 150);
      }
    
      /**
       * Execute a single move iteration
       * @private
       */
      async executeStep() {
        if (!this.currentAdapter) return;
    
        const boardBefore = this.currentAdapter.readBoard();
        if (!boardBefore) return;
    
        for (const direction of this.directionPriority) {
          this.currentAdapter.sendMove(direction);
    
          await new Promise((resolve) => setTimeout(resolve, 120));
    
          const boardAfter = this.currentAdapter.readBoard();
          if (
            boardAfter &&
            JSON.stringify(boardBefore) !== JSON.stringify(boardAfter)
          ) {
            return;
          }
        }
    
        const randomDir = Math.floor(Math.random() * 4);
        this.currentAdapter.sendMove(randomDir);
      }
    
      /**
       * Show temporary message via the view layer
       * @private
       * @param {string} message
       */
      showMessage(message) {
        this.view.showMessage(message);
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
    
        if (this.controller && this.controller.getSolverStatus) {
          try {
            const solverStatus = this.controller.getSolverStatus();
            this.updateSolverStatus(solverStatus || null);
          } catch (error) {
            console.warn("HUD: Failed to fetch solver status", error);
          }
        } else {
          this.updateSolverStatus(null);
        }
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
    
        this.view.destroy();
    
        this.currentAdapter = null;
        this.controller = null;
        this.isInitialized = false;
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
    function initHUD() {
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
    function getHUD() {
      return globalHUD;
    }
    
    /**
     * Destroy current HUD instance
     */
    function destroyHUD() {
      if (globalHUD) {
        globalHUD.destroy();
        globalHUD = null;
      }
    }
    
    exports.HUD = HUD;
    exports.initHUD = initHUD;
    exports.getHUD = getHUD;
    exports.destroyHUD = destroyHUD;
  },
  "./src/hud/index.js": function (exports, module, require) {
    /**
     * @fileoverview HUD system exports
     * Main entry point for the Shadow DOM HUD overlay
     */
    
    const __reExport0 = require("./src/hud/hud.js");
    exports.HUD = __reExport0.HUD;
    exports.initHUD = __reExport0.initHUD;
    exports.getHUD = __reExport0.getHUD;
    exports.destroyHUD = __reExport0.destroyHUD;
    
  },
  "./src/hud/templates.js": function (exports, module, require) {
    /**
     * @fileoverview Markup and style templates for the HUD shadow DOM
     */
    
    /**
     * Returns the CSS rules injected inside the HUD shadow root.
     * @returns {string}
     */
    function getHUDCSS() {
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
    function getHUDHTML() {
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
    
    exports.getHUDCSS = getHUDCSS;
    exports.getHUDHTML = getHUDHTML;
  },
  "./src/hud/view.js": function (exports, module, require) {
    /**
     * @fileoverview Presentation layer for the HUD overlay
     */
    
    const { getHUDHTML } = require("./src/hud/templates.js");
    
    const COLLAPSE_ICON = {
      COLLAPSED: "+",
      EXPANDED: "−",
    };
    
    /**
     * Encapsulates the DOM management for the HUD overlay so controller logic can
     * remain focused on behaviour instead of markup manipulation.
     */
    class HUDView {
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
    
    exports.HUDView = HUDView;
  },
  "./src/observer/index.js": function (exports, module, require) {
    /**
     * @fileoverview Observer system exports
     * Main entry point for change detection and visibility handling
     */
    
    const __reExport0 = require("./src/observer/mutation-observer.js");
    exports.GameMutationObserver = __reExport0.GameMutationObserver;
    exports.createGameObserver = __reExport0.createGameObserver;
    const __reExport1 = require("./src/observer/visibility-handler.js");
    exports.VisibilityHandler = __reExport1.VisibilityHandler;
    exports.getVisibilityHandler = __reExport1.getVisibilityHandler;
    exports.destroyVisibilityHandler = __reExport1.destroyVisibilityHandler;
    
  },
  "./src/observer/mutation-observer.js": function (exports, module, require) {
    /**
     * @fileoverview MutationObserver for change detection and game monitoring
     * Provides efficient DOM change detection for game state monitoring
     */
    
    const { BoardUtils } = require("./src/adapters/index.js");
    
    /**
     * Enhanced MutationObserver for game state monitoring
     * Watches for DOM changes that indicate game moves or state changes
     */
    class GameMutationObserver {
      constructor(adapter, options = {}) {
        this.adapter = adapter;
        this.observer = null;
        this.isObserving = false;
    
        // Configuration
        this.config = {
          debounceMs: options.debounceMs || 50,
          maxCallbacksPerSecond: options.maxCallbacksPerSecond || 20,
          watchAttributes: options.watchAttributes !== false,
          watchChildList: options.watchChildList !== false,
          watchSubtree: options.watchSubtree !== false,
        };
    
        // State tracking
        this.lastBoardHash = "";
        this.lastChangeTime = 0;
        this.changeCount = 0;
        this.debounceTimer = null;
    
        // Callbacks
        this.onBoardChange = null;
        this.onGameStateChange = null;
        this.onError = null;
    
        // Bind methods
        this.handleMutations = this.handleMutations.bind(this);
        this.debouncedCheck = this.debouncedCheck.bind(this);
      }
    
      /**
       * Start observing DOM changes
       * @param {Element} [targetElement] Specific element to observe, or auto-detect
       */
      startObserving(targetElement = null) {
        if (this.isObserving) {
          console.warn("GameMutationObserver already observing");
          return;
        }
    
        if (!this.adapter) {
          throw new Error("No adapter set");
        }
    
        // Determine target element
        const target = targetElement || this.findGameContainer();
        if (!target) {
          console.warn("Could not find game container to observe");
          return;
        }
    
        // Create observer
        this.observer = new MutationObserver(this.handleMutations);
    
        // Configure observation options
        const observerConfig = {
          childList: this.config.watchChildList,
          attributes: this.config.watchAttributes,
          subtree: this.config.watchSubtree,
          attributeOldValue: false,
          characterData: true,
          characterDataOldValue: false,
        };
    
        // Start observing
        this.observer.observe(target, observerConfig);
        this.isObserving = true;
    
        // Initialize baseline
        this.updateBaseline();
    
        console.log(
          `GameMutationObserver started on ${target.tagName}${
            target.className ? "." + target.className : ""
          }`
        );
      }
    
      /**
       * Stop observing DOM changes
       */
      stopObserving() {
        if (!this.isObserving) return;
    
        if (this.observer) {
          this.observer.disconnect();
          this.observer = null;
        }
    
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
          this.debounceTimer = null;
        }
    
        this.isObserving = false;
        console.log("GameMutationObserver stopped");
      }
    
      /**
       * Handle mutation events
       * @private
       * @param {MutationRecord[]} mutations Array of mutation records
       */
      handleMutations(mutations) {
        if (!this.isObserving) return;
    
        // Rate limiting
        const now = Date.now();
        if (now - this.lastChangeTime < 1000 / this.config.maxCallbacksPerSecond) {
          return;
        }
    
        // Check if mutations are relevant to game state
        const relevantMutations = mutations.filter((mutation) =>
          this.isRelevantMutation(mutation)
        );
    
        if (relevantMutations.length === 0) return;
    
        // Debounce the actual check
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
    
        this.debounceTimer = setTimeout(
          this.debouncedCheck,
          this.config.debounceMs
        );
      }
    
      /**
       * Check if a mutation is relevant to game state
       * @private
       * @param {MutationRecord} mutation Mutation record
       * @returns {boolean} True if mutation is relevant
       */
      isRelevantMutation(mutation) {
        const target = mutation.target;
    
        // Check for tile-related changes
        if (target.nodeType === Node.ELEMENT_NODE) {
          const element = /** @type {Element} */ (target);
          const className = element.className || "";
          const id = element.id || "";
    
          // Look for game-related class names
          const gameRelatedTerms = [
            "tile",
            "cell",
            "grid",
            "board",
            "game",
            "score",
          ];
          const isGameRelated = gameRelatedTerms.some(
            (term) =>
              className.toLowerCase().includes(term) ||
              id.toLowerCase().includes(term)
          );
    
          if (isGameRelated) return true;
        }
    
        // Check for text content changes (score updates, tile values)
        if (mutation.type === "characterData") {
          const text = mutation.target.textContent || "";
          // Look for numeric content that might be scores or tile values
          if (/\d+/.test(text)) return true;
        }
    
        // Check for attribute changes on game elements
        if (mutation.type === "attributes") {
          const element = /** @type {Element} */ (mutation.target);
          const attrName = mutation.attributeName;
    
          // Position or style changes might indicate tile movement
          if (
            attrName === "class" ||
            attrName === "style" ||
            attrName === "data-position"
          ) {
            return true;
          }
        }
    
        return false;
      }
    
      /**
       * Debounced check for actual game state changes
       * @private
       */
      debouncedCheck() {
        try {
          const currentBoard = this.adapter.readBoard();
          if (!currentBoard) return;
    
          const currentHash = BoardUtils.hashBoard(currentBoard);
    
          if (currentHash !== this.lastBoardHash) {
            this.lastBoardHash = currentHash;
            this.lastChangeTime = Date.now();
            this.changeCount++;
    
            if (this.onBoardChange) {
              this.onBoardChange(currentBoard, this.changeCount);
            }
          }
    
          // Check for game state changes (game over, score changes, etc.)
          this.checkGameStateChanges();
        } catch (error) {
          console.warn("GameMutationObserver check error:", error);
          if (this.onError) {
            this.onError(error);
          }
        }
      }
    
      /**
       * Check for game state changes beyond board state
       * @private
       */
      checkGameStateChanges() {
        try {
          const gameState = {
            isGameOver: this.adapter.isGameOver ? this.adapter.isGameOver() : false,
            score: this.adapter.getScore ? this.adapter.getScore() : null,
            timestamp: Date.now(),
          };
    
          if (this.onGameStateChange) {
            this.onGameStateChange(gameState);
          }
        } catch (error) {
          // Ignore errors in optional state checks
        }
      }
    
      /**
       * Find the game container element to observe
       * @private
       * @returns {Element|null} Game container element or null
       */
      findGameContainer() {
        // Try to get container from adapter if it has one
        if (this.adapter._cachedGameContainer) {
          return this.adapter._cachedGameContainer;
        }
    
        // Common game container selectors
        const containerSelectors = [
          ".game-container",
          ".tile-container",
          "#game-container",
          '[class*="game"]',
          '[class*="board"]',
          '[class*="grid"]',
        ];
    
        for (const selector of containerSelectors) {
          const element = document.querySelector(selector);
          if (element) return element;
        }
    
        // Fallback to body
        return document.body;
      }
    
      /**
       * Update baseline board state
       * @private
       */
      updateBaseline() {
        try {
          const board = this.adapter.readBoard();
          if (board) {
            this.lastBoardHash = BoardUtils.hashBoard(board);
          }
        } catch (error) {
          console.warn("Failed to update baseline:", error);
        }
      }
    
      /**
       * Get observer statistics
       * @returns {Object} Statistics object
       */
      getStats() {
        return {
          isObserving: this.isObserving,
          changeCount: this.changeCount,
          lastChangeTime: this.lastChangeTime,
          lastBoardHash: this.lastBoardHash,
          adapterName: this.adapter ? this.adapter.getName() : null,
        };
      }
    
      /**
       * Reset observer state
       */
      reset() {
        this.lastBoardHash = "";
        this.lastChangeTime = 0;
        this.changeCount = 0;
        this.updateBaseline();
      }
    
      /**
       * Destroy observer and clean up
       */
      destroy() {
        this.stopObserving();
        this.adapter = null;
        this.onBoardChange = null;
        this.onGameStateChange = null;
        this.onError = null;
      }
    }
    
    /**
     * Create a game mutation observer with auto-detection
     * @param {Adapter} adapter Game adapter
     * @param {Object} options Observer options
     * @returns {GameMutationObserver} Observer instance
     */
    function createGameObserver(adapter, options = {}) {
      return new GameMutationObserver(adapter, options);
    }
    
    exports.GameMutationObserver = GameMutationObserver;
    exports.createGameObserver = createGameObserver;
  },
  "./src/observer/visibility-handler.js": function (exports, module, require) {
    /**
     * @fileoverview Visibility change handler for pause/resume functionality
     * Manages automation state based on page visibility
     */
    
    /**
     * Visibility handler for managing automation based on page visibility
     * Automatically pauses/resumes automation when page becomes hidden/visible
     */
    class VisibilityHandler {
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
    function getVisibilityHandler(options = {}) {
      if (!globalVisibilityHandler) {
        globalVisibilityHandler = new VisibilityHandler(options);
      }
      return globalVisibilityHandler;
    }
    
    /**
     * Destroy global visibility handler
     */
    function destroyVisibilityHandler() {
      if (globalVisibilityHandler) {
        globalVisibilityHandler.destroy();
        globalVisibilityHandler = null;
      }
    }
    
    exports.VisibilityHandler = VisibilityHandler;
    exports.getVisibilityHandler = getVisibilityHandler;
    exports.destroyVisibilityHandler = destroyVisibilityHandler;
  },
  "./src/runtime/content-script.js": function (exports, module, require) {
    /**
     * @fileoverview Content script entry point (MV3/WebExtension)
     * Entry point for browser extension content script
     */
    
    const { initRuntime, getRuntime, destroyRuntime } = require("./src/runtime/runtime.js");
    
    /**
     * Content script main function
     * Initializes the 2048 AI Solver in extension context
     */
    async function main() {
      try {
        // Check if we're in a valid context
        if (typeof chrome === "undefined" && typeof browser === "undefined") {
          console.warn("2048 AI Solver: Not running in extension context");
          return;
        }
    
        // Avoid double initialization
        if (getRuntime()) {
          console.log("2048 AI Solver: Already initialized");
          return;
        }
    
        console.log("2048 AI Solver: Initializing content script...");
    
        // Initialize runtime with extension-appropriate settings
        const runtime = await initRuntime({
          autoInit: false, // Don't auto-start in extension mode
          enableHUD: true,
          enableVisibilityHandling: true,
          enableMutationObserver: true,
        });
    
        console.log("2048 AI Solver: Content script initialized");
    
        // Set up extension messaging if available
        setupExtensionMessaging(runtime);
    
        // Make runtime available for debugging
        if (typeof window !== "undefined") {
          window.ai2048Runtime = runtime;
        }
      } catch (error) {
        console.error(
          "2048 AI Solver: Content script initialization failed:",
          error
        );
      }
    }
    
    /**
     * Set up messaging between content script and extension popup/background
     * @param {Runtime} runtime Runtime instance
     */
    function setupExtensionMessaging(runtime) {
      const browserAPI = typeof chrome !== "undefined" ? chrome : browser;
    
      if (!browserAPI || !browserAPI.runtime) {
        console.warn("2048 AI Solver: Extension messaging not available");
        return;
      }
    
      // Listen for messages from popup or background script
      browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
        handleExtensionMessage(runtime, message, sender, sendResponse);
        return true; // Keep message channel open for async responses
      });
    
      console.log("2048 AI Solver: Extension messaging set up");
    }
    
    /**
     * Handle messages from extension popup or background script
     * @param {Runtime} runtime Runtime instance
     * @param {Object} message Message object
     * @param {Object} sender Sender information
     * @param {Function} sendResponse Response callback
     */
    async function handleExtensionMessage(runtime, message, sender, sendResponse) {
      try {
        switch (message.action) {
          case "detect":
            const detected = runtime.detectGame();
            sendResponse({
              success: true,
              detected,
              adapter: detected ? runtime.currentAdapter.getName() : null,
            });
            break;
    
          case "start":
            runtime.start();
            sendResponse({ success: true, message: "Started" });
            break;
    
          case "stop":
            runtime.stop();
            sendResponse({ success: true, message: "Stopped" });
            break;
    
          case "pause":
            runtime.pause();
            sendResponse({ success: true, message: "Paused" });
            break;
    
          case "resume":
            runtime.resume();
            sendResponse({ success: true, message: "Resumed" });
            break;
    
          case "step":
            const stepResult = await runtime.step();
            sendResponse({ success: true, stepResult });
            break;
    
          case "getStats":
            const stats = runtime.getStats();
            sendResponse({ success: true, stats });
            break;
    
          case "getAdapterInfo":
            const adapterInfo = runtime.currentAdapter
              ? {
                  name: runtime.currentAdapter.getName(),
                  board: runtime.currentAdapter.readBoard(),
                  score: runtime.currentAdapter.getScore(),
                  gameOver: runtime.currentAdapter.isGameOver(),
                }
              : null;
            sendResponse({ success: true, adapterInfo });
            break;
    
          default:
            sendResponse({
              success: false,
              error: "Unknown action: " + message.action,
            });
        }
      } catch (error) {
        console.error("2048 AI Solver: Message handling error:", error);
        sendResponse({ success: false, error: error.message });
      }
    }
    
    /**
     * Clean up when content script is unloaded
     */
    function cleanup() {
      console.log("2048 AI Solver: Cleaning up content script...");
      destroyRuntime();
    }
    
    // Initialize when DOM is ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", main);
    } else {
      main();
    }
    
    // Clean up on page unload
    window.addEventListener("beforeunload", cleanup);
    
    // Export for potential external use
    exports.contentScriptMain = main;
    
  },
  "./src/runtime/runtime.js": function (exports, module, require) {
    /**
     * @fileoverview Shared runtime for 2048 AI Solver
     * Single codebase that compiles to both IIFE (bookmarklet) and MV3 content script
     */
    
    const { initHUD, getHUD, destroyHUD } = require("./src/hud/index.js");
    const { detectGame, globalAdapterRegistry } = require("./src/adapters/index.js");
    const { createDriver } = require("./src/driver/index.js");
    const { createGameObserver, getVisibilityHandler } = require("./src/observer/index.js");
    const { createSolverManager } = require("./src/solver/index.js");
    
    /**
     * Main runtime class for the 2048 AI Solver
     * Manages all components and provides unified interface
     */
    class Runtime {
      constructor(options = {}) {
        this.options = {
          autoInit: options.autoInit !== false,
          enableHUD: options.enableHUD !== false,
          enableVisibilityHandling: options.enableVisibilityHandling !== false,
          enableMutationObserver: options.enableMutationObserver !== false,
          ...options,
        };
    
        // Component instances
        this.hud = null;
        this.driver = null;
        this.observer = null;
        this.visibilityHandler = null;
        this.currentAdapter = null;
        this.directionPriority = null;
        this.solverManager = createSolverManager(options.solver || {});
    
        // State
        this.isInitialized = false;
        this.isRunning = false;
    
        // Bind methods
        this.handleBoardChange = this.handleBoardChange.bind(this);
        this.handleGameOver = this.handleGameOver.bind(this);
        this.handleError = this.handleError.bind(this);
      }
    
      /**
       * Initialize the runtime
       */
      async init() {
        if (this.isInitialized) {
          console.warn("Runtime already initialized");
          return;
        }
    
        console.log("Initializing 2048 AI Solver Runtime...");
    
        try {
          // Initialize visibility handler first
          if (this.options.enableVisibilityHandling) {
            this.visibilityHandler = getVisibilityHandler();
          }
    
          // Initialize HUD
          if (this.options.enableHUD) {
            this.hud = initHUD();
            if (this.hud) {
              this.hud.setController(this._createHUDController());
              this.directionPriority = this.hud.getDirectionPriority();
            }
    
            // Connect HUD to visibility handler
            if (this.visibilityHandler) {
              this.visibilityHandler.addManagedComponent(this.hud, "HUD");
            }
          }
    
          // Kick off solver initialization in the background
          if (this.solverManager) {
            this.solverManager
              .initialize()
              .catch((error) => {
                console.warn("Runtime: solver initialization failed", error);
              })
              .finally(() => {
                this._notifySolverStatus();
              });
          }
    
          // Try to detect game
          this.detectGame();
    
          this.isInitialized = true;
          console.log("Runtime initialized successfully");
    
          // Auto-start if configured
          if (this.options.autoInit && this.currentAdapter) {
            this.setupComponents();
          }
        } catch (error) {
          console.error("Runtime initialization failed:", error);
          throw error;
        }
      }
    
      /**
       * Detect game and set up adapter
       */
      detectGame() {
        this.currentAdapter = detectGame();
    
        if (this.currentAdapter) {
          console.log(`Game detected: ${this.currentAdapter.getName()}`);
    
          // Update HUD if available
          if (this.hud) {
            this.hud.currentAdapter = this.currentAdapter;
            this.hud.updateStatus();
          }
    
          return true;
        } else {
          console.log("No game detected");
          return false;
        }
      }
    
      /**
       * Set up all components after game detection
       * @private
       */
      setupComponents() {
        if (!this.currentAdapter) {
          console.warn("Cannot setup components without adapter");
          return;
        }
    
        // Create driver
        this.driver = createDriver({
          throttleMs: 130,
          domChangeTimeoutMs: 120,
          pauseWhenHidden: this.options.enableVisibilityHandling,
        });
    
        this.driver.setAdapter(this.currentAdapter);
    
        if (this.solverManager) {
          this.driver.setSolverEngine(this.solverManager);
          this._notifySolverStatus();
        }
    
        // Apply direction priority from HUD/user selection if available
        if (this.hud) {
          this.directionPriority = this.hud.getDirectionPriority();
        }
        if (this.directionPriority) {
          this.driver.setDirectionPriority([...this.directionPriority]);
        }
    
        // Set up driver callbacks
        this.driver.onBoardChange = this.handleBoardChange;
        this.driver.onGameOver = this.handleGameOver;
        this.driver.onError = this.handleError;
    
        // Create mutation observer
        if (this.options.enableMutationObserver) {
          this.observer = createGameObserver(this.currentAdapter);
          this.observer.onBoardChange = this.handleBoardChange;
          this.observer.startObserving();
        }
    
        // Add driver to visibility handler
        if (this.visibilityHandler) {
          this.visibilityHandler.addManagedComponent(this.driver, "Driver");
        }
    
        console.log("Components set up successfully");
      }
    
      /**
       * Start automated solving
       */
      start() {
        if (!this.isInitialized) {
          throw new Error("Runtime not initialized. Call init() first.");
        }
    
        if (!this.currentAdapter) {
          const detected = this.detectGame();
          if (!detected) {
            throw new Error("No game detected. Cannot start automation.");
          }
          this.setupComponents();
        }
    
        if (!this.driver) {
          this.setupComponents();
        }
    
        if (this.isRunning) {
          console.warn("Runtime already running");
          return;
        }
    
        this.driver.start();
        this.isRunning = true;
    
        if (this.hud) {
          this.hud.updateRunState(true);
        }
    
        console.log("Runtime started");
      }
    
      /**
       * Stop automated solving
       */
      stop() {
        if (!this.isRunning) {
          console.warn("Runtime not running");
          return;
        }
    
        if (this.driver) {
          this.driver.stop();
        }
    
        this.isRunning = false;
        if (this.hud) {
          this.hud.updateRunState(false);
        }
        console.log("Runtime stopped");
      }
    
      /**
       * Pause automated solving
       */
      pause() {
        if (this.driver && this.isRunning) {
          this.driver.pause();
          this.isRunning = false;
          console.log("Runtime paused");
          if (this.hud) {
            this.hud.updateRunState(false);
          }
        }
      }
    
      /**
       * Resume automated solving
       */
      resume() {
        if (this.driver && !this.isRunning) {
          this.driver.resume();
          this.isRunning = true;
          console.log("Runtime resumed");
          if (this.hud) {
            this.hud.updateRunState(true);
          }
        }
      }
    
      /**
       * Execute a single step
       * @returns {Promise<boolean>} True if step was successful
       */
      async step() {
        if (!this.currentAdapter) {
          const detected = this.detectGame();
          if (!detected) {
            throw new Error("No game detected");
          }
          this.setupComponents();
        }
    
        if (!this.driver) {
          this.setupComponents();
        }
    
        return await this.driver.step();
      }
    
      /**
       * Handle board change events
       * @private
       * @param {number[][]} board New board state
       */
      handleBoardChange(board) {
        // Update HUD if available
        if (this.hud) {
          this.hud.updateStatus();
        }
    
        // Log board change
        console.log("Board changed:", board);
      }
    
      /**
       * Handle game over events
       * @private
       */
      handleGameOver() {
        console.log("Game over detected");
        this.stop();
    
        // Show message if HUD is available
        if (this.hud) {
          this.hud.showMessage("Game Over!");
        }
      }
    
      /**
       * Handle error events
       * @private
       * @param {Error} error Error object
       */
      handleError(error) {
        console.error("Runtime error:", error);
    
        // Show error message if HUD is available
        if (this.hud) {
          this.hud.showMessage(`Error: ${error.message}`);
        }
    
        this._notifySolverStatus();
      }
    
      /**
       * Create controller interface for HUD interactions
       * @private
       * @returns {Object} Controller API used by HUD
       */
      _createHUDController() {
        return {
          detectGame: () => this.detectGame(),
          start: () => this.start(),
          stop: () => this.stop(),
          step: () => this.step(),
          isRunning: () => this.isRunning,
          getCurrentAdapter: () => this.currentAdapter,
          getSolverStatus: () =>
            this.solverManager ? this.solverManager.getStatus() : null,
          setDirectionPriority: (priorities) => {
            if (Array.isArray(priorities) && priorities.length === 4) {
              this.directionPriority = [...priorities];
              if (this.driver) {
                this.driver.setDirectionPriority([...priorities]);
              }
            }
          },
          setSolverStrategy: (strategy) => this.setSolverStrategy(strategy),
        };
      }
    
      /**
       * Get runtime statistics
       * @returns {Object} Statistics object
       */
      getStats() {
        return {
          isInitialized: this.isInitialized,
          isRunning: this.isRunning,
          adapterName: this.currentAdapter ? this.currentAdapter.getName() : null,
          driverStats: this.driver ? this.driver.getStats() : null,
          observerStats: this.observer ? this.observer.getStats() : null,
          visibilityStats: this.visibilityHandler
            ? this.visibilityHandler.getStats()
            : null,
          solver: this.solverManager ? this.solverManager.getStatus() : null,
        };
      }
    
      /**
       * Update solver configuration from HUD/controller
       * @param {Object} strategy Strategy configuration object
       */
      async setSolverStrategy(strategy) {
        if (!this.solverManager) {
          return;
        }
    
        try {
          await this.solverManager.setStrategy(strategy);
        } catch (error) {
          console.warn("Runtime: failed to apply solver strategy", error);
        }
    
        this._notifySolverStatus();
      }
    
      /**
       * Get current solver status snapshot
       * @returns {Object|null}
       */
      getSolverStatus() {
        return this.solverManager ? this.solverManager.getStatus() : null;
      }
    
      /**
       * Push solver status updates to HUD if available
       * @private
       */
      _notifySolverStatus() {
        if (this.hud && typeof this.hud.updateSolverStatus === "function") {
          this.hud.updateSolverStatus(this.getSolverStatus());
        }
      }
    
      /**
       * Destroy runtime and clean up all components
       */
      destroy() {
        console.log("Destroying runtime...");
    
        this.stop();
    
        // Destroy components
        if (this.driver) {
          this.driver.destroy();
          this.driver = null;
        }
    
        if (this.observer) {
          this.observer.destroy();
          this.observer = null;
        }
    
        if (this.hud) {
          this.hud.setController(null);
          destroyHUD();
          this.hud = null;
        }
    
        if (this.visibilityHandler) {
          this.visibilityHandler.destroy();
          this.visibilityHandler = null;
        }
    
        this.solverManager = createSolverManager(this.options.solver || {});
    
        // Clear adapter
        this.currentAdapter = null;
    
        // Reset state
        this.isInitialized = false;
        this.isRunning = false;
    
        console.log("Runtime destroyed");
      }
    }
    
    /**
     * Global runtime instance
     */
    let globalRuntime = null;
    
    /**
     * Initialize global runtime instance
     * @param {Object} options Runtime options
     * @returns {Runtime} Runtime instance
     */
    async function initRuntime(options = {}) {
      if (globalRuntime) {
        console.warn("Global runtime already exists");
        return globalRuntime;
      }
    
      globalRuntime = new Runtime(options);
      await globalRuntime.init();
      return globalRuntime;
    }
    
    /**
     * Get global runtime instance
     * @returns {Runtime|null} Runtime instance or null
     */
    function getRuntime() {
      return globalRuntime;
    }
    
    /**
     * Destroy global runtime instance
     */
    function destroyRuntime() {
      if (globalRuntime) {
        globalRuntime.destroy();
        globalRuntime = null;
      }
    }
    
    /**
     * Quick start function for immediate use
     * @param {Object} options Runtime options
     * @returns {Promise<Runtime>} Runtime instance
     */
    async function quickStart(options = {}) {
      const runtime = await initRuntime(options);
    
      // Try to start immediately if game is detected
      try {
        runtime.start();
      } catch (error) {
        console.log("Could not auto-start:", error.message);
      }
    
      return runtime;
    }
    
    exports.Runtime = Runtime;
    exports.initRuntime = initRuntime;
    exports.getRuntime = getRuntime;
    exports.destroyRuntime = destroyRuntime;
    exports.quickStart = quickStart;
  },
  "./src/solver/board-utils.js": function (exports, module, require) {
    /**
     * @fileoverview Board conversion helpers for WASM solver integration.
     */
    
    const { BoardUtils } = require("./src/adapters/index.js");
    
    const BOARD_SIZE = 4;
    const MAX_EXPONENT = 15;
    const ALL_DIRECTIONS = [0, 1, 2, 3];
    
    function flattenBoard(board) {
      return board.reduce((acc, row) => acc.concat(row), []);
    }
    
    function isPowerOfTwo(value) {
      return value > 0 && (value & (value - 1)) === 0;
    }
    
    function detectExponentBoard(flatTiles) {
      return flatTiles.some((value) => value > 0 && !isPowerOfTwo(value));
    }
    
    function tileToExponent(value, treatAsExponent) {
      if (!Number.isFinite(value) || value <= 0) {
        return 0;
      }
    
      const clamped = Math.min(Math.floor(value), 1 << MAX_EXPONENT);
      if (treatAsExponent) {
        return Math.min(clamped, MAX_EXPONENT);
      }
    
      let exponent = 0;
      let current = clamped;
      while (current > 1 && (current & 1) === 0 && exponent < MAX_EXPONENT) {
        current >>= 1;
        exponent += 1;
      }
    
      if (current !== 1) {
        const approx = Math.round(Math.log2(clamped));
        return Math.max(0, Math.min(approx, MAX_EXPONENT));
      }
    
      return exponent;
    }
    
    function exponentToValue(exponent) {
      if (exponent <= 0) {
        return 0;
      }
      if (exponent >= MAX_EXPONENT) {
        return 1 << MAX_EXPONENT;
      }
      return 1 << exponent;
    }
    
    const BoardEncoder = {
      ensureBoard(board) {
        if (!BoardUtils.isValidBoard(board)) {
          throw new Error("BoardEncoder: expected a 4x4 matrix");
        }
        return board.map((row) => row.map((value) => (Number.isFinite(value) ? value : 0)));
      },
    
      toExponentArray(board) {
        const normalized = this.ensureBoard(board);
        const flatTiles = flattenBoard(normalized);
        const treatAsExponent = detectExponentBoard(flatTiles);
    
        return flatTiles.map((value) => tileToExponent(value, treatAsExponent));
      },
    
      toBitboard(board) {
        const exponents = this.toExponentArray(board);
        return exponents.reduce((acc, value, index) => {
          const exponent = BigInt(value & 0xF);
          const shift = BigInt(index * 4);
          return acc | (exponent << shift);
        }, 0n);
      },
    
      fromExponentArray(exponents) {
        if (!Array.isArray(exponents) || exponents.length !== BOARD_SIZE * BOARD_SIZE) {
          throw new Error("BoardEncoder: expected 16-element exponent array");
        }
    
        const rows = [];
        for (let r = 0; r < BOARD_SIZE; r++) {
          const row = [];
          for (let c = 0; c < BOARD_SIZE; c++) {
            const index = r * BOARD_SIZE + c;
            row.push(exponentToValue(exponents[index] ?? 0));
          }
          rows.push(row);
        }
        return rows;
      },
    
      fromBitboard(bitboard) {
        if (typeof bitboard !== "bigint") {
          throw new Error("BoardEncoder: expected bigint bitboard");
        }
    
        const exponents = new Array(BOARD_SIZE * BOARD_SIZE).fill(0);
        for (let index = 0; index < exponents.length; index++) {
          const shift = BigInt(index * 4);
          const mask = 0xFn << shift;
          const value = Number((bitboard & mask) >> shift) & 0xF;
          exponents[index] = value;
        }
        return this.fromExponentArray(exponents);
      },
    
      uniqueDirections(list) {
        const seen = new Set();
        const deduped = [];
        for (const direction of list) {
          if (ALL_DIRECTIONS.includes(direction) && !seen.has(direction)) {
            seen.add(direction);
            deduped.push(direction);
          }
        }
    
        for (const direction of ALL_DIRECTIONS) {
          if (!seen.has(direction)) {
            deduped.push(direction);
          }
        }
    
        return deduped.slice(0, ALL_DIRECTIONS.length);
      },
    };
    
    
    exports.BoardEncoder = BoardEncoder;
  },
  "./src/solver/index.js": function (exports, module, require) {
    /**
     * @fileoverview Solver subsystem exports.
     */
    
    const __reExport0 = require("./src/solver/board-utils.js");
    exports.BoardEncoder = __reExport0.BoardEncoder;
    const __reExport1 = require("./src/solver/naive-solver.js");
    exports.NaiveSolverEngine = __reExport1.NaiveSolverEngine;
    const __reExport2 = require("./src/solver/wasm-solver.js");
    exports.WASMSolverEngine = __reExport2.WASMSolverEngine;
    const __reExport3 = require("./src/solver/solver-manager.js");
    exports.SolverManager = __reExport3.SolverManager;
    exports.createSolverManager = __reExport3.createSolverManager;
    
    
  },
  "./src/solver/naive-solver.js": function (exports, module, require) {
    /**
     * @fileoverview Minimal JS fallback solver used when WASM is unavailable.
     */
    
    const { Direction } = require("./src/adapters/index.js");
    const { BoardEncoder } = require("./src/solver/board-utils.js");
    
    const ALL_DIRECTIONS = [Direction.UP, Direction.RIGHT, Direction.DOWN, Direction.LEFT];
    
    function cloneBoard(board) {
      return board.map((row) => [...row]);
    }
    
    function rotateBoardClockwise(board) {
      const rotated = Array.from({ length: 4 }, () => Array(4).fill(0));
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          rotated[c][3 - r] = board[r][c];
        }
      }
      return rotated;
    }
    
    function rotateBoardCounterClockwise(board) {
      const rotated = Array.from({ length: 4 }, () => Array(4).fill(0));
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          rotated[3 - c][r] = board[r][c];
        }
      }
      return rotated;
    }
    
    function mergeLine(values) {
      const filtered = values.filter((value) => value !== 0);
      const merged = [];
      let skip = false;
    
      for (let i = 0; i < filtered.length; i++) {
        if (skip) {
          skip = false;
          continue;
        }
    
        const current = filtered[i];
        const next = filtered[i + 1];
        if (next && current === next) {
          merged.push(current * 2);
          skip = true;
        } else {
          merged.push(current);
        }
      }
    
      while (merged.length < 4) {
        merged.push(0);
      }
    
      return merged;
    }
    
    function moveLeft(board) {
      const result = cloneBoard(board);
      for (let r = 0; r < 4; r++) {
        result[r] = mergeLine(result[r]);
      }
      return result;
    }
    
    function moveRight(board) {
      const result = cloneBoard(board);
      for (let r = 0; r < 4; r++) {
        const reversed = [...result[r]].reverse();
        result[r] = mergeLine(reversed).reverse();
      }
      return result;
    }
    
    function moveUp(board) {
      const rotated = rotateBoardCounterClockwise(board);
      const moved = moveLeft(rotated);
      return rotateBoardClockwise(moved);
    }
    
    function moveDown(board) {
      const rotated = rotateBoardClockwise(board);
      const moved = moveLeft(rotated);
      return rotateBoardCounterClockwise(moved);
    }
    
    const MOVE_SIMULATORS = {
      [Direction.LEFT]: moveLeft,
      [Direction.RIGHT]: moveRight,
      [Direction.UP]: moveUp,
      [Direction.DOWN]: moveDown,
    };
    
    function boardsEqual(a, b) {
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          if (a[r][c] !== b[r][c]) {
            return false;
          }
        }
      }
      return true;
    }
    
    function findMaxTilePosition(board) {
      let best = { value: 0, row: 0, col: 0 };
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          const value = board[r][c];
          if (value > best.value) {
            best = { value, row: r, col: c };
          }
        }
      }
      return best;
    }
    
    function directionBiasForPosition(pos) {
      if (pos.row <= 1 && pos.col <= 1) {
        return [Direction.UP, Direction.LEFT, Direction.RIGHT, Direction.DOWN];
      }
      if (pos.row <= 1 && pos.col >= 2) {
        return [Direction.UP, Direction.RIGHT, Direction.LEFT, Direction.DOWN];
      }
      if (pos.row >= 2 && pos.col <= 1) {
        return [Direction.DOWN, Direction.LEFT, Direction.RIGHT, Direction.UP];
      }
      return [Direction.DOWN, Direction.RIGHT, Direction.LEFT, Direction.UP];
    }
    
    function wouldChangeBoard(board, direction) {
      const simulator = MOVE_SIMULATORS[direction];
      if (!simulator) {
        return false;
      }
      const next = simulator(board);
      return !boardsEqual(board, next);
    }
    
    class NaiveSolverEngine {
      constructor(config = {}) {
        this.status = "ready";
        this.strategy = {
          bias: config.bias ?? Direction.DOWN,
        };
      }
    
      async initialize() {
        this.status = "ready";
      }
    
      async ensureReady() {
        return;
      }
    
      async getMoveOrder(board) {
        const normalized = BoardEncoder.ensureBoard(board);
        const maxPos = findMaxTilePosition(normalized);
        const priorities = directionBiasForPosition(maxPos);
    
        const ordered = [];
        for (const direction of priorities) {
          if (wouldChangeBoard(normalized, direction)) {
            ordered.push(direction);
          }
        }
    
        if (ordered.length === 0) {
          return [...ALL_DIRECTIONS];
        }
    
        return BoardEncoder.uniqueDirections(ordered);
      }
    
      async setStrategy(config = {}) {
        if (typeof config.bias === "number") {
          this.strategy.bias = config.bias;
        }
      }
    
      getStatus() {
        return {
          type: "naive",
          ready: this.status === "ready",
          strategy: { ...this.strategy },
        };
      }
    }
    
    
    exports.NaiveSolverEngine = NaiveSolverEngine;
  },
  "./src/solver/solver-manager.js": function (exports, module, require) {
    /**
     * @fileoverview Orchestrates WASM solver loading with naive fallback.
     */
    
    const { BoardEncoder } = require("./src/solver/board-utils.js");
    const { NaiveSolverEngine } = require("./src/solver/naive-solver.js");
    const { WASMSolverEngine } = require("./src/solver/wasm-solver.js");
    
    const DEFAULT_STRATEGY = {
      type: "expectimax-depth",
      heuristic: "corner",
      depth: 4,
      probability: 0.0025,
    };
    
    function mergeStrategy(base, overrides) {
      return {
        ...base,
        ...(overrides || {}),
      };
    }
    
    class SolverManager {
      constructor(options = {}) {
        this.options = options;
        this.strategy = mergeStrategy(DEFAULT_STRATEGY, options.strategy);
    
        this.naiveEngine = new NaiveSolverEngine(this.strategy);
        this.wasmEngine = options.disableWasm
          ? null
          : new WASMSolverEngine({ ...options, strategy: this.strategy });
    
        this.activeEngine = this.naiveEngine;
        this.status = this.wasmEngine ? "idle" : "fallback"; // idle | ready | fallback
        this.lastError = null;
        this._initializationPromise = null;
      }
    
      async initialize() {
        if (!this.wasmEngine) {
          await this.naiveEngine.initialize();
          this.status = "fallback";
          return;
        }
    
        if (this.status === "ready" || this.status === "fallback") {
          return;
        }
    
        if (this._initializationPromise) {
          return this._initializationPromise;
        }
    
        await this.naiveEngine.initialize();
    
        this._initializationPromise = this.wasmEngine
          .initialize()
          .then(() => {
            this.activeEngine = this.wasmEngine;
            this.status = "ready";
            this.lastError = null;
          })
          .catch((error) => {
            console.warn("SolverManager: WASM initialization failed, using fallback", error);
            this.activeEngine = this.naiveEngine;
            this.status = "fallback";
            this.lastError = error;
          })
          .finally(() => {
            this._initializationPromise = null;
          });
    
        return this._initializationPromise;
      }
    
      async ensureInitialized() {
        if (this.status === "idle") {
          await this.initialize();
        }
      }
    
      async getMoveOrder(board) {
        const normalized = BoardEncoder.ensureBoard(board);
        await this.ensureInitialized();
    
        try {
          const order = await this.activeEngine.getMoveOrder(normalized);
          return BoardEncoder.uniqueDirections(order || []);
        } catch (error) {
          if (this.activeEngine === this.wasmEngine && this.naiveEngine) {
            console.warn("SolverManager: WASM getMoveOrder failed, switching to fallback", error);
            this.lastError = error;
            this.activeEngine = this.naiveEngine;
            this.status = "fallback";
            const fallbackOrder = await this.naiveEngine.getMoveOrder(normalized);
            return BoardEncoder.uniqueDirections(fallbackOrder || []);
          }
          throw error;
        }
      }
    
      async getBoardInfo(board) {
        if (this.activeEngine === this.wasmEngine && this.wasmEngine) {
          return this.wasmEngine.getBoardInfo(board);
        }
        return null;
      }
    
      async setStrategy(strategy) {
        this.strategy = mergeStrategy(this.strategy, strategy);
        await Promise.all([
          this.naiveEngine?.setStrategy?.(this.strategy),
          this.wasmEngine?.setStrategy?.(this.strategy),
        ]);
      }
    
      isWasmActive() {
        return this.activeEngine === this.wasmEngine && this.status === "ready";
      }
    
      getStatus() {
        return {
          mode: this.isWasmActive() ? "wasm" : "fallback",
          status: this.status,
          lastError: this.lastError ? String(this.lastError.message || this.lastError) : null,
          strategy: { ...this.strategy },
          wasm: this.wasmEngine ? this.wasmEngine.getStatus() : null,
          naive: this.naiveEngine.getStatus(),
        };
      }
    }
    
    function createSolverManager(options = {}) {
      return new SolverManager(options);
    }
    
    
    exports.SolverManager = SolverManager;
    exports.createSolverManager = createSolverManager;
  },
  "./src/solver/wasm-solver.js": function (exports, module, require) {
    /**
     * @fileoverview WASM-backed solver engine that bridges to the C++ strategy.
     */
    
    const { BoardEncoder } = require("./src/solver/board-utils.js");
    
    const DEFAULT_STRATEGY = {
      type: "expectimax-depth",
      heuristic: "corner",
      depth: 4,
      probability: 0.0025,
    };
    
    const ALL_DIRECTIONS = [0, 1, 2, 3];
    
    function getRuntimeAPI() {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
        return chrome.runtime;
      }
      if (typeof browser !== "undefined" && browser.runtime && browser.runtime.getURL) {
        return browser.runtime;
      }
      return null;
    }
    
    function resolveAssetUrl(filename, options = {}) {
      if (filename === "solver.mjs" && options.moduleUrl) {
        return options.moduleUrl;
      }
      if (filename === "solver.wasm" && options.wasmUrl) {
        return options.wasmUrl;
      }
      if (options.baseUrl) {
        return new URL(filename, options.baseUrl).toString();
      }
      const runtime = getRuntimeAPI();
      if (runtime) {
        return runtime.getURL(`wasm/${filename}`);
      }
      if (typeof document !== "undefined") {
        const base = options.documentBase || document.baseURI || window.location.href;
        return new URL(filename, base).toString();
      }
      throw new Error(`Unable to resolve solver asset: ${filename}`);
    }
    
    function sanitizeStrategy(config = {}) {
      return {
        type: config.type || DEFAULT_STRATEGY.type,
        heuristic: config.heuristic || DEFAULT_STRATEGY.heuristic,
        depth:
          typeof config.depth === "number" && Number.isFinite(config.depth)
            ? Math.max(1, Math.floor(config.depth))
            : DEFAULT_STRATEGY.depth,
        probability:
          typeof config.probability === "number" && Number.isFinite(config.probability)
            ? Math.max(0.0001, config.probability)
            : DEFAULT_STRATEGY.probability,
      };
    }
    
    class WASMSolverEngine {
      constructor(options = {}) {
        this.options = options;
        this.status = "idle"; // idle | loading | ready | error
        this.lastError = null;
        this.module = null;
        this.strategyWrapper = null;
        this._loadPromise = null;
        this.strategyConfig = sanitizeStrategy(options.strategy);
      }
    
      async initialize() {
        if (this.status === "ready") {
          return;
        }
        if (this._loadPromise) {
          return this._loadPromise;
        }
    
        this.status = "loading";
        this._loadPromise = this.loadModule()
          .then(() => {
            this.status = "ready";
            this.lastError = null;
          })
          .catch((error) => {
            this.status = "error";
            this.lastError = error;
            throw error;
          })
          .finally(() => {
            this._loadPromise = null;
          });
    
        return this._loadPromise;
      }
    
      async ensureReady() {
        if (this.status === "ready") {
          return;
        }
        await this.initialize();
      }
    
      async loadModule() {
        const moduleUrl = resolveAssetUrl("solver.mjs", this.options);
        const wasmUrl = resolveAssetUrl("solver.wasm", this.options);
    
        const importResult = await import(/* webpackIgnore: true */ moduleUrl);
        const factory = importResult && importResult.default ? importResult.default : importResult;
        if (typeof factory !== "function") {
          throw new Error("Invalid solver module factory");
        }
    
        const module = await factory({
          locateFile: (path) => (path.endsWith(".wasm") ? wasmUrl : path),
        });
    
        if (!module || typeof module.StrategyWrapper !== "function") {
          throw new Error("Solver module missing StrategyWrapper export");
        }
    
        this.module = module;
        this.strategyWrapper = new module.StrategyWrapper(
          this.strategyConfig.type,
          this.strategyConfig.heuristic,
          this.strategyConfig.depth,
          this.strategyConfig.probability,
        );
      }
    
      async setStrategy(config = {}) {
        this.strategyConfig = sanitizeStrategy({ ...this.strategyConfig, ...config });
    
        if (this.status !== "ready" || !this.strategyWrapper) {
          return;
        }
    
        try {
          this.strategyWrapper.configure(
            this.strategyConfig.type,
            this.strategyConfig.heuristic,
            this.strategyConfig.depth,
            this.strategyConfig.probability,
          );
        } catch (error) {
          console.warn("WASMSolverEngine: failed to apply strategy", error);
        }
      }
    
      async getMoveOrder(board) {
        await this.ensureReady();
        if (!this.module || !this.strategyWrapper) {
          throw new Error("WASM solver not initialized");
        }
    
        const exponents = BoardEncoder.toExponentArray(board);
        const boardValue = this.module.boardFromArray(exponents);
    
        let preferred = 0;
        try {
          preferred = this.strategyWrapper.pickMove(boardValue);
        } catch (error) {
          console.warn("WASMSolverEngine: pickMove failed", error);
        }
    
        const candidates = [];
        for (const direction of ALL_DIRECTIONS) {
          let valid = false;
          let score = Number.NEGATIVE_INFINITY;
          try {
            valid = this.module.isValidMove(boardValue, direction);
            if (valid) {
              const nextBoard = this.module.makeMove(boardValue, direction);
              score = this.strategyWrapper.evaluateBoard(nextBoard);
            }
          } catch (error) {
            valid = false;
          }
    
          candidates.push({ direction, valid, score });
        }
    
        const validMoves = candidates.filter((item) => item.valid);
        const ordered = validMoves
          .sort((a, b) => {
            if (a.direction === preferred && b.direction !== preferred) return -1;
            if (b.direction === preferred && a.direction !== preferred) return 1;
            return b.score - a.score;
          })
          .map((item) => item.direction);
    
        if (!ordered.length) {
          return BoardEncoder.uniqueDirections([preferred]);
        }
    
        return BoardEncoder.uniqueDirections(ordered);
      }
    
      async getBoardInfo(board) {
        if (this.status !== "ready" || !this.module) {
          return null;
        }
    
        try {
          const exponents = BoardEncoder.toExponentArray(board);
          const boardValue = this.module.boardFromArray(exponents);
          return {
            score: this.module.getScore(boardValue),
            maxTile: this.module.getMaxTile(boardValue),
            gameOver: this.module.isGameOver(boardValue),
          };
        } catch (error) {
          console.warn("WASMSolverEngine: getBoardInfo failed", error);
          return null;
        }
      }
    
      getStatus() {
        return {
          type: "wasm",
          status: this.status,
          ready: this.status === "ready",
          lastError: this.lastError ? String(this.lastError.message || this.lastError) : null,
          strategy: { ...this.strategyConfig },
        };
      }
    }
    
    
    exports.WASMSolverEngine = WASMSolverEngine;
  }
  };
  const cache = {};
  function require(id) {
    if (cache[id]) return cache[id].exports;
    if (!modules[id]) {
      throw new Error('Module not found: ' + id);
    }
    const module = { exports: {} };
    cache[id] = module;
    modules[id](module.exports, module, require);
    return module.exports;
  }
  require('./src/runtime/content-script.js');
})();
