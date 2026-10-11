# Solver arms — what the practice page runs, observes, and records

The practice page never reimplements or simulates a solver. It drives the
existing `SolverManager` (src/solver/solver-manager.js) through a narrow
adapter (playground/js/solver-adapter.mjs) and records the OBSERVED backend
verbatim in the UI and in every log entry.

## Arms

1. **WASM (preferred)** — `src/extension/wasm/solver.mjs` + `solver.wasm`.
   STATUS IN THIS ENVIRONMENT: **UNRUN** — `solver.wasm` is gitignored and
   absent (parent HANDOFF.md), so this arm cannot execute here. When a
   build provides the asset, the manager uses it and the page labels it
   "WASM solver (expectimax-depth, corner heuristic)".
2. **Declared naive fallback** — the manager's own designed fallback when
   the WASM module fails to load. The adapter labels it verbatim ("naive
   fallback — the runtime's declared fallback engine (WASM unavailable)")
   and the manager's recorded load error is surfaced, not hidden.
3. **Unavailable** — if the manager cannot produce a move order at all, the
   adapter surfaces `SolverUnavailableError`; the page records no move, no
   spawn, and no document change.

## What is never done

- No solver rationale is invented; the solver's move ORDER is recorded as
  the observed fact.
- A missing backend is never substituted silently.
- The WASM arm is never claimed to have run when it did not.

## Collector

`node playground/evidence/collect-backend.mjs` prints one JSON object: the
attempted arm, the observed backend, the manager status and recorded WASM
load error, the produced move order, and the chosen legal direction. STATUS:
**UNRUN** (no test execution happened in this session — see README status
block).
