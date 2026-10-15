"""Play a full tic-tac-toe episode with uniformly random moves.

A minimal end-to-end example of the Python client: list the registry, play
one seeded episode against the built-in opponent through the wire protocol,
and print the finished episode's end. Deterministic for a given seed (the
agent's RNG is seeded from the episode seed; the game's own randomness comes
from the core RNG).

Run from ``gauntlet/clients/python``:

    python3 -m playkit_gauntlet.example_random
    python3 -m playkit_gauntlet.example_random --seed tictactoe/perfect-opponent/public/3
"""

from __future__ import annotations

import argparse
import random
import re
from typing import Optional

from .client import GauntletClient, GauntletError

# The observation lists the legal actions whenever there are 64 or fewer.
_LEGAL_LINE = re.compile(r"Legal actions \(\d+[^)]*\): (.+)$")


def legal_actions_from_text(observation_text: str) -> list[str]:
    """Parse the legal actions from an official-track observation.

    Official-track agents get only the observation text — this is exactly the
    derivation they must do.
    """
    match = _LEGAL_LINE.search(observation_text)
    if not match:
        raise GauntletError(
            "observation text does not list legal actions; official-track "
            "agents must derive them from the rules text"
        )
    return [action.strip() for action in match.group(1).split(",")]


def play_episode(client: GauntletClient, seed: str, track: str) -> dict:
    """Play one full episode and return the trajectory."""
    response = client.reset(
        game="tictactoe",
        tier="perfect-opponent",
        seed=seed,
        agent_id="python-random",
        track=track,
    )
    rng = random.Random(seed)
    ply = 0
    while "turn" in response:
        turn = response["turn"]
        legal = turn["legalActions"]
        if legal is None:  # official track hides the list
            legal = legal_actions_from_text(turn["observation"]["text"])
        move = rng.choice(legal)
        print(f"ply {ply}: agent plays {move!r}")
        response = client.act(move)
        ply += 1
    end = response["end"]
    print(
        f"episode over: {end['reason']} after {end['agentActions']} agent actions "
        f"({end['invalidActions']} invalid); normalized={end['outcome']['normalized']}"
    )
    trajectory = client.trajectory()
    print(f"trajectory recorded: {len(trajectory['steps'])} steps, format {trajectory['format']}")
    return trajectory


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", default="tictactoe/perfect-opponent/public/0")
    parser.add_argument(
        "--track",
        choices=["official", "community", "baseline"],
        default="community",
        help="official turns hide legalActions (the agent parses the observation text)",
    )
    args = parser.parse_args(argv)
    with GauntletClient() as client:
        games = client.list_games()
        print(f"registered games: {', '.join(game['id'] for game in games)}")
        play_episode(client, seed=args.seed, track=args.track)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
