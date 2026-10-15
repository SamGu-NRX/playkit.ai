# PlayKit Gauntlet — core

Gauntlet is PlayKit's benchmark of difficult, popular games for frontier AI
agents: chess against an engine ladder, Minesweeper, 2048, sliding puzzles,
Sokoban, Connect Four, Mastermind, heads-up limit hold'em, and tic-tac-toe.
This package is the foundation those game packets build on. It is deliberately
its own package: its dependencies (including `chess.js` 1.4.0) stay out of the
browser-extension bundle, and its contract is fixed so game, agent-harness,
scoring and wire-protocol packets can land in parallel.

## Layout

| Path                | What it is                                                        |
| ------------------- | ----------------------------------------------------------------- |
| `core/types.js`     | The environment contract, as JSDoc typedefs. Names are fixed.     |
| `core/rng.js`       | Seeded RNG: cyrb128 → sfc32, pure functions + mutable stream.     |
| `core/seeds.js`     | Public seed format `<game>/<tier>/public/<i>`.                    |
| `core/seeds-node.js`| Node-only eval seeds (salted HMAC) and the salt commitment.       |
| `core/canonical.js` | Canonical JSON (sorted keys) and FNV-1a 64-bit observation hash.  |
| `core/runner.js`    | `runEpisode`: seats agents, parses replies, ends episodes.        |
| `core/trajectory.js`| `playkit-gauntlet-trajectory/1` format + replay verifier.         |
| `core/conformance.js`| The checks every registered game must pass.                      |
| `agents/random.js`  | Baseline random agent, seeded from episode seed + agent id.       |
| `agents/sliding-solver.js` | Optimal sliding-puzzle reference solver (IDA*).            |
| `games/`            | Explicit registry (`games/index.js`) plus the nine games.         |
| `harness/`          | Official-track prompts, model clients, dry-run/replay agents.     |
| `scoring/`          | Suite manifests, entry scoring, and the leaderboard.              |
| `protocol/`         | JSON-Lines wire protocol over stdin/stdout (`serve`).             |
| `clients/python/`   | The `playkit_gauntlet` Python client for the wire protocol.       |
| `cli/`              | The `gauntlet` CLI (in `cli/` because root ignores `bin/`).       |
| `test/integration/` | Registry conformance, CLI end-to-end, Python-serve integration.   |

## The contract in one screen

A **Game** is a bundle of pure functions over a JSON-serializable state:
`reset(tier, seed)`, `toAct(S)`, `observe(S, seat)`, `legalActions(S, seat)`
(sorted, canonical), `parseAction(S, seat, text)` (accepts documented
alternates), `step(S, seat, action)` (throws `GauntletRuleError` for anything
not in `legalActions`), `outcome(S)` (exactly when `toAct` is null),
`truncate(S)` (required when a tier scores by outcome), `opponent` and
`agentSeat` (required/used when `seats` is 2).

An **Agent** answers `act(ctx)` with `{ text, usage?, meta? }`; the runner
reads the action from the reply's last non-empty line, stripping wrapping
backticks/quotes and a leading `action:`. Official-track agents see only
`observation.text` — no `legalActions` list. Invalid attempts are recorded,
count against `maxActions`, and feed back as `feedback`; three consecutive
invalid attempts forfeit; exhausting the budget ends the episode via
`truncate` (outcome tiers) or an unsolved outcome (efficiency tiers).

**Trajectories** record every step with an FNV-1a 64-bit hash of the
observation's canonical JSON, so `verifyTrajectory` can replay any recorded
episode from `(game, tier, seed)` alone and catch tampering with actions,
hashes, counts, or the outcome.

## Agents

`harness/` holds the agent implementations:

- `official.js` — the official-track prompt (a verbatim ARC-AGI-3 system
  prompt) and the per-turn user message: rules, the full previous reply,
  invalid-action feedback when present, then the current state. Bounded so a
  turn's message stays within size limits.
- `model-agent.js` — provider-backed agents for Anthropic Messages and OpenAI
  Responses over global `fetch` (no SDKs). Keys are read from the environment
  at call time and never logged; 429/5xx/network errors retry with exponential
  backoff and surface the retry count in the reply's metadata; token usage is
  recorded, and costs are computed only from a caller-supplied, sourced price
  file (`prices.example.json` shows the shape).
- `dry-run.js` — offline agents: a scripted agent (static list or function)
  and a replay agent that re-plays a recorded trajectory against the same
  `(game, tier, seed)`, refusing on an observation-hash mismatch. Both record
  `dryRun: true` and zero usage so trajectories distinguish them from real
  model runs.

Model-client tests run offline against a local `node:http` stub on
`127.0.0.1`; no paid API calls.

## Suites, scoring, and the leaderboard

A **suite manifest** (`scoring/suite.js`, format
`playkit-gauntlet-suite/1`) pins the benchmark: the split, the games, and —
per tier — the exact seed list an entry must cover. Public suites list public
seeds; eval suites derive salted seeds from a secret salt and record only the
salt commitment. The nine registered games span 31 tiers and 486 public
seeds; tic-tac-toe is the smoke game (scored, but `benchmark: false`, so it
excludes entries from the benchmark-score aggregate while still counting
toward coverage).

`scoring/score.js` scores one agent's trajectories against a manifest: episode
scores (outcome tiers use `outcome.normalized[agentSeat]`; efficiency tiers
use `min(1, (par/agentActions)²)` when solved, 0 otherwise), weighted into a
per-game score `G`, averaged over benchmark games into the **benchmark
score**. An entry is **ranked** only when it covers every manifest episode
with no dry-run trajectory — partial or offline runs stay listed but
unranked, with the reason recorded.

`scoring/leaderboard.js` groups entries into `official` (live model runs),
`community` (recorded/bridged agents), and `baseline` (bundled agents)
tracks, ranks ranked entries by benchmark score, and renders both the JSON
leaderboard (`playkit-gauntlet-leaderboard/1`) and a Markdown table, including
a score-vs-cost view when a sourced price file provided costs.

## The CLI

```sh
node cli/gauntlet.js list
# List registered games, tiers, scoring kind, budgets, public-seed counts.

# One episode, any agent spec; --out writes the trajectory JSON.
node cli/gauntlet.js play --game tictactoe --tier perfect-opponent \
  --seed tictactoe/perfect-opponent/public/0 --agent random --out /tmp/t.json
node cli/gauntlet.js verify /tmp/t.json            # replay one trajectory
node cli/gauntlet.js verify /tmp/run-dir/          # or a whole run directory

# Suites: public, or eval (salt from a file; only the commitment is stored).
node cli/gauntlet.js suite build --split public --out suite.public.json
node cli/gauntlet.js suite build --split eval --salt-file /path/to/salt --out suite.eval.json
# Optional filters: --seeds-per-tier 1 (smoke suites), --games chess,2048.

# Run an agent over a manifest; --limit caps episodes per (game, tier).
node cli/gauntlet.js run --suite suite.public.json --agent random \
  --out results/random/ --limit 1

# Verify and rank: JSON + Markdown written to --out (or printed with --json).
node cli/gauntlet.js verify results/random/
node cli/gauntlet.js leaderboard --suite suite.public.json --out lb/ results/random/

# The wire protocol (JSON Lines over stdin/stdout) for out-of-process clients.
node cli/gauntlet.js serve
```

### Agent specs

- `random` — the bundled seeded random agent (baseline track).
- `baseline:<game>:<greedy|engine>` — that game packet's bundled baseline
  (e.g. `baseline:chess:engine` plays the tier's engine-ladder opponent as the
  agent). A suite run with a baseline spec covers that game only.
- `model:<provider>/<model>` — an official-track model agent (`provider` is
  `anthropic` or `openai`). Live runs need the provider key in the
  environment and `--prices <file>` for cost accounting. `--dry-run
  --script <file>` rehearses offline: the script default-exports an array of
  replies or a function of the turn context; trajectories carry
  `dryRun: true`, so the leaderboard flags and unranked them.

Run outputs: one `<game>__<tier>__<i>.json` trajectory per episode plus a
`_run.json` summary; `verify` and `leaderboard` ignore `_*.json` files.

## Python client

`clients/python/playkit_gauntlet` speaks the wire protocol (`reset`, `act`,
`list_games`, `trajectory`); `example_random.py` is a runnable tour. The CLI
integration test plays a full episode through `gauntlet serve` with the
Python client and replay-verifies the resulting trajectory under the JS CLI.

## Browser rule

Game and core code must not import `node:*` — the overlay will later load
games in a browser. The Node-only files are `core/seeds-node.js`,
`scoring/suite.js` (salt commitments via `seeds-node.js`), `protocol/`,
`clients/python/`, and `cli/`.

## Developing

```sh
npm ci
npm test        # node --test: packet suites, scoring, protocol, integration
npm run typecheck
```

Integration tests live in `test/integration/`: registry-wide conformance for
all nine games, a CLI end-to-end run (suite build → random run → verify →
leaderboard rank → dry-run model entry flagged unranked), and the
Python-client-over-serve episode.
