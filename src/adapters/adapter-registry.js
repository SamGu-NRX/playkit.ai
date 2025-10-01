/**
 * @fileoverview Adapter registry for automatic game detection
 * Implements the Adapter Registry pattern for site detection
 */

import { Play2048Adapter } from "./play2048-adapter.js";
import { GenericAdapter } from "./generic-adapter.js";
import { GetMITAdapter } from "./getmit-adapter.js";

/**
 * Registry for managing and selecting appropriate adapters
 * Follows the Adapter Registry pattern from steering guidelines
 */
export class AdapterRegistry {
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
export const globalAdapterRegistry = AdapterRegistry.create();
