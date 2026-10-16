#!/usr/bin/env python3
"""Play one tic-tac-toe episode through `gauntlet serve` with the Python client.

Drives the real CLI serve subcommand: a wrapper script execs
``node <gauntlet>/cli/gauntlet.js serve``, and the playkit_gauntlet client
speaks the JSON-Lines protocol to it over stdin/stdout. Writes the recorded
trajectory to the path given as argv[1] so the JS side can replay-verify it.

Usage: python3 python_serve_episode.py <trajectory-out.json> <gauntlet-dir> <wrapper.sh>
"""

from __future__ import annotations

import json
import random
import sys

sys.path.insert(0, sys.argv[2] + "/clients/python")
from playkit_gauntlet.client import GauntletClient  # noqa: E402

TRAJECTORY_OUT = sys.argv[1]
WRAPPER = sys.argv[3]


def main() -> int:
    with GauntletClient(server_path=sys.argv[2] + "/cli/gauntlet.js",
                         node_executable=WRAPPER) as client:
        games = client.list_games()
        assert any(g["id"] == "tictactoe" for g in games), "tictactoe must be registered"

        response = client.reset(
            game="tictactoe",
            tier="perfect-opponent",
            seed="tictactoe/perfect-opponent/public/1",
            agent_id="python-e2e",
            track="community",
        )
        rng = random.Random("gauntlet-serve-e2e")
        plies = 0
        while "turn" in response:
            legal = response["turn"]["legalActions"]
            assert legal, "community-track turns list legal actions"
            move = rng.choice(legal)
            response = client.act(move)
            plies += 1

        end = response["end"]
        print(f"episode over: {end['reason']} after {end['agentActions']} agent actions "
              f"({end['invalidActions']} invalid); normalized={end['outcome']['normalized']}")
        trajectory = client.trajectory()
        with open(TRAJECTORY_OUT, "w", encoding="utf-8") as handle:
            json.dump(trajectory, handle, indent=2)
            handle.write("\n")
        print(f"trajectory recorded: {len(trajectory['steps'])} steps, format {trajectory['format']}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
