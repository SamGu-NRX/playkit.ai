/**
 * Node-side loader for the REAL Emscripten solver module (build/wasm/solver.mjs).
 *
 * Why this exists: the C++ binding registers std::vector<int> as IntVector
 * (solver/wasm/export_solver.cpp: register_vector<int>("IntVector"),
 * boardFromArray(const std::vector<int>&)), and embind does not auto-convert
 * plain JS arrays to registered vector types. The production bridge
 * src/solver/wasm-solver.js calls module.boardFromArray(<plain array of 16
 * exponent ints>) — in the browser this is the same contract, and the
 * sibling solver-budgets study hit the identical mismatch and bridged it
 * with push_back (experiments/solver-budgets/lib/engines.mjs WasmBinding).
 *
 * This adapter keeps the production engine + manager fully in the loop for
 * the real-WASM tests: it loads the freshly built glue, forwards the
 * factory options (the engine supplies locateFile pointing at
 * build/wasm/solver.wasm — converted to a readable path and passed as
 * wasmBinary, avoiding file:// fetch quirks), and wraps ONLY boardFromArray
 * so the engine's array crosses as an IntVector. Every other embind export
 * (StrategyWrapper, isValidMove, makeMove, getScore, getMaxTile,
 * isGameOver) is the real, untouched C++ implementation.
 *
 * Build the artifacts first — see the recipe in test/real-wasm.test.mjs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = new URL("../../", import.meta.url);

export default async function createNodeSolverModule(options = {}) {
  const gluePath = new URL("build/wasm/solver.mjs", REPO_ROOT);
  const realFactory = (await import(gluePath.href)).default;

  // wasm-solver.js always calls the factory with { locateFile }; translate
  // its file:// URL for solver.wasm into bytes emscripten accepts directly.
  let factoryOptions = options;
  if (typeof options.locateFile === "function") {
    const wasmUrl = options.locateFile("solver.wasm");
    const wasmPath = wasmUrl.startsWith("file:") ? fileURLToPath(wasmUrl) : wasmUrl;
    factoryOptions = { wasmBinary: new Uint8Array(readFileSync(wasmPath)) };
  }

  const module = await realFactory(factoryOptions);

  const rawBoardFromArray = module.boardFromArray.bind(module);
  module.boardFromArray = (tiles) => {
    const vec = new module.IntVector();
    for (const exponent of tiles) vec.push_back(exponent);
    return rawBoardFromArray(vec);
  };

  return module;
}
