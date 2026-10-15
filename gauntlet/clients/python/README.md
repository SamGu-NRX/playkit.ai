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

## Tests

End-to-end: every test drives the real Node server over real pipes through
full episodes (no network, no paid APIs, no stubs).

```sh
cd gauntlet/clients/python && python3 -m unittest
```
