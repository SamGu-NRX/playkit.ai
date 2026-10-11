# Playground: practice-board 2048 (M1 checkpoint)

A practice page that plays 2048 against the project's real solver stack,
with a fully explicit, replayable move history.

## Layout (planned paths on branch obv/products-l5-practice-2048)

- `playground/js/engine.mjs` — independent practice engine: strict
  value-encoded board validation (matches the parent FIX-1 `BoardEncoder`
  contract, incl. refusal of the ambiguous value 1), moves with MERGE-VALUE
  scoring ([2,2,4,4] left = 12; spawns earn 0; no-ops earn 0 and never
  spawn), explicit spawns. No imports from `src/`.
- `playground/js/log.mjs` — versioned move log (`playkit.practice-board.log`
  v1): `createLog`, `appendMove` (recomputes transitions, refuses no-ops and
  missing spawns), `serializeLog`/`parseLog` (byte-identical round trip;
  wrong/incomplete/corrupt logs are REFUSED with machine-readable codes,
  never repaired), `verifyDocument`/`finalBoardOf` replay verification.
- `playground/js/solver-adapter.mjs` — narrow adapter over the REAL
  `SolverManager` (src/solver/solver-manager.js): reports the OBSERVED
  backend (WASM or the manager's DECLARED naive fallback) verbatim; invents
  no solver rationale; `SolverUnavailableError` when no order can be made.
- `playground/test/*.test.mjs` — node:test suites: hand-scored fixtures
  (evidence/controls-fixture.json), 500 seeded random-board cross-checks
  against BOTH the parent reference (test/helpers/reference-2048.mjs) AND
  the solver's MOVE_SIMULATORS (src/solver/naive-solver.js), log refusal
  matrix, adapter backend-labeling and legality checks.
- `playground/evidence/` — shared fixtures, backend collector
  (collect-backend.mjs), and the solver-arms contract (solver-arms.md).

## Status (HONEST)

- Tests authored but NEVER RUN (sandbox death-storm; see PR Handoff).
- UI (page + app controller) is DESIGNED but NOT YET WRITTEN.
- WASM arm UNRUN (solver.wasm absent in this environment, per parent
  HANDOFF.md); the declared naive fallback is the expected observed backend.
- No measurements exist for anything in this checkpoint.

## Verify (once a healthy machine is available)

```sh
cd <repo root>
node --test playground/test/            # engine, log, adapter suites
node playground/evidence/collect-backend.mjs   # observed-backend JSON
python3 -m http.server 8000             # then open /playground/practice.html (UI pending)
```
