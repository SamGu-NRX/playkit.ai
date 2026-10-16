/**
 * @fileoverview Tests for the self-contained bookmarklet artifact.
 *
 * The standalone bookmarklet (dist/2048-hud-bookmarklet.txt) must carry the
 * whole runtime AND the WASM solver in one javascript: URL — the hosted
 * loader needed a CDN for the bundle plus solver.mjs/solver.wasm, and from a
 * bookmarklet's main-world injection the WASM asset was unreachable, so the
 * engine silently ran the weaker JS fallback (PR #86 journey F). These tests
 * build the artifact fresh (in-process, dist/ only) and verify the inlined
 * payloads decode to exactly the committed solver files.
 *
 * Run from the repository root (no dependencies to install; Node >= 20):
 *
 *   node --test src/test/bookmarklet-wasm.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

const build = createRequire(import.meta.url)("../../scripts/build-phase0.js");

const URL_PREFIX = 'javascript:(function(){(0,eval)(atob("';
const URL_SUFFIX = '"))})();';

function decodeBase64(b64) {
  return Buffer.from(b64, "base64");
}

function readBookmarklet() {
  return readFileSync(
    path.join(repoRoot, "dist/2048-hud-bookmarklet.txt"),
    "utf8"
  );
}

test("standalone bookmarklet builds as a single-line javascript: URL", () => {
  build.buildStandaloneBookmarklet();

  const bookmarklet = readBookmarklet();

  assert.ok(
    bookmarklet.startsWith(URL_PREFIX) && bookmarklet.endsWith(URL_SUFFIX),
    "bookmarklet must be the atob()+eval() wrapper form"
  );
  assert.ok(
    !bookmarklet.includes("\n") && !bookmarklet.includes("\r"),
    "bookmarklet must be a single line to paste into a bookmark URL field"
  );

  const payload = bookmarklet.slice(URL_PREFIX.length, -URL_SUFFIX.length);
  assert.match(payload, /^[A-Za-z0-9+/=]+$/, "payload must be plain base64");

  const bundle = decodeBase64(payload).toString("utf8");
  // The standalone bundle carries the HUD host id and the generated assets
  // module's identifiers, proving both the runtime and the payloads are inside.
  assert.ok(bundle.includes("ai-2048-solver-hud"), "bundle must contain the HUD");
  assert.ok(bundle.includes("SOLVER_WASM_B64"), "bundle must embed the wasm payload");
  assert.ok(bundle.includes("SOLVER_MJS_B64"), "bundle must embed the glue payload");

  console.log(
    `standalone bookmarklet URL size: ${bookmarklet.length} bytes ` +
      `(${(bookmarklet.length / 1024).toFixed(1)} KiB)`
  );
});

test("inlined payloads decode to exactly the committed solver artifacts", async () => {
  const bookmarklet = readBookmarklet();
  const bundle = decodeBase64(
    bookmarklet.slice(URL_PREFIX.length, -URL_SUFFIX.length)
  ).toString("utf8");

  const wasmB64 = bundle.match(/SOLVER_WASM_B64\s*=\s*"([A-Za-z0-9+/=]+)"/);
  const mjsB64 = bundle.match(/SOLVER_MJS_B64\s*=\s*"([A-Za-z0-9+/=]+)"/);
  assert.ok(wasmB64 && mjsB64, "bundle must contain both base64 payloads");

  const wasm = decodeBase64(wasmB64[1]);
  const glue = decodeBase64(mjsB64[1]);

  assert.ok(
    wasm.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d])),
    "decoded wasm payload must start with the WebAssembly magic"
  );

  const [committedWasm, committedGlue] = await Promise.all([
    readFile(path.join(repoRoot, "src/extension/wasm/solver.wasm")),
    readFile(path.join(repoRoot, "src/extension/wasm/solver.mjs")),
  ]);

  assert.ok(
    wasm.equals(committedWasm),
    "wasm payload must equal the committed solver.wasm"
  );
  assert.ok(
    glue.equals(committedGlue),
    "glue payload must equal the committed solver.mjs"
  );
});
