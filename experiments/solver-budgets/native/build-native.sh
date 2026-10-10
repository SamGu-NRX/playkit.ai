#!/usr/bin/env bash
# Build the native C++ arm of the solver-budgets study.
#
# The 2048-solver submodule headers do not compile unmodified on Linux/g++
# because eval_t = int64_t is `long` there but was written for platforms where
# it is `long long` (two `0LL` literals in heuristics.hpp fail std::max
# deduction). The submodule must stay pristine, so this script COPIES the
# headers into build/native-src/ and applies the minimal type-compatibility
# patch there (documented in README.md and results identity). The submodule
# itself is never touched.
set -euo pipefail

repoRoot="$(cd "$(dirname "$0")/../../.." && pwd)"
srcSolver="$repoRoot/solver"
outDir="$repoRoot/experiments/solver-budgets/build"
stage="$outDir/native-src"

rm -rf "$stage"
mkdir -p "$stage/strategies" "$outDir"

cp "$srcSolver/game.hpp" "$srcSolver/util.hpp" "$srcSolver/heuristics.hpp" "$stage/"
cp "$srcSolver/strategies/"*.hpp "$stage/strategies/"

# Type-compat patch (Linux, where int64_t = long): replace the two `0LL`
# literals in std::max calls with eval_t(0) so the initializer lists deduce a
# single type. No behavior change on platforms where it already compiled.
sed -i 's/\b0LL\b/eval_t(0)/g' "$stage/heuristics.hpp"

g++ -std=c++17 -O2 -DREQUIRE_DETERMINISTIC -I "$stage" -pthread \
  "$repoRoot/experiments/solver-budgets/native/shim.cpp" \
  -o "$outDir/native-solver"

echo "native-solver built: $outDir/native-solver"
