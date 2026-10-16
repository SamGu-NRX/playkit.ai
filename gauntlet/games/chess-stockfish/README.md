# chess-stockfish — chess versus a node-budgeted Stockfish ladder

A chess game whose opponent is Stockfish, driven over UCI. Rules, move
grammar, observation, and adjudication are delegated to the built-in
`chess` game; the tier ladder is five fixed node budgets instead of
engine strength levels. Every search is `go nodes <budget>`, never
`movetime` or `skill level`, so a tier's play is a pure function of
(binary, position, options, budget) — same seed, same episode.

## Files

| File | Purpose |
|---|---|
| `index.js` | Game module: identity, five tiers, delegation to `chess` |
| `stockfish-agent.js` | The Stockfish opponent: lazy UCI client, per-episode config, node-budget search, diagnostics |
| `verify.js` | Deep verification (conformance, determinism, ladder comparison) |
| `chess-stockfish.test.js` | Fast suite plus engine-gated real-engine tests |
| `../../engines/uci/client.js` | Shared UCI client: discovery, option advertisement, lifecycle, timeouts |
| `../../engines/uci/fixtures/fake-uci-engine.mjs` | Scripted fake engine for non-node-locked tests |

## Tiers

| Tier | `go nodes` | Public seeds | `maxActions` |
|---|---|---|---|
| `sf-250` | 250 | 5 | 150 |
| `sf-1k` | 1,000 | 5 | 150 |
| `sf-10k` | 10,000 | 5 | 150 |
| `sf-100k` | 100,000 | 5 | 150 |
| `sf-1m` | 1,000,000 | 5 | 150 |

Timing (Stockfish 17.1, one thread, 16 MB hash, measured 2026-10-15 on
the development sandbox): ~6 ms / 32 ms / 0.3 s / 3 s per search at the
1k / 10k / 100k / 1m budgets. The `sf-250` budget sits well under the
`sf-1k` figure; tier timeouts give several multiples of headroom.

## Engine wiring

- Discovery: `GAUNTLET_STOCKFISH` wins when set — for Stockfish lookups
  only, so one shared env var cannot silently replace a different engine
  requested by name — and must exist. Otherwise `stockfish` is looked up
  on `PATH`, then in `/usr/games` and `/usr/local/games` (Debian and
  Ubuntu install game binaries to `/usr/games`, which non-interactive
  PATHs often omit). When nothing is found the opponent surfaces:
  `no Stockfish binary found: install stockfish (e.g. apt install stockfish) or set GAUNTLET_STOCKFISH to the binary path`.
  When `GAUNTLET_STOCKFISH` points at a missing file, discovery throws:
  `GAUNTLET_STOCKFISH is set to "<path>" but that file does not exist`.
- Configuration: the opponent pins Threads 1, Hash 16, MultiPV 1 and
  Contempt 0 — each `setoption` sent only when the engine actually
  advertises the option (recent Stockfish releases removed Contempt, and
  the client is engine-generic). Skill is left at its default: node count
  is the only strength control. A tier with `params.elo` instead limits
  strength through `UCI_LimitStrength`/`UCI_Elo`, and fails loudly if the
  binary does not advertise `UCI_Elo`. Exactly which options were sent is
  recorded in every reply's meta.
- Lifecycle: one `ucinewgame` per episode, `position fen <start> moves ...`
  before each search, and `quit` inside the runner's episode `finally` —
  success or throw — so a finished episode never leaves an engine process
  behind. The client additionally kills a silent engine after its idle
  timeout and fails a command that misses its deadline.

The opponent records its identity and search statistics in reply meta:
engine id-name, resolved binary path, node budget, reported depth,
searched nodes, nps, a centipawn or mate score from the last `info`
line, and the options actually set.

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
`GAUNTLET_STOCKFISH` (including the exact `setoption` lines a spawned
engine receives), and the two no-engine failure modes. When a Stockfish
binary is present, gated tests additionally run full episodes:
conformance on one public seed per tier, same-seed determinism at the
two lightest tiers, the diagnostics of a real search, and a CLI play run
that must exit within seconds of its last episode.

`verify.js` goes further: conformance on two seeds per tier, determinism
at the two heaviest tiers, and a strength comparison — the `sf-10k`
tier against the built-in chess ladder's `granite` rung over the five
public seeds with alternating colours; acceptance is Stockfish scoring
at least 3 of 5 points. Its engines are episode opponents built inside
`runEpisode`, so the episode `finally` releases them between episodes
too.

## Licensing note

Stockfish is GPL-3.0-or-later and is not distributed with this
repository; it is discovered at runtime like any external engine
(`requires: ["stockfish"]`). No Stockfish source or binary is
vendored here, and this game does not link Stockfish code — it talks the
UCI protocol to whatever binary the runner provides.
