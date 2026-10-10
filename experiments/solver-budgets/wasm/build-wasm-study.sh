#!/usr/bin/env bash
# Build the WASM arm of the solver-budgets study: the submodule's own
# export_solver.cpp compiled with Emscripten, with the SAME flags as
# scripts/build-wasm.js but written to this experiment's build dir so the
# committed src/extension/wasm/ artifacts are never touched.
#
# Usage: bash experiments/solver-budgets/wasm/build-wasm-study.sh
# Requires emcc on PATH (source emsdk_env.sh first).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$ROOT/experiments/solver-budgets/build/wasm"

mkdir -p "$OUT"

# The solver fork expects a header-only sparsehash at vendor/sparsehash/src
# (gitignored, not shipped). This sandbox provides it via the Debian package
# libsparsehash-dev; vendor the headers into the study build dir (never into
# the submodule) and point the include path there. Header-only, templated —
# no glibc objects are linked.
SPARSEHASH_DIR="$ROOT/experiments/solver-budgets/build/sparsehash-include"
if [ ! -d "$SPARSEHASH_DIR/sparsehash" ]; then
  mkdir -p "$SPARSEHASH_DIR"
  cp -r /usr/include/sparsehash "$SPARSEHASH_DIR/"
fi

em++ "$ROOT/solver/wasm/export_solver.cpp" \
  -std=c++17 -O3 -sASSERTIONS=0 \
  --bind \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=web,node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sWASM_BIGINT=1 \
  -sSUPPORT_LONGJMP=0 \
  -sDISABLE_EXCEPTION_CATCHING=1 \
  -sEXPORTED_RUNTIME_METHODS=['cwrap','ccall'] \
  -sEXPORT_NAME=createSolverModule \
  -I "$ROOT/solver" \
  -I "$SPARSEHASH_DIR" \
  -o "$OUT/solver.mjs"

echo "WASM study build complete: $OUT/solver.mjs + solver.wasm"
