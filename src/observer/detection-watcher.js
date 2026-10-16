/**
 * @fileoverview Detection watcher: bounded, debounced detection retries on DOM changes
 *
 * A one-shot detection at init misses games whose tiles are created by page
 * JavaScript after load (e.g. the vendored 2048 creates `.tile` elements after
 * document_idle). This watcher re-runs detection whenever the DOM changes until
 * an adapter attaches or a bounded window closes, so the HUD shows
 * "Game: <adapter>" and an enabled Auto-solve without a manual Detect click.
 *
 * Detection only: the watcher never starts solving. It stops at the first
 * successful attach, or after `timeoutMs`.
 */

export class DetectionWatcher {
  /**
   * @param {Object} options
   * @param {() => boolean} options.onProbe Called on DOM activity; return true
   *   once an adapter has attached (also stops the watcher).
   * @param {number} [options.debounceMs] Coalesce bursts of mutations into one probe.
   * @param {number} [options.timeoutMs] Bounded window; the watcher stops itself after this.
   * @param {number} [options.heartbeatMs] Safety-net probe interval for pages whose
   *   change never fires a DOM mutation during the window.
   */
  constructor(options = {}) {
    this.onProbe = options.onProbe;
    this.debounceMs =
      typeof options.debounceMs === "number" ? options.debounceMs : 250;
    this.timeoutMs =
      typeof options.timeoutMs === "number" ? options.timeoutMs : 15000;
    this.heartbeatMs =
      typeof options.heartbeatMs === "number" ? options.heartbeatMs : 1500;

    this.isActive = false;
    this.probeCount = 0;
    this.observer = null;
    this.debounceTimer = null;
    this.heartbeatTimer = null;
    this.timeoutTimer = null;

    this._handleMutations = this._handleMutations.bind(this);
    this._probe = this._probe.bind(this);
    this._stopForTimeout = this._stopForTimeout.bind(this);
  }

  /**
   * Start watching. No-op when already active or when MutationObserver is
   * unavailable (very old hosts); heartbeat probes still bound the window.
   */
  start() {
    if (this.isActive) {
      return;
    }
    this.isActive = true;

    if (typeof MutationObserver !== "undefined" && document.documentElement) {
      this.observer = new MutationObserver(this._handleMutations);
      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    }

    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(this._probe, this.heartbeatMs);
    }

    this.timeoutTimer = setTimeout(this._stopForTimeout, this.timeoutMs);
  }

  /**
   * Stop watching and release every timer/observer. Safe to call more than once.
   */
  stop() {
    if (!this.isActive && !this.observer) {
      return;
    }

    this.isActive = false;

    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  /**
   * @private
   */
  _handleMutations() {
    if (!this.isActive) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(this._probe, this.debounceMs);
  }

  /**
   * @private
   */
  _probe() {
    this.debounceTimer = null;
    if (!this.isActive) {
      return;
    }

    this.probeCount++;

    let attached = false;
    try {
      attached = this.onProbe ? this.onProbe() === true : false;
    } catch (error) {
      console.warn("DetectionWatcher: probe failed:", error);
    }

    if (attached) {
      this.stop();
    }
  }

  /**
   * @private
   */
  _stopForTimeout() {
    console.log(
      `DetectionWatcher: window closed after ${this.timeoutMs}ms (${this.probeCount} probes, no adapter)`
    );
    this.stop();
  }
}
