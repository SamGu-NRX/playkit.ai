# chess-stockfish — chess versus a node-budgeted Stockfish ladder

A chess game whose opponent is Stockfish, driven over UCI. Rules, move
grammar, observation, and adjudication are delegated to the built-in
`chess` game; the tier ladder is four fixed node budgets instead of
engine strength levels. Every search is `go nodes <budget>`, never
`movetime` or `skill level`, so a tier's play is a pure function of
(binary, position, options, budget) — same seed, same episode.

## Files

| File | Purpose |
|---|---|
| `index.js` | Game module: identity, four tiers, delegation to `chess` |
| `stockfish-agent.js` | The Stockfish opponent: lazy UCI client, per-episode config, node-budget search, diagnostics |
| `verify.js` | Deep verification (conformance, determinism, ladder comparison) |
| `chess-stockfish.test.js` | Fast suite plus engine-gated real-engine tests |
| `../../engines/uci/client.js` | Shared UCI client: discovery, parsing, lifecycle, timeouts |
| `../../engines/uci/fixtures/fake-uci-engine.mjs` | Scripted fake engine for non-node-locked tests |

## Tiers

| Tier | `go nodes` | Public seeds | `maxActions` |
|---|---|---|---|
| `sf-1k` | 1,000 | 5 | 150 |
| `sf-10k` | 10,000 | 5 | 150 |
| `sf-100k` | 100,000 | 5 | 120 |
| `sf-1m` | 1,000,000 | 5 | 80 |

Timing (Stockfish 17.1, one thread, 16 MB hash, measured 2026-10-15 on
the development sandbox): ~6 ms / 32 ms / 0.3 s / 3 s per search at the
four budgets. Tier timeouts give several multiples of headroom.

## Engine wiring

- Discovery: `GAUNTLET_STOCKFISH` if set, else `stockfish` on `PATH`
  (`/usr/games` included). A missing binary surfaces an error that names
  the env var, the searched `PATH`, and the install hint.
- Configuration: exactly one thread, fixed 16 MB hash,
  `MultiPV 1`, `Contempt 0`, skill left at the default (node count is
  the only strength control).
- Lifecycle: one `ucinewgame` per episode, `position fen <start> moves ...`
  before each search, `quit` on dispose; the client kills a silent engine
  after its idle timeout and fails a command that misses its deadline.

The opponent records its identity and search statistics in reply meta:
engine id-name slug, resolved binary path, node budget, reported depth,
nodes, nps, and score from the last `info` line.

Node-only dependency: spawning a UCI engine requires Node's
`child_process`. Importing this game in a non-Node runtime throws before
any game logic runs (the same contract the browser bridge relies on).

## Testing

```sh
npm test                                  # fast suite; real-engine tests auto-skip without a binary
node games/chess-stockfish/verify.js      # deep verification; requires Stockfish
```

The fast suite covers the spec, delegation to `chess`, opponent identity
and validation, fixture-driven engine wiring through
`GAUNTLET_STOCKFISH`, and the two no-engine failure modes. When a
Stockfish binary is present, gated tests additionally run full episodes:
conformance on one public seed per tier, same-seed determinism at the
two lightest tiers, and the diagnostics of a real search.

`verify.js` goes further: conformance on two seeds per tier, determinism
at the two heaviest tiers, and a strength comparison — the `sf-10k`
tier against the built-in chess ladder's `granite` rung over the five
public seeds with alternating colours; acceptance is Stockfish scoring
at least 3 of 5 points.

## Licensing note

Stockfish is GPL-3.0-or-later and is not distributed with this
repository; it is discovered at runtime like any external engine
(`requires: ["node", "stockfish"]`). No Stockfish source or binary is
vendored here, and this game does not link Stockfish code — it talks the
UCI protocol to whatever binary the runner provides.
