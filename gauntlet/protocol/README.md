# Gauntlet wire protocol

The protocol exposes Gauntlet episodes to external clients — harnesses in any
language — over **JSON Lines on stdin/stdout**. One JSON request per line in,
one JSON response per line out. Episode rules, canonical action parsing,
invalid-attempt handling, budgets, and trajectory recording all stay in the
core runner; a client only carries turns and replies.

## Running

```sh
node gauntlet/protocol/server.js
```

The server reads requests from stdin until it ends or a `close` request
arrives. It writes exactly one response line per request to stdout and keeps
all human-readable logs on stderr, so a transport can wire the streams
straight to the client.

## Requests and responses

### `list` — the game registry

```json
{"id": 1, "op": "list"}
```

```json
{"id": 1, "ok": true, "games": [{"id": "tictactoe", "tiers": [{"id": "perfect-opponent", "maxActions": 20}]}]}
```

The shape mirrors the registry: game ids with their tiers. Tier `maxActions`
is the per-episode action budget.

### `reset` — start one episode

```json
{"id": 2, "op": "reset", "game": "tictactoe", "tier": "perfect-opponent",
 "seed": "tictactoe/perfect-opponent/public/0", "agentId": "my-agent", "track": "community"}
```

- `game` (required): a registry id.
- `tier` (optional): a tier id of that game; defaults to the game's first tier.
- `seed` (optional): an episode seed; defaults to public seed 0 of the tier.
- `split` (optional): `"public"` (default) or `"eval"`.
- `agentId` (optional): the agent's id in the recorded trajectory.
- `track` (optional): `"official"` (default), `"community"`, or `"baseline"`.

One episode per reset. While an episode is in progress, `reset` is an error;
after it finishes, a new `reset` starts the next episode.

The response is the agent's first decision:

```json
{"id": 2, "ok": true, "turn": {"seat": 0, "observation": {"text": "...", "data": {"...": "..."}},
 "legalActions": ["a1", "a2", "b2"], "feedback": null}}
```

The runner waits: the server sends nothing else until the client's next `act`.

### `act` — submit the agent reply

```json
{"id": 3, "op": "act", "text": "b2"}
```

- `text` (required): the agent reply. The runner reads the action from the
  reply's **last non-empty line** — a bare action or a fuller reply both work;
  replay must reproduce the exact text, so keep it stable for evaluation runs.
- `usage` (optional): an agent-supplied cost token (for example
  `{"inputTokens": 11, "outputTokens": 1, "costUsd": 0.0}`) recorded with the
  step in the trajectory.
- `meta` (optional): an agent-supplied extra recorded with the step.

Invalid attempts do **not** error: the response is the next turn with
`feedback` explaining the rejection, and the attempt consumes the budget.
After three invalid attempts the episode ends with `reason: "forfeit-invalid"`.

Every response is either the next agent decision or the finished episode:

```json
{"id": 3, "ok": true, "turn": {"seat": 0, "observation": {"...": "..."}, "legalActions": ["..."], "feedback": "expected a legal action ..."}}
```

```json
{"id": 4, "ok": true, "done": true, "end": {"reason": "terminal", "outcome": {"normalized": [0, 1]},
 "agentActions": 3, "invalidActions": 0}}
```

`end.reason` is one of `"terminal"` (the game ended), `"budget-exhausted"`
(the tier's action budget ran out), or `"forfeit-invalid"` (three invalid
attempts). `end.outcome` carries the tier's explicit outcome shape, including
`normalized` per-seat scores in `[0, 1]`.

### `trajectory` — the recorded episode

```json
{"id": 5, "op": "trajectory"}
```

```json
{"id": 5, "ok": true, "trajectory": {"format": "playkit-gauntlet-trajectory/1", "game": {"id": "tictactoe"},
 "seed": "...", "agent": {"id": "my-agent", "seat": 0, "track": "community"}, "steps": [], "end": {"...": "..."}}}
```

Available once the episode is done. The trajectory is the core's canonical
recording — it replays cleanly through `verifyTrajectory`, and the CLI can
verify it outside this process:

```sh
node gauntlet/cli/gauntlet.js verify <trajectory.json>
```

### `close` — end the session

```json
{"id": 6, "op": "close"}
```

```json
{"id": 6, "ok": true}
```

The server exits — even if the client keeps its stdin pipe open. An episode
still in progress is abandoned.

## Tracks

The `track` on `reset` only affects what the client sees; episode rules,
opponents, seeds, and scoring are identical.

- **official** — `turn.legalActions` is `null` (hidden). Official-track agents
  see exactly what a graded entry sees: the observation text (which lists the
  legal actions when there are 64 or fewer) and the structured `observation.data`.
- **community** — `turn.legalActions` lists the legal actions. Community and
  baseline entries may use the list directly.
- **baseline** — like community; for reference-agent runs.

## Error responses

Any rejected request gets one response with `ok: false` and a human-readable
`error` message, and the session continues:

```json
{"id": 7, "ok": false, "error": "unknown game: \"not-a-game\""}
```

Malformed lines (not valid JSON) and non-object lines also get one
`{"ok": false, "error": "..."}` response each — the id is echoed when known.
Unrecognized `op` values are rejected the same way.

## Python client

`gauntlet/clients/python` ships `playkit_gauntlet`, a standard-library-only
Python 3.10+ client that runs the server as a subprocess. See
[that directory's README](../clients/python/README.md) for usage; the Node
test suite (`gauntlet/protocol/server.test.js`) exercises the same protocol
over real pipes, and the Python tests drive the real server end to end.
