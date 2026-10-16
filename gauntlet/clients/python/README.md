# playkit-gauntlet (Python client)

Standard-library-only Python 3.10+ client for the [Gauntlet wire
protocol](../../protocol/README.md). It starts the Node protocol server
(`gauntlet/protocol/server.js`) as a subprocess and speaks JSON Lines over its
stdin/stdout, so a Python harness plays every registered game while episode
rules, budgets, and trajectory recording stay in the core runner. Requires
Node 20+ on the PATH (`node_executable` overrides).

## Install

Nothing to install to use it from this repository:

```sh
cd gauntlet/clients/python   # on sys.path, the package imports directly
```

For other projects, `pip install .` from this directory (metadata in
`pyproject.toml`), or copy the `playkit_gauntlet` package.

## Usage

```python
from playkit_gauntlet import GauntletClient, GauntletError

with GauntletClient() as client:
    print(client.list_games())

    response = client.reset(
        game="tictactoe",
        tier="perfect-opponent",
        seed="tictactoe/perfect-opponent/public/0",
        agent_id="my-agent",
        track="community",
    )
    while "turn" in response:
        move = choose(response["turn"]["legalActions"])  # your agent
        response = client.act(move)

    print(response["end"])       # reason, outcome, action counts
    print(client.trajectory())   # replayable trajectory, format playkit-gauntlet-trajectory/1
```

One client owns one server process and one episode at a time. After `reset`
and after every `act`, the response carries either the next turn
(`{"turn": {"seat", "observation", "legalActions", "feedback"}}`) or the
finished episode (`{"done": true, "end": {...}}`). Invalid attempts come back
as the next turn's `feedback` and consume the budget — three forfeit the
episode. `track="official"` (the default) hides `legalActions`, matching
graded runs; the bundled
[`example_random`](playkit_gauntlet/example_random.py) shows the
official-track pattern of parsing the legal actions out of the observation
text:

```sh
python3 -m playkit_gauntlet.example_random --track official
```

`GauntletError` covers every `ok: false` response (message in `str(e)`, full
payload in `e.response`) and transport failures. `close()` (or the context
manager) ends the server process.

## Inspect AI adapter

`playkit_gauntlet.inspect_task` exposes Gauntlet as an
[Inspect AI](https://inspect.aisi.org.uk/) task: any Inspect model — a hosted
provider or a local server — plays seeded Gauntlet episodes turn by turn
through the wire protocol, while episode rules, refereeing, and trajectory
recording stay in the core runner. Episodes run on the official track (the
one fixed system prompt and turn message from `gauntlet/harness/official.js`,
rebuilt in Python and tested byte-identical against the Node output), and
every finished trajectory is written to a run directory that the Gauntlet CLI
can replay-verify.

Install Inspect (optional extra; the client itself keeps zero dependencies):

```sh
cd gauntlet/clients/python
python3 -m venv .venv && source .venv/bin/activate
pip install inspect-ai          # or: pip install ".[inspect]"
```

Run an eval (from `gauntlet/clients/python`, Node 20+ on the PATH):

```sh
inspect eval playkit_gauntlet/inspect_task.py \
    -T game=connect4 -T tier=ladder-1 -T seeds=2 --model mockllm/mockllm
```

`--model` takes any Inspect model string in `<api_name>/<model_name>` form
(`openai/gpt-4o`, `anthropic/claude-...`, a local server, `mockllm/mockllm`
for a no-network smoke) — provider keys go through the usual environment
variables. Task parameters (`-T`):

- `game` (default `tictactoe`) — registry id; the dataset is that game's
  episodes from a suite manifest built by `cli/gauntlet.js suite build`
  (public split).
- `tier` (default: all tiers of the game) — tier id, e.g. `ladder-1`.
- `seeds` (default: all public seeds) — cap the seed count per tier.
- `run_dir` (default `gauntlet-runs/<UTC timestamp>`) — directory where each
  episode's trajectory is written, `<game>__<tier>__<seed>.json`.
- `gauntlet_dir` (default: the `gauntlet/` tree this package lives in) —
  where the CLI, protocol server, and registry are found.

The scorer reports the episode's normalized score for the agent's seat, with
the trajectory path, end reason, and action counts in its metadata.
Replay-verify a run directory with the CLI:

```sh
node ../../cli/gauntlet.js verify gauntlet-runs/<run-dir>
```

Usage honesty: each turn's token counts come from Inspect's usage and are
recorded on the trajectory steps; `costUsd` is recorded only when Inspect's
model reports a price, and stays `null` otherwise (unknown stays unknown).

Testing without network: `--model mockllm` needs no keys. Unscripted mockllm
replies are rarely legal actions, so those episodes end `forfeit-invalid`
after three invalid attempts — the full solver → server → runner → trajectory
→ scorer path still runs end to end. The tests script mockllm through its
`custom_outputs` hook to play legal moves; see `tests/test_inspect_task.py`.

### Reads: blocking by default, optional watchdog

By default a read blocks until the server answers — the bundled server is a
deterministic local process, so that is the right default for episode runs.
Pass `request_timeout=<seconds>` to bound each read: a response that never
arrives raises `GauntletError` instead of hanging forever, terminates the
server, and leaves the client unusable (after a timed-out read the response
stream can no longer be trusted, so start a new client):

```python
client = GauntletClient(request_timeout=30.0)  # one episode step must answer within 30 s
```

## Tests

End-to-end: every test drives the real Node server over real pipes through
full episodes (no network, no paid APIs, no stubs). The byte-identity tests
also run `harness/official.js` through Node; the Inspect tests run only when
`inspect_ai` is installed.

```sh
cd gauntlet/clients/python && python3 -m unittest
```
