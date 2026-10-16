# Committed Qwen chess trajectories — invalid-reply classification

Source: `reports/first-model-run/run-qwen/{chess,chess-stockfish,chess-endgames}`, replayed and re-judged with the current game code (`judgeReply`, the same accept/reject decision the runner and verifier use). Every observation hash re-verified, so the classification transfers exactly: notation.js and render.js are unchanged since the v1.0.0 the run was recorded at.

Episodes: 12. Invalid agent replies: 49.

| Category | Count |
|---|---:|
| illegal-move | 35 |
| wrong-notation | 14 |

Stale repeats (same attempted text as the previous attempt): 20/49.
Observation listed the legal moves at the invalid step: 49/49.

Note (chess v1.2.0): the parser now distinguishes SAN-shaped illegal strings —
the 14 `wrong-notation` pawn pushes would now be rejected as
`move "e5" is not legal in the current position` instead of the catch-all
`cannot parse ... as UCI ... or SAN ...` diagnostic. The categories and counts
above are unchanged; only the judge reason strings for those 14 rows differ
under the current code.

## Every invalid reply

| Episode | Step | Attempted | Category | Stale repeat | Legal listed | Judge reason |
|---|---:|---|---|---|---|---|
| chess/granite/chess/granite/public/0.json | 1 | `e5` | wrong-notation | no | yes (42) | cannot parse "e5" as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O") |
| chess/granite/chess/granite/public/0.json | 2 | `e5` | wrong-notation | yes | yes (42) | cannot parse "e5" as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O") |
| chess/granite/chess/granite/public/0.json | 3 | `h5` | wrong-notation | no | yes (42) | cannot parse "h5" as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O") |
| chess/paper/chess/paper/public/0.json | 1 | `e2e4` | illegal-move | no | yes (42) | move "e2e4" is not legal in the current position |
| chess/paper/chess/paper/public/0.json | 6 | `e5` | wrong-notation | no | yes (36) | cannot parse "e5" as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O") |
| chess/paper/chess/paper/public/0.json | 7 | `e5` | wrong-notation | yes | yes (36) | cannot parse "e5" as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O") |
| chess/paper/chess/paper/public/0.json | 8 | `e5` | wrong-notation | yes | yes (36) | cannot parse "e5" as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O") |
| chess/steel/chess/steel/public/0.json | 0 | `g1e2` | illegal-move | no | yes (43) | move "g1e2" is not legal in the current position |
| chess/steel/chess/steel/public/0.json | 1 | `e7e5` | illegal-move | no | yes (43) | move "e7e5" is not legal in the current position |
| chess/steel/chess/steel/public/0.json | 2 | `e7e5` | illegal-move | yes | yes (43) | move "e7e5" is not legal in the current position |
| chess/wood/chess/wood/public/0.json | 1 | `e5` | wrong-notation | no | yes (36) | cannot parse "e5" as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O") |
| chess/wood/chess/wood/public/0.json | 4 | `e5` | wrong-notation | no | yes (32) | cannot parse "e5" as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O") |
| chess/wood/chess/wood/public/0.json | 5 | `g1f3` | illegal-move | no | yes (32) | move "g1f3" is not legal in the current position |
| chess/wood/chess/wood/public/0.json | 6 | `f3f5` | illegal-move | no | yes (32) | move "f3f5" is not legal in the current position |
| chess-stockfish/sf-100k/chess-stockfish/sf-100k/public/0.json | 1 | `d6` | wrong-notation | no | yes (31) | cannot parse "d6" as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O") |
| chess-stockfish/sf-100k/chess-stockfish/sf-100k/public/0.json | 4 | `e5` | wrong-notation | no | yes (37) | cannot parse "e5" as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O") |
| chess-stockfish/sf-100k/chess-stockfish/sf-100k/public/0.json | 11 | `e8e5` | illegal-move | no | yes (32) | move "e8e5" is not legal in the current position |
| chess-stockfish/sf-100k/chess-stockfish/sf-100k/public/0.json | 12 | `h6h5` | illegal-move | no | yes (32) | move "h6h5" is not legal in the current position |
| chess-stockfish/sf-100k/chess-stockfish/sf-100k/public/0.json | 13 | `g7g5` | illegal-move | no | yes (32) | move "g7g5" is not legal in the current position |
| chess-stockfish/sf-10k/chess-stockfish/sf-10k/public/0.json | 0 | `e5` | wrong-notation | no | yes (30) | cannot parse "e5" as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O") |
| chess-stockfish/sf-10k/chess-stockfish/sf-10k/public/0.json | 1 | `d6` | wrong-notation | no | yes (30) | cannot parse "d6" as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O") |
| chess-stockfish/sf-10k/chess-stockfish/sf-10k/public/0.json | 4 | `e2e4` | illegal-move | no | yes (36) | move "e2e4" is not legal in the current position |
| chess-stockfish/sf-10k/chess-stockfish/sf-10k/public/0.json | 5 | `h3h4` | illegal-move | no | yes (36) | move "h3h4" is not legal in the current position |
| chess-stockfish/sf-10k/chess-stockfish/sf-10k/public/0.json | 6 | `h3h4` | illegal-move | yes | yes (36) | move "h3h4" is not legal in the current position |
| chess-stockfish/sf-1k/chess-stockfish/sf-1k/public/0.json | 1 | `e4` | wrong-notation | no | yes (31) | cannot parse "e4" as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O") |
| chess-stockfish/sf-1k/chess-stockfish/sf-1k/public/0.json | 4 | `h6h4` | illegal-move | no | yes (28) | move "h6h4" is not legal in the current position |
| chess-stockfish/sf-1k/chess-stockfish/sf-1k/public/0.json | 5 | `h5h6` | illegal-move | no | yes (28) | move "h5h6" is not legal in the current position |
| chess-stockfish/sf-1k/chess-stockfish/sf-1k/public/0.json | 6 | `h5h6` | illegal-move | yes | yes (28) | move "h5h6" is not legal in the current position |
| chess-stockfish/sf-1m/chess-stockfish/sf-1m/public/0.json | 0 | `e2e4` | illegal-move | no | yes (30) | move "e2e4" is not legal in the current position |
| chess-stockfish/sf-1m/chess-stockfish/sf-1m/public/0.json | 1 | `d4` | wrong-notation | no | yes (30) | cannot parse "d4" as UCI (e.g. "e2e4", "e7e8q") or SAN (e.g. "Nf3", "O-O") |
| chess-stockfish/sf-1m/chess-stockfish/sf-1m/public/0.json | 2 | `e2e4` | illegal-move | no | yes (30) | move "e2e4" is not legal in the current position |
| chess-endgames/kbbk/chess-endgames/kbbk/public/0.json | 6 | `e5a1` | illegal-move | yes | yes (20) | move e5a1 is not legal here |
| chess-endgames/kbbk/chess-endgames/kbbk/public/0.json | 7 | `e5a1` | illegal-move | yes | yes (20) | move e5a1 is not legal here |
| chess-endgames/kbbk/chess-endgames/kbbk/public/0.json | 8 | `e5a1` | illegal-move | yes | yes (20) | move e5a1 is not legal here |
| chess-endgames/kbnk/chess-endgames/kbnk/public/0.json | 2 | `a7c5` | illegal-move | yes | yes (18) | move a7c5 is not legal here |
| chess-endgames/kbnk/chess-endgames/kbnk/public/0.json | 11 | `e5d4` | illegal-move | yes | yes (16) | move e5d4 is not legal here |
| chess-endgames/kbnk/chess-endgames/kbnk/public/0.json | 16 | `a2a3` | illegal-move | no | yes (20) | move a2a3 is not legal here |
| chess-endgames/kbnk/chess-endgames/kbnk/public/0.json | 27 | `a7d4` | illegal-move | yes | yes (19) | move a7d4 is not legal here |
| chess-endgames/kbnk/chess-endgames/kbnk/public/0.json | 32 | `a7b6` | illegal-move | yes | yes (16) | move a7b6 is not legal here |
| chess-endgames/kbnk/chess-endgames/kbnk/public/0.json | 33 | `a7b6` | illegal-move | yes | yes (16) | move a7b6 is not legal here |
| chess-endgames/kqk/chess-endgames/kqk/public/0.json | 2 | `move c7b6` | illegal-move | no | yes (33) | move c7b6 is not legal here |
| chess-endgames/kqk/chess-endgames/kqk/public/0.json | 5 | `d3a3` | illegal-move | yes | yes (29) | move d3a3 is not legal here |
| chess-endgames/kqk/chess-endgames/kqk/public/0.json | 6 | `d3d5` | illegal-move | no | yes (29) | move d3d5 is not legal here |
| chess-endgames/kqk/chess-endgames/kqk/public/0.json | 7 | `d5d4` | illegal-move | no | yes (29) | move d5d4 is not legal here |
| chess-endgames/krk/chess-endgames/krk/public/0.json | 2 | `d5c4` | illegal-move | yes | yes (22) | move d5c4 is not legal here |
| chess-endgames/krk/chess-endgames/krk/public/0.json | 5 | `c4b3` | illegal-move | yes | yes (22) | move c4b3 is not legal here |
| chess-endgames/krk/chess-endgames/krk/public/0.json | 6 | `c4b3` | illegal-move | yes | yes (22) | move c4b3 is not legal here |
| chess-endgames/krk/chess-endgames/krk/public/0.json | 21 | `a2a1` | illegal-move | yes | yes (13) | move a2a1 is not legal here |
| chess-endgames/krk/chess-endgames/krk/public/0.json | 50 | `a2a1` | illegal-move | yes | yes (13) | move a2a1 is not legal here |

## Per-episode endings

| Episode | End | Agent actions | Invalid actions | Categories in order |
|---|---|---:|---:|---|
| chess/granite/chess/granite/public/0.json | forfeit-invalid | 3 | 3 | wrong-notation, wrong-notation, wrong-notation |
| chess/paper/chess/paper/public/0.json | forfeit-invalid | 6 | 4 | illegal-move, wrong-notation, wrong-notation, wrong-notation |
| chess/steel/chess/steel/public/0.json | forfeit-invalid | 3 | 3 | illegal-move, illegal-move, illegal-move |
| chess/wood/chess/wood/public/0.json | forfeit-invalid | 5 | 4 | wrong-notation, wrong-notation, illegal-move, illegal-move |
| chess-stockfish/sf-100k/chess-stockfish/sf-100k/public/0.json | forfeit-invalid | 9 | 5 | wrong-notation, wrong-notation, illegal-move, illegal-move, illegal-move |
| chess-stockfish/sf-10k/chess-stockfish/sf-10k/public/0.json | forfeit-invalid | 6 | 5 | wrong-notation, wrong-notation, illegal-move, illegal-move, illegal-move |
| chess-stockfish/sf-1k/chess-stockfish/sf-1k/public/0.json | forfeit-invalid | 5 | 4 | wrong-notation, illegal-move, illegal-move, illegal-move |
| chess-stockfish/sf-1m/chess-stockfish/sf-1m/public/0.json | forfeit-invalid | 3 | 3 | illegal-move, wrong-notation, illegal-move |
| chess-endgames/kbbk/chess-endgames/kbbk/public/0.json | forfeit-invalid | 6 | 3 | illegal-move, illegal-move, illegal-move |
| chess-endgames/kbnk/chess-endgames/kbnk/public/0.json | terminal | 22 | 6 | illegal-move, illegal-move, illegal-move, illegal-move, illegal-move, illegal-move |
| chess-endgames/kqk/chess-endgames/kqk/public/0.json | forfeit-invalid | 6 | 4 | illegal-move, illegal-move, illegal-move, illegal-move |
| chess-endgames/krk/chess-endgames/krk/public/0.json | budget-exhausted | 40 | 5 | illegal-move, illegal-move, illegal-move, illegal-move, illegal-move |

