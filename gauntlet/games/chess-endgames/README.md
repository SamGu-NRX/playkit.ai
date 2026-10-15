# chess-endgames

A Gauntlet game: the agent holds winning material and must checkmate a king
that defends perfectly. Scored by efficiency against the exact optimum — the
distance-to-mate (DTM) of the start position, read from tablebases this
package builds itself by retrograde analysis. No external tablebases, no
network, no `node:*` in game code.

## Tiers

| tier  | rank | material            | DTM band (attacker moves) | maxActions |
|-------|------|---------------------|---------------------------|------------|
| kqk   | 1    | K+Q vs K            | 6–10 (table max 10)       | 50         |
| krk   | 2    | K+R vs K            | 10–16 (table max 16)      | 80         |
| kbbk  | 3    | K+B+B (opposite colours) vs K | 12–19 (table max 19) | 95   |
| kbnk  | 4    | K+B+N vs K          | 20–33 (table max 33)      | 165        |

Each band rises in floor and ceiling over the previous tier and every band
maximum is the published DTM maximum of its ending, so each tier is strictly
harder than the last. `maxActions = 5 × band max`. The 50-move rule binds on
its own inside the budget.

## Tablebase design (tablebase.js)

- Positions are indexed canonically under the 8-fold symmetry of the
  pawnless board: the white king is mapped to the 10-square orbit
  representative triangle a1–d4, so kbbk/kbnk store `10 × 64 × 64 × 64` bytes
  per side to move (2,621,440 × 2) in typed arrays; kqk/krk store
  `10 × 64 × 64` per side.
- Values in one byte: `0` mate, `1..60` DTM in attacker moves,
  `254` drawn/unknown, `255` illegal.
- Retrograde analysis, layered from the mates: white-to-move values finalise
  on the first (smallest) finalised defender child, defender values finalise
  when every legal defender move has a finalised child (a defender move into
  insufficient material is counted but never finalises, so those positions
  stay drawn, as they should).
- Built lazily once per process, kept in memory. Build time and peak memory
  are measured on the sandbox and reported in the PR (target: < 60 s and
  < 1.5 GB for all four tables).

## Game (index.js)

- White (the agent, seat 0) plays against a built-in defender (seat 1) that
  replies with the longest resistance: highest DTM, or a drawing move when
  one exists, ties broken by the episode RNG.
- Actions: UCI is canonical (`e1e2`); SAN is accepted as an alternate.
  `legalActions` is the sorted UCI list.
- The observation shows the FEN, an ASCII board, actions left in the budget
  and plies left before the 50-move rule — never a DTM or par value.
- Checkmate solves; stalemate, insufficient material, threefold repetition,
  the 50-move rule or an exhausted budget are unsolved and score 0.

## Baselines (baselines.js)

- `engine`: tablebase-optimal play; must score 1.0 on every public seed.
- `greedy`: mate in one if available, else the move that leaves the
  defending king fewest legal moves, seeded ties, no tablebase.

## Tests

Strict, because these tables have one right answer: the four table maxima
must equal the published values (10/16/19/33 with the attacker to move);
2,000 seeded random legal positions per table cross-checked against chess.js
(terminal flags and the DTM descent property); move sets cross-checked
against chess.js; the game run through the conformance kit on every tier;
engine episodes replay-verified per tier.
