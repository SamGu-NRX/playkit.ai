/**
 * @fileoverview Self-contained bookmarklet entry (bundled to an IIFE).
 *
 * The hosted bookmarklet (src/runtime/bookmarklet.js served from a CDN) loads
 * the WASM solver from files next to the bundle; a bookmarklet has no origin
 * to load from, which is why it used to fall back to the slower JS engine
 * (PR #86 journey F). This entry instead registers build-inlined payloads —
 * base64 of src/extension/wasm/solver.mjs and solver.wasm, generated into
 * ./inline-assets.generated.js by scripts/build-phase0.js — and then runs the
 * identical shared runtime. The WASM engine resolves its assets to blob: URLs
 * of those payloads (see src/solver/wasm-solver.js), so the full-strength
 * solver (PR #79: ~2x the fallback's mean score) works from a single pasted
 * bookmark URL with no hosting step.
 */

import { SOLVER_MJS_B64, SOLVER_WASM_B64 } from "./inline-assets.generated.js";
import { registerInlineSolverAssets } from "./inline-assets.js";

registerInlineSolverAssets({
  moduleSourceB64: SOLVER_MJS_B64,
  wasmB64: SOLVER_WASM_B64,
});

import { bookmarkletMain } from "../runtime/bookmarklet.js";

// bookmarkletMain runs when its module evaluates; the reference keeps the
// bundler from treating the import as unused and documents the consumer.
void bookmarkletMain;
