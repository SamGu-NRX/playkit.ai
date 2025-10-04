#!/usr/bin/env node

/**
 * Build script for compiling the C++ solver to WebAssembly using Emscripten.
 *
 * Usage:
 *   node scripts/build-wasm.js [--release] [--emcc /path/to/emcc]
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const sourceFile = path.join(rootDir, "solver/wasm/export_solver.cpp");
const outputDir = path.join(rootDir, "src/extension/wasm");

const args = process.argv.slice(2);
const isRelease = args.includes("--release");
const emccIndex = args.indexOf("--emcc");

const resolveEmccFromDir = (dir) => {
  if (!dir || !fs.existsSync(dir)) {
    return null;
  }

  const stats = fs.statSync(dir);
  if (!stats.isDirectory()) {
    return stats.isFile() ? dir : null;
  }

  const names = process.platform === "win32"
    ? ["emcc.bat", "emcc.cmd", "emcc.exe", "emcc"]
    : ["emcc"]; // Emscripten ships POSIX binary without extension

  for (const name of names) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
};

const detectEmcc = () => {
  const candidates = [];

  const pushCandidate = (value, reason) => {
    const resolved = resolveEmccFromDir(value);
    if (resolved) {
      candidates.push({ executable: resolved, reason });
    }
  };

  if (process.env.EMCC) {
    pushCandidate(process.env.EMCC, "EMCC environment variable");
  }

  if (process.env.EMSCRIPTEN) {
    pushCandidate(path.join(process.env.EMSCRIPTEN, "emcc"), "EMSCRIPTEN environment variable");
    pushCandidate(process.env.EMSCRIPTEN, "EMSCRIPTEN root directory");
  }

  if (process.env.EMSDK) {
    pushCandidate(path.join(process.env.EMSDK, "upstream/emscripten"), "EMSDK upstream toolchain");
  }

  const projectEmsdk = path.join(rootDir, "emsdk");
  if (fs.existsSync(projectEmsdk)) {
    pushCandidate(path.join(projectEmsdk, "upstream/emscripten"), "project emsdk");
  }

  const emscriptenConfigPath = path.join(os.homedir(), ".emscripten");
  if (fs.existsSync(emscriptenConfigPath)) {
    try {
      const config = fs.readFileSync(emscriptenConfigPath, "utf8");
      const match = config.match(/EMSCRIPTEN\s*=\s*['"]([^'"]+)['"]/);
      if (match && match[1]) {
        pushCandidate(path.join(match[1], "emcc"), "~/.emscripten config");
        pushCandidate(match[1], "~/.emscripten EMSCRIPTEN root");
      }
    } catch (error) {
      console.warn("Warning: failed to read ~/.emscripten:", error.message);
    }
  }

  return candidates.length > 0 ? candidates[0] : null;
};

const emccExecutable = (() => {
  if (emccIndex !== -1 && args[emccIndex + 1]) {
    return { executable: args[emccIndex + 1], reason: "--emcc flag" };
  }

  const autoDetected = detectEmcc();
  if (autoDetected) {
    return autoDetected;
  }

  return { executable: process.env.EMCC || "emcc", reason: "default PATH lookup" };
})();

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
  "-I",
  path.join(rootDir, "solver/vendor/sparsehash/src"),
  "-o",
  path.join(outputDir, "solver.mjs"),
);

console.log(
  `Running ${emccExecutable.executable} (${emccExecutable.reason}) ${emccArgs.join(" ")}`,
);

const build = spawnSync(emccExecutable.executable, emccArgs, {
  cwd: rootDir,
  stdio: "inherit",
});

if (build.error) {
  if (build.error.code === "ENOENT") {
    console.error(
      "Failed to locate emcc. Install Emscripten (https://emscripten.org/docs/getting_started/downloads.html) and either:",
    );
    console.error("  - add emcc to your PATH (source emsdk_env.sh)");
    console.error("  - set the EMCC/EMSCRIPTEN/EMSDK env vars");
    console.error("  - or pass --emcc /path/to/emcc");
  } else {
    console.error("Failed to execute", emccExecutable.executable, build.error.message);
  }
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
