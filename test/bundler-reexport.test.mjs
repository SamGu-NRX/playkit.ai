// Contract test: scripts/build-phase0.js must give every re-exported name a
// local binding, so a module that also *uses* a re-exported name internally
// works in the built bundle. Fails on the pre-fix tree: `export { X } from
// "./y.js"` becomes `exports.X = require(y).X` with no local binding, so any
// bare use of X in the module throws ReferenceError at runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = "/home/user/work/burst11-playkit-overlay-helper-fix";
const require = createRequire(import.meta.url);

/** Load the real bundler into a vm whose rootDir resolves to `fixtureDir`. */
async function loadBundler(fixtureDir) {
  const bundlerSrc = await readFile(`${REPO}/scripts/build-phase0.js`, "utf8");
  const sandbox = {
    require,
    console,
    process,
    module: { exports: {} },
    __filename: path.join(fixtureDir, "scripts", "build-phase0.js"),
    __dirname: path.join(fixtureDir, "scripts"), // so rootDir = resolve(__dirname, "..") = fixtureDir
  };
  vm.runInNewContext(
    `${bundlerSrc}\n;module.exports = { bundle, transformModule, getModuleId };`,
    sandbox,
    { filename: "build-phase0.js" },
  );
  return sandbox.module.exports;
}

test("bundler: a re-exported name also gets a local binding usable inside the module", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "burst11-bundler-"));
  try {
    await mkdir(path.join(fixtureDir, "src"), { recursive: true });
    await writeFile(
      path.join(fixtureDir, "src", "lib.js"),
      `export const val = 21;\nexport function makeVal() { return val * 2; }\n`,
    );
    // The shape of src/adapters/index.js: re-export a name AND use it bare.
    await writeFile(
      path.join(fixtureDir, "src", "entry.js"),
      [
        `export { val, makeVal } from "./lib.js";`,
        `export function describeVal() { return "val=" + val + " made=" + makeVal(); }`,
        `globalThis.__RESULT = { bare: val, via: describeVal() };`,
        ``,
      ].join("\n"),
    );

    const bundler = await loadBundler(fixtureDir);
    bundler.bundle("src/entry.js", "out/bundle.js");
    const code = await readFile(path.join(fixtureDir, "out", "bundle.js"), "utf8");

    const context = {};
    vm.runInNewContext(code, context, { filename: "bundle.js" });
    assert.equal(context.__RESULT.bare, 21, "bare use of a re-exported name must resolve");
    assert.equal(context.__RESULT.via, "val=21 made=42", "functions must see the re-exported binding");
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("bundler: re-exports keep their external exports", async () => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), "burst11-bundler-"));
  try {
    await mkdir(path.join(fixtureDir, "src"), { recursive: true });
    await writeFile(path.join(fixtureDir, "src", "lib.js"), `export const a = 1;\nexport const b = 2;\n`);
    await writeFile(
      path.join(fixtureDir, "src", "entry.js"),
      `export { a, b as bee } from "./lib.js";\nglobalThis.__EXPORTS = exports;\n`,
    );

    const bundler = await loadBundler(fixtureDir);
    bundler.bundle("src/entry.js", "out/bundle.js");
    const code = await readFile(path.join(fixtureDir, "out", "bundle.js"), "utf8");

    const context = {};
    vm.runInNewContext(code, context, { filename: "bundle.js" });
    assert.equal(context.__EXPORTS.a, 1);
    assert.equal(context.__EXPORTS.bee, 2, "alias in `export { x as y } from` must survive");
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("the repo's real bookmarklet bundle has no bare re-exported identifier left", async () => {
  await new Promise((resolve, reject) => {
    const { execFile } = require("node:child_process");
    execFile("node", ["scripts/build-phase0.js"], { cwd: REPO }, (err) => (err ? reject(err) : resolve()));
  });
  const code = await readFile(`${REPO}/dist/2048-hud.min.js`, "utf8");
  // Pre-fix, every `export { X } from` site compiles to this shape; post-fix it must not exist.
  assert.doesNotMatch(code, /exports\.\w+ = __reExport\d+\.\w+;/);
});
