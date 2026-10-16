# WASM Solver Artifacts

Generated files for the WebAssembly solver live in this directory:

- `solver.mjs` – ES module loader used by the runtime
- `solver.wasm` – compiled C++ expectimax solver binary (both are committed; the
  root `.gitignore` has a negation for exactly this path)

## Reproducing this build

The `solver/` directory is a git submodule pointing at `SamGu-NRX/2048-solver`
(~1.4 GB with logs and results — do not clone it whole or run
`git submodule update` on it). Fetch only the build sources at the pinned
commit with a blob-less sparse clone **outside the repo**, then pass the
directory to the build script with `--src`:

```bash
# 1. Sparse, blob-less fetch of the pinned solver sources (outside the repo):
git clone --filter=blob:none --no-checkout \
  https://github.com/SamGu-NRX/2048-solver.git /tmp/2048-solver-src
cd /tmp/2048-solver-src
git sparse-checkout init --cone
git sparse-checkout set wasm strategies vendor   # vendor/ only holds sparsehash
git checkout 2c1d25f990b460e5e406096e486921af9eba4664

# 2. Vendor the header-only sparsehash headers the strategies include
#    (`#include "sparsehash/dense_hash_map"`). The Debian package ships a
#    ready-made config and is the easiest source:
sudo apt-get install libsparsehash-dev
mkdir -p vendor/sparsehash/src
cp -r /usr/include/sparsehash /usr/include/google vendor/sparsehash/src/
#    (Vendoring from github.com/sparsehash/sparsehash instead requires
#    generating internal/sparseconfig.h — copy the src/windows variant and
#    adapt it: HASH_FUN_H <functional>, HASH_NAMESPACE std,
#    SPARSEHASH_HASH std::hash, and the HAVE_* defines for a libc++ build.)

# 3. Build (Emscripten on PATH, or use emsdk):
node scripts/build-wasm.js --release --src /tmp/2048-solver-src

# 4. Rebundle so dist/ picks the artifacts up:
node scripts/build-phase0.js
```

## Provenance of the committed artifacts

| | |
| --- | --- |
| Solver source | `SamGu-NRX/2048-solver` @ `2c1d25f990b460e5e406096e486921af9eba4664` (`wasm/export_solver.cpp`, `game.hpp`, `heuristics.hpp`, `strategies/*.hpp`, `util.hpp`) |
| Compiler | Emscripten 6.0.12 (`emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.12 (5488e0871d46d19a3209988190fa6a653126256f)`), installed via emsdk `latest` on 2026-10-16 |
| Flags | `-std=c++17 -O3 -sDEFAULT_TO_CXX -sASSERTIONS=0 --bind -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web -sALLOW_MEMORY_GROWTH=1 -sWASM_BIGINT=1 -sSUPPORT_LONGJMP=0 -sDISABLE_EXCEPTION_CATCHING=1 -sNO_DYNAMIC_EXECUTION=1` (see `scripts/build-wasm.js`). `NO_DYNAMIC_EXECUTION` is required for MV3 content scripts: without it, embind's dynamic invokers build functions with `new Function(...)`, which the extension's `script-src 'self'` CSP rejects and the engine silently falls back to JS. |
| `solver.mjs` | sha256 `5d6bad5597b23174d41baa43efccbdcaf77f60497a2f2066e712207a11c12d9f` (46,853 bytes) |
| `solver.wasm` | sha256 `1326a460f26c47b799ac0f98f5368e75422574acd7c964b18459f57b672ca270` (60,821 bytes) |

A rebuild with the same source commit and Emscripten version reproduces these
hashes byte for byte; a different Emscripten version changes the JS glue and
therefore `solver.mjs`'s hash (the `.wasm` hash is far more stable).

## Missing artifact behavior

If `solver.wasm` is absent (fresh build without this step, or a stripped
deployment), the engine fails one `HEAD` pre-flight check and reports a single
clear console line before falling back to the JS engine — no Emscripten
`Aborted(...)` stack, no `ERR_FILE_NOT_FOUND` noise.

After building, rerun `node scripts/build-phase0.js` to copy the artifacts into
`dist/extension/wasm/` (extension package) and `dist/wasm/` (next to the
bookmarklet bundle, which resolves them against the bundle's own URL).
