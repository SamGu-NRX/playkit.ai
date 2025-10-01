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
    
        // Try each direction in priority order
        for (const direction of this.directionPriority) {
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
       * Execute a random move when stuck
       * @private
       * @returns {Promise<boolean>} True if move was successful
       */
      async executeRandomMove() {
        const randomDirection = Math.floor(Math.random() * 4);
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
  "./src/hud/hud.js": function (exports, module, require) {
    /**
     * @fileoverview Shadow DOM HUD overlay for 2048 solver
     * Implements draggable, collapsible HUD panel with game controls
     */
    
    const { detectGame, Direction } = require("./src/adapters/index.js");
    
    /**
     * HUD overlay clareates a Shadow DOM panel
     * Provides controls for game detection and automation
     */
    class HUD {
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
          setDirectionPriority: (priorities) => {
            if (Array.isArray(priorities) && priorities.length === 4) {
              this.directionPriority = [...priorities];
              if (this.driver) {
                this.driver.setDirectionPriority([...priorities]);
              }
            }
          },
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
        };
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
