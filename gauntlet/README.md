# PlayKit Gauntlet — core

Gauntlet is PlayKit's benchmark of difficult, popular games for frontier AI
agents: chess against an engine ladder, Minesweeper, 2048, Sokoban, and more.
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
| `games/`            | Explicit registry (`games/index.js`) plus the registered games.   |
| `cli/gauntlet.js`   | `list`, `play`, `verify` (in `cli/` because root ignores `bin/`). |

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

## Browser rule

Game and core code must not import `node:*` — the overlay will later load
games in a browser. The only Node-only files are `core/seeds-node.js` and
`cli/gauntlet.js`.

## CLI

```sh
node cli/gauntlet.js list
node cli/gauntlet.js play --game tictactoe --tier perfect-opponent \
  --seed tictactoe/perfect-opponent/public/0 --agent random --out /tmp/t.json
node cli/gauntlet.js verify /tmp/t.json
```

## Developing

```sh
npm ci
npm test        # node --test over colocated *.test.js files
npm run typecheck
```
