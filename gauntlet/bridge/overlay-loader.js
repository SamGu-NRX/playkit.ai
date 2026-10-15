/**
 * Loader for the overlay's real modules in `src/`. The bridge imports the
 * overlay read-only; this module is the only place that touches it, through a
 * dynamic `import()` of a computed URL so the Gauntlet TypeScript program
 * never follows the import into `src/` (the overlay is checked by its own
 * pipeline; see the PR notes).
 *
 * Node treats `.js` files under `src/` as CommonJS unless a nearest
 * `package.json` says otherwise — the bridge's sibling change adds exactly
 * `src/package.json` containing `{"type": "module"}` for that.
 *
 * @module
 */

/**
 * @typedef {object} OverlayModules
 * @property {*} Direction The numeric direction constants (UP 0, RIGHT 1, DOWN 2, LEFT 3).
 * @property {*} Adapter The base adapter class.
 * @property {*} Play2048Adapter The play2048.co adapter.
 * @property {*} Driver The overlay's move-execution driver.
 */

/**
 * Load the overlay modules the bridge drives.
 *
 * @returns {Promise<OverlayModules>}
 */
export async function loadOverlayModules() {
  const overlayRoot = new URL('../../src/', import.meta.url);
  const [adapters, driver] = await Promise.all([
    import(new URL('adapters/index.js', overlayRoot).href),
    import(new URL('driver/driver.js', overlayRoot).href),
  ]);
  return {
    Direction: adapters.Direction,
    Adapter: adapters.Adapter,
    Play2048Adapter: adapters.Play2048Adapter,
    Driver: driver.Driver,
  };
}

export {};
