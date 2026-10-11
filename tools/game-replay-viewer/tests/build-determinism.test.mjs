/**
 * build.mjs determinism tests — the documented build command must produce
 * byte-identical exports on repeated runs and its frame/ID agreement must
 * hold.
 */
import { deepStrictEqual, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = join(new URL("..", import.meta.url).pathname, "..", "..");
const build = join(root, "tools", "game-replay-viewer", "build.mjs");
const fixtures = join(root, "tools", "game-replay-viewer", "fixtures");

function runBuild(outDir) {
  execFileSync(process.execPath, [build, "--fixtures", fixtures, "--out", outDir], { cwd: root });
}

function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

test("two runs produce byte-identical evidence trees", () => {
  const dir1 = mkdtempSync(join(tmpdir(), "replay-build-1-"));
  const dir2 = mkdtempSync(join(tmpdir(), "replay-build-2-"));
  runBuild(dir1);
  runBuild(dir2);

  const files1 = listFiles(dir1);
  const files2 = listFiles(dir2);
  deepStrictEqual(files2, files1, "same file set");
  strictEqual(files1.includes("replay-classification.json"), true);
  strictEqual(files1.includes("frame-id-agreement.json"), true);
  strictEqual(files1.some((f) => f.startsWith("timeline/")), true, "per-log timeline exports exist");

  for (const file of files1) {
    deepStrictEqual(
      readFileSync(join(dir2, file)),
      readFileSync(join(dir1, file)),
      `${file} must be byte-identical across runs`,
    );
  }
});

test("the frame/ID agreement check passes and counts stay as documented", () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-build-3-"));
  runBuild(dir);
  const agreement = JSON.parse(readFileSync(join(dir, "frame-id-agreement.json"), "utf8"));
  strictEqual(agreement.agree, true);
  deepStrictEqual(agreement.mismatches, []);
  const classification = JSON.parse(readFileSync(join(dir, "replay-classification.json"), "utf8"));
  deepStrictEqual(classification.summary.accepted, 6);
  deepStrictEqual(classification.summary.refused, 3);
  strictEqual(classification.format, "playkit-replay-log/1");
});
