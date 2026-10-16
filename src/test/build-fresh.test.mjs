/**
 * @fileoverview Fail-first freshness test for the committed extension bundle.
 *
 * PR #87 shipped because alpha's `src/extension/content.js` had not been
 * rebuilt after #75's detection-watcher landed — the unpacked extension said
 * "Not detected at load" and nothing in the repo could notice. This test
 * builds the bundle from its sources into a temp directory (never touching
 * the repository tree) and compares it byte for byte with the committed file,
 * so a source change that skips `node scripts/build-phase0.js` turns CI-red
 * here instead of in a user's browser.
 *
 * Run from the repository root (no dependencies to install; Node >= 20):
 *
 *   node --test src/test/build-fresh.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

// scripts/build-phase0.js is a CommonJS script (the repo has no root
// package.json), loaded through createRequire so both builds run in-process.
const build = createRequire(import.meta.url)("../../scripts/build-phase0.js");

test("committed content.js matches a fresh build byte for byte", async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "build-fresh-"));
  try {
    const builtPath = path.join(outDir, "content.js");
    build.bundle("src/runtime/content-script.js", builtPath);

    const [built, committed] = await Promise.all([
      readFile(builtPath),
      readFile(path.join(repoRoot, "src/extension/content.js")),
    ]);

    assert.ok(
      built.equals(committed),
      "src/extension/content.js is stale — it no longer matches its sources. " +
        "Run `node scripts/build-phase0.js` and commit the regenerated bundle " +
        "(this is how PR #87's 'Not detected at load' regression happened)."
    );
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test("the content.js build is deterministic (two runs, byte-identical)", async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "build-fresh-det-"));
  try {
    const first = path.join(outDir, "first.js");
    const second = path.join(outDir, "second.js");
    build.bundle("src/runtime/content-script.js", first);
    build.bundle("src/runtime/content-script.js", second);

    const [a, b] = await Promise.all([readFile(first), readFile(second)]);
    assert.ok(a.equals(b), "repeated builds of the same sources must be identical");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
