# WASM Solver Artifacts

Generated files for the WebAssembly solver live in this directory. Build them locally with:

```bash
node scripts/build-wasm.js --release
```

This command invokes Emscripten to compile `solver/wasm/export_solver.cpp` and outputs:

- `solver.mjs` – ES module loader used by the runtime
- `solver.wasm` – compiled C++ solver binary

After building, rerun `node scripts/build-phase0.js` to copy the artifacts into `dist/extension/wasm/` for packaging.

> **Tip:** ensure `emcc` (Emscripten) is on your `PATH` before running the build script.
