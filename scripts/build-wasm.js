#!/usr/bin/env node

/**
 * Build script for compiling the C++ solver to WebAssembly using Emscripten.
 *
 * Usage:
 *   node scripts/build-wasm.js [--release] [--emcc /path/to/emcc]
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const sourceFile = path.join(rootDir, "solver/wasm/export_solver.cpp");
const outputDir = path.join(rootDir, "src/extension/wasm");

const args = process.argv.slice(2);
const isRelease = args.includes("--release");
const emccIndex = args.indexOf("--emcc");
const emccExecutable =
  emccIndex !== -1 && args[emccIndex + 1]
    ? args[emccIndex + 1]
    : process.env.EMCC || "emcc";

if (!fs.existsSync(sourceFile)) {
  console.error("export_solver.cpp not found at", sourceFile);
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });

const emccArgs = [sourceFile, "-std=c++17", isRelease ? "-O3" : "-O0"];

if (!isRelease) {
  emccArgs.push("-g", "-sASSERTIONS=1");
} else {
  emccArgs.push("-sASSERTIONS=0");
}

emccArgs.push(
  "--bind",
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sENVIRONMENT=web",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sWASM_BIGINT=1",
  "-sSUPPORT_LONGJMP=0",
  "-sDISABLE_EXCEPTION_CATCHING=1",
  "-sEXPORTED_RUNTIME_METHODS=['cwrap','ccall']",
  "-sEXPORT_NAME=createSolverModule",
  "-I",
  path.join(rootDir, "solver"),
  "-o",
  path.join(outputDir, "solver.mjs"),
);

console.log("Running", emccExecutable, emccArgs.join(" "));

const build = spawnSync(emccExecutable, emccArgs, {
  cwd: rootDir,
  stdio: "inherit",
});

if (build.error) {
  console.error("Failed to execute", emccExecutable, build.error.message);
  process.exit(1);
}

if (build.status !== 0) {
  console.error("Emscripten build failed");
  process.exit(build.status || 1);
}

const wasmPath = path.join(outputDir, "solver.wasm");
if (!fs.existsSync(wasmPath)) {
  console.warn("solver.wasm not found in", outputDir);
} else {
  const wasmSize = fs.statSync(wasmPath).size;
  console.log(`Generated solver.wasm (${wasmSize} bytes)`);
}

console.log("WASM build complete. Artifacts written to", outputDir);
