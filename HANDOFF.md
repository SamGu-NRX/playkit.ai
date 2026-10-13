# Handoff — Playkit 2048 hardening (draft PR #1)

Branch `obv/products-playkit-hardening-20261009`, draft PR
https://github.com/SamGu-NRX/playkit.ai/pull/1. Nothing merged, nothing
deployed, no submodule/workflow/repository-settings changes.

## What is in this PR

1. **Hardened runtime + benchmark foundation** (earlier commits): adapter
   null-reads on unobservable boards, invalidated detached adapter caches,
   HUD pause/resume, driver stop-on-dead-board / failed-read bounds /
   no-progress bounds, 16-scenario browser benchmark, Node test suites.
   Post-fix browser run 16/16 (`bench/evidence/postfix-run.json`).
2. **Board encoding as an explicit validated contract (FIX-1)** — commit
   `d73a4e9`: `BoardEncoder.toExponentArray` / `toBitboard` no longer guess
   values-vs-exponents from tile contents (a board's contents cannot
   identify its encoding). Callers must pass
   `{ encoding: "values" | "exponents" }`; every cell is validated:
   values must be integer 0 or a power of two in [2, 2^15] (1 is
   `AMBIGUOUS_VALUE` — it would encode as exponent 0 = empty), exponents
   must be 0..15; failures throw `BoardEncodingError` with a
   machine-readable code naming the offending cell. Nothing clamps
   silently. `wasm-solver.js` encodes with `{ encoding: "values" }`
   (adapters supply tile values). The values-only regression is enabled;
   the old content-guessing pins are removed. Bundle rebuilt and
   re-verified in a real browser: **16/16 scenarios**
   (`bench/evidence/encoding-contract-run.json`).

## Exact check commands

Run from the repo root (Node ≥ 20; no package install needed):

```bash
# Node suite — expect: 71 pass, 0 fail, 3 skipped
#   (the 3 skips are solver-side FIX-2 dead-board and FIX-3 engine-identity
#    target-behavior tests, marked test.skip with TODO(FIX-n) notes; they
#    are NOT passes)
node --test test/*.test.mjs 2>&1 | grep -E "^# (pass|fail|skipped)|not ok"

# Study-scoped tests — expect: 17 pass, 0 fail
node --test experiments/solver-budgets/tests/ 2>&1 | grep -E "^# (pass|fail)"

# Rebuild the bundle from sources — expect: no diff after `git status`
node scripts/build-phase0.js && git status --short

# Browser benchmark — serve, open, Run all scenarios, Save run;
# expect 16/16 and a run JSON in bench/results/
node scripts/serve-bench.mjs 8765 &
# then open http://localhost:8765/bench/runner.html

# Replay witness for the study's measured runs — expect "agree" for every
# arm, final-board agreement 100.0%
node experiments/solver-budgets/run.mjs --replay \
  experiments/solver-budgets/results/run-2026-10-11T01-59-11-757Z
```

## Known limits

- Real `solver.wasm` is absent and `emcc` unavailable in the dev sandbox:
  the production `SolverManager` runs its declared naive fallback (by
  design; recorded per move in the study's adapter arm). The study's
  study-local WASM build (`experiments/solver-budgets/build/wasm/`,
  built with emsdk on the measuring machine) covers compiled-engine
  behavior; see `experiments/solver-budgets/HANDOFF.md`.
- Study numbers are machine-specific measurements, not portable claims.
- The hardening branch carries no `experiments/` changes; the study lives
  on `obv/products-l2-solver-budgets-20261010` in its own draft PR into
  this branch.
