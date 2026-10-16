/**
 * @fileoverview Registry for WASM solver payloads inlined at build time.
 *
 * The standalone bookmarklet bundles the Emscripten glue (solver.mjs) and the
 * compiled solver (solver.wasm) into its own payload as base64 strings, so it
 * needs no host, CDN, or extension runtime to start the WASM engine. Its entry
 * module registers those payloads here at load; wasm-solver.js then resolves
 * solver assets to blob: URLs created from the registered bytes instead of
 * fetching them from a server.
 *
 * Registration happens only in the standalone build: the other entries
 * (extension content script, hosted bookmarklet) never import the generated
 * assets module, so the registry stays empty and URL resolution behaves
 * exactly as before.
 */

const registered = { moduleSource: null, wasmBytes: null, urls: null };

function blobSupport() {
  return (
    typeof Blob !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}

function base64ToBytes(base64) {
  if (typeof atob === "function") {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  throw new Error("No base64 decoder available for inlined solver assets");
}

/**
 * Register inlined solver payloads (base64). Called once by the standalone
 * bookmarklet entry before the runtime initializes the solver; registration
 * during module evaluation always precedes the solver's first URL resolution
 * because that happens at least one microtask later (after the naive
 * fallback engine initializes).
 */
export function registerInlineSolverAssets({ moduleSourceB64, wasmB64 } = {}) {
  if (typeof moduleSourceB64 === "string") {
    registered.moduleSource = base64ToBytes(moduleSourceB64);
  }
  if (typeof wasmB64 === "string") {
    registered.wasmBytes = base64ToBytes(wasmB64);
  }
  registered.urls = null;
}

/**
 * Blob URLs for the registered payloads, created lazily on first use and
 * memoized. Returns null when nothing is registered or the environment
 * cannot create blob URLs (e.g. Node test runs), letting the caller fall
 * through to the normal resolution strategies.
 */
export function getInlineSolverAssetUrls() {
  if (!registered.moduleSource && !registered.wasmBytes) {
    return null;
  }
  if (!blobSupport()) {
    return null;
  }
  if (!registered.urls) {
    const urls = { moduleUrl: null, wasmUrl: null };
    if (registered.moduleSource) {
      urls.moduleUrl = URL.createObjectURL(
        new Blob([registered.moduleSource], { type: "text/javascript" })
      );
    }
    if (registered.wasmBytes) {
      urls.wasmUrl = URL.createObjectURL(
        new Blob([registered.wasmBytes], { type: "application/wasm" })
      );
    }
    registered.urls = urls;
  }
  return registered.urls;
}

/** Test hook: whether any payload is registered (does not create URLs). */
export function hasInlineSolverAssets() {
  return Boolean(registered.moduleSource || registered.wasmBytes);
}
